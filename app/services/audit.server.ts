// A minimal structural type for the subset of Shopify's admin GraphQL
// client this file actually calls. Using this instead of pulling the full
// type off `authenticate.admin` (which was the original approach) means:
//   1. This file has zero import-time dependency on shopify.server.ts, so
//      it can be unit-tested with a plain fake object — no Shopify app
//      instance, no OAuth, no network — see audit.server.test.ts.
//   2. The real admin client Shopify hands routes still satisfies this
//      type automatically (TypeScript is structural), so nothing else
//      changes.
export interface AdminGraphQLClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}
type AdminContext = AdminGraphQLClient;

/**
 * LeakAudit — Core Audit Engine
 * ---------------------------------------------------------------
 * Runs 4 independent, read-only audits against the Shopify Admin
 * GraphQL API and returns a single normalized report. Every audit
 * is designed to fail SOFT: if the data needed to compute a number
 * isn't available yet (empty dev store, missing cost-per-item,
 * etc.) it returns a `status: "insufficient_data"` leak with a
 * human prompt instead of throwing (Step 5 requirement).
 *
 * IMPORTANT: every dollar figure here is in the SHOP'S OWN currency,
 * not USD. We fetch shop.currencyCode once and carry it on the report
 * so the UI can format correctly (₪, €, $, ...) instead of assuming $.
 * There is no FX-to-USD conversion happening anywhere in this file.
 */

export type LeakStatus = "ok" | "leaking" | "insufficient_data" | "error";

export interface LeakResult {
  id: "fx_fees" | "app_bloat" | "negative_margin" | "return_drift";
  title: string;
  status: LeakStatus;
  monthlyImpact: number; // in the shop's currency — see AuditReport.currencyCode. 0 when status !== "leaking"
  headline: string; // 1-sentence plain explanation
  actionLabel: string; // CTA button text
  actionHref: string; // where the CTA button should route to
  details?: Record<string, unknown>;
}

export interface AuditReport {
  scannedAt: string;
  shopDomain: string;
  currencyCode: string; // e.g. "USD", "ILS", "EUR" — format all amounts with THIS, not "$"
  totalMonthlyLeak: number;
  healthScore: number; // 0-100. 100 = nothing leaking. See computeHealthScore() below.
  leaks: LeakResult[];
}

export interface AuditSettings {
  shippingCostPerOrder: number; // shop currency, not USD — configurable in Settings
  targetMarginPercent: number; // a SKU below this net-margin % counts as "leaking"
}

export const DEFAULT_AUDIT_SETTINGS: AuditSettings = {
  shippingCostPerOrder: 5.0,
  targetMarginPercent: 20,
};

// ---- Assumptions still hardcoded (not yet exposed as settings) ----
const FX_MARKUP_ESTIMATE = 0.018; // 1.8% assumed drag on cross-border presentment-currency orders (dimensionless, currency-agnostic)
const RETURN_RATE_BENCHMARK = 0.08; // 8% treated as "normal" for general e-commerce
const LOOKBACK_DAYS = 60;

// Shopify's native bulk editor, filtered to just price + cost-per-item so
// a merchant can fix every underpriced/uncosted variant on one
// spreadsheet-like screen instead of opening products one at a time.
// NOTE: the originally-requested URL also included
// "metafields.pricing.cost" — that's not a real Shopify field (cost is
// InventoryItem.unitCost, not a custom metafield most stores have), so it
// was dropped here; adding it back would either be silently ignored or
// error depending on Shopify's version. This is also routed through
// adminUrl() in the dashboard, which already prepends
// "https://admin.shopify.com/store/<handle>", so no extra "/admin" prefix
// is needed here.
const BULK_EDIT_VARIANT_COSTS_PATH =
  "/bulk?resource_name=ProductVariant&edit=price,inventory_item.cost";

// Health score: start at 100, deduct per problem found. "insufficient_data"
// doesn't count against you — it just means the check hasn't got enough
// data yet, not that something's wrong.
const HEALTH_PENALTY_LEAKING = 15;
const HEALTH_PENALTY_ERROR = 5;

export function computeHealthScore(leaks: LeakResult[]): number {
  let score = 100;
  for (const leak of leaks) {
    if (leak.status === "leaking") score -= HEALTH_PENALTY_LEAKING;
    if (leak.status === "error") score -= HEALTH_PENALTY_ERROR;
  }
  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------
// GraphQL throttle-safe wrapper
// ---------------------------------------------------------------
// Shopify's Admin GraphQL API is cost-based: once a shop's bucket of
// query "points" is drained (heavy admin usage, other apps running bulk
// jobs, etc.) a request comes back as a 200 OK carrying a GraphQL-level
// error whose extensions.code is "THROTTLED" instead of data. Left
// unhandled, every audit that happens to hit this becomes a hard "error"
// leak even though the right response is just "wait a beat and ask
// again." This wraps a single admin.graphql call with a small number of
// retries and exponential backoff so a momentarily-busy shop doesn't
// produce a false "something's broken" result. Any other GraphQL-level
// error (bad query, missing scope, etc.) is returned as-is on the first
// attempt — retrying those would just fail the same way every time.
const THROTTLE_MAX_RETRIES = 4;
const THROTTLE_BASE_DELAY_MS = 1000; // backoff: 1s, 2s, 4s, 8s

interface GraphqlErrorEntry {
  message?: string;
  extensions?: { code?: string };
}
interface GraphqlEnvelope {
  errors?: GraphqlErrorEntry[];
}

function isThrottled(body: GraphqlEnvelope): boolean {
  return (body.errors ?? []).some((e) => e.extensions?.code === "THROTTLED");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs a single admin.graphql call and returns the parsed JSON body,
// automatically retrying with exponential backoff when Shopify reports
// THROTTLED (extensions.code === "THROTTLED" on a GraphQL error entry).
async function graphqlWithRetry<T>(
  admin: AdminGraphQLClient,
  query: string,
  options?: { variables?: Record<string, unknown> },
  maxRetries: number = THROTTLE_MAX_RETRIES,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    const response = await admin.graphql(query, options);
    const body = (await response.json()) as T & GraphqlEnvelope;
    if (isThrottled(body) && attempt < maxRetries) {
      const delay = THROTTLE_BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `[LeakAudit] GraphQL throttled — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await sleep(delay);
      attempt += 1;
      continue;
    }
    return body;
  }
}

interface ShopCurrencyResponse {
  shop: { currencyCode: string };
}

const SHOP_CURRENCY_QUERY = `#graphql
  query ShopCurrency {
    shop { currencyCode }
  }
`;

export async function runAudit(
  admin: AdminContext,
  shopDomain: string,
  settings: AuditSettings = DEFAULT_AUDIT_SETTINGS,
): Promise<AuditReport> {
  const shopResponse = await admin.graphql(SHOP_CURRENCY_QUERY);
  const shopData = (await shopResponse.json()) as {
    data: ShopCurrencyResponse;
  };
  const currencyCode: string = shopData.data?.shop?.currencyCode ?? "USD";

  const [fx, bloat, margin, returns] = await Promise.all([
    auditPaymentFxLeak(admin, currencyCode).catch((e: unknown) =>
      errorLeak("fx_fees", "Payment & FX Fee Drag", e),
    ),
    auditAppBloatLeak(admin).catch((e: unknown) =>
      errorLeak("app_bloat", "Leftover App Script Bloat", e),
    ),
    auditNegativeMarginSkus(admin, settings).catch((e: unknown) =>
      errorLeak("negative_margin", "Negative-Margin SKUs", e),
    ),
    auditReturnRateDrift(admin).catch((e: unknown) =>
      errorLeak("return_drift", "Return Rate Drift", e),
    ),
  ]);

  const leaks = [fx, bloat, margin, returns];
  const totalMonthlyLeak = leaks.reduce(
    (sum, l) => sum + (l.status === "leaking" ? l.monthlyImpact : 0),
    0,
  );

  return {
    scannedAt: new Date().toISOString(),
    shopDomain,
    currencyCode,
    totalMonthlyLeak: Math.round(totalMonthlyLeak),
    healthScore: computeHealthScore(leaks),
    leaks,
  };
}

export function errorLeak(
  id: LeakResult["id"],
  title: string,
  err: unknown,
): LeakResult {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[LeakAudit] ${id} failed:`, message);
  return {
    id,
    title,
    status: "error",
    monthlyImpact: 0,
    headline:
      "This check couldn't complete — likely a missing scope or a temporary API error.",
    actionLabel: "Retry",
    actionHref: "#",
    // Surfaced in the UI so we don't have to dig through the terminal every
    // time while iterating. Remove before this reaches real merchants.
    details: { errorMessage: message },
  };
}

// ---------------------------------------------------------------
// 1. Payment gateway & FX fee markup
// ---------------------------------------------------------------
interface FxOrderNode {
  id: string;
  createdAt: string;
  presentmentCurrencyCode: string;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
}
interface FxOrdersResponse {
  orders: { edges: { node: FxOrderNode }[] };
}

const FX_QUERY = `#graphql
  query FxLeakOrders($first: Int!, $query: String) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          createdAt
          presentmentCurrencyCode
          currentTotalPriceSet {
            shopMoney { amount currencyCode }
          }
        }
      }
    }
  }
`;

export async function auditPaymentFxLeak(
  admin: AdminContext,
  shopCurrency: string,
): Promise<LeakResult> {
  const since = daysAgoIso(30);
  const data = await graphqlWithRetry<{ data: FxOrdersResponse }>(admin, FX_QUERY, {
    variables: { first: 250, query: `created_at:>=${since}` },
  });
  const orders = data.data?.orders?.edges ?? [];

  if (orders.length === 0) {
    return insufficientData(
      "fx_fees",
      "Payment & FX Fee Drag",
      "No orders in the last 30 days yet — place a test order to see this check run.",
      { label: "View Orders", href: "/orders" },
    );
  }

  let crossBorderRevenue = 0;
  let totalRevenue = 0;

  for (const { node } of orders) {
    const amount = parseFloat(
      node.currentTotalPriceSet?.shopMoney?.amount ?? "0",
    );
    totalRevenue += amount;
    if (
      node.presentmentCurrencyCode &&
      node.presentmentCurrencyCode !== shopCurrency
    ) {
      crossBorderRevenue += amount;
    }
  }

  const monthlyImpact = crossBorderRevenue * FX_MARKUP_ESTIMATE;
  const crossBorderShare =
    totalRevenue > 0 ? crossBorderRevenue / totalRevenue : 0;

  return {
    id: "fx_fees",
    title: "Payment & FX Fee Drag",
    status: monthlyImpact > 1 ? "leaking" : "ok",
    monthlyImpact: round2(monthlyImpact),
    headline:
      crossBorderShare > 0
        ? `${Math.round(crossBorderShare * 100)}% of your last 30 days of revenue was in a foreign presentment currency, estimated at a ${(FX_MARKUP_ESTIMATE * 100).toFixed(1)}% conversion drag.`
        : "No meaningful cross-border currency exposure detected in the last 30 days.",
    actionLabel: "Review FX Routing",
    actionHref: "/settings/payments",
    details: {
      crossBorderRevenue: round2(crossBorderRevenue),
      totalRevenue: round2(totalRevenue),
      shopCurrency,
    },
  };
}

// ---------------------------------------------------------------
// 2. Abandoned / leftover app script bloat
// ---------------------------------------------------------------
interface ThemeFileNode {
  filename: string;
  body: { content?: string };
}
interface ThemeNode {
  id: string;
  name: string;
  files: { nodes: ThemeFileNode[] };
}
interface ThemesResponse {
  themes: { nodes: ThemeNode[] };
}

const THEME_QUERY = `#graphql
  query ActiveThemeAsset {
    themes(first: 5, roles: [MAIN]) {
      nodes {
        id
        name
        files(filenames: ["layout/theme.liquid"]) {
          nodes {
            filename
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }
`;

// Signatures of scripts/snippets commonly left behind by apps merchants
// have since UNINSTALLED. Extend this list as you learn your ICP's stack.
const KNOWN_ORPHAN_SIGNATURES: { pattern: RegExp; label: string }[] = [
  { pattern: /judge\.?me/i, label: "Judge.me (reviews)" },
  { pattern: /loox\.io|loox-reviews/i, label: "Loox (reviews)" },
  { pattern: /klaviyo/i, label: "Klaviyo snippet" },
  { pattern: /privy/i, label: "Privy popups" },
  { pattern: /aftership/i, label: "AfterShip tracking" },
  { pattern: /wheelio/i, label: "Wheelio spin-to-win" },
  { pattern: /rebuy/i, label: "Rebuy upsell" },
];

export async function auditAppBloatLeak(admin: AdminContext): Promise<LeakResult> {
  const data = await graphqlWithRetry<{ data: ThemesResponse }>(admin, THEME_QUERY);
  const theme = data.data?.themes?.nodes?.[0];
  const body = theme?.files?.nodes?.[0]?.body?.content;

  if (!body) {
    return insufficientData(
      "app_bloat",
      "Leftover App Script Bloat",
      "Couldn't read theme.liquid — check that the store has an active published theme to scan.",
      { label: "View Themes", href: "/themes" },
    );
  }

  const found = KNOWN_ORPHAN_SIGNATURES.filter((sig) => sig.pattern.test(body));
  // Heuristic cost: flat placeholder per orphaned script until real traffic
  // + conversion data is wired in (see Section 5 stickiness notes).
  const estimatedMonthlyImpact = found.length * 45;

  return {
    id: "app_bloat",
    title: "Leftover App Script Bloat",
    status: found.length > 0 ? "leaking" : "ok",
    monthlyImpact: found.length > 0 ? estimatedMonthlyImpact : 0,
    headline:
      found.length > 0
        ? `Found ${found.length} leftover script${found.length > 1 ? "s" : ""} from apps you may no longer use: ${found.map((f) => f.label).join(", ")}.`
        : "No known orphaned app scripts detected in your live theme.",
    actionLabel: "Clean Leftover Scripts",
    actionHref: "/themes/current/editor",
    details: { matches: found.map((f) => f.label), themeName: theme?.name },
  };
}

// ---------------------------------------------------------------
// 3. Negative-margin SKUs (post-shipping, vs. a configurable target margin)
// ---------------------------------------------------------------
interface VariantNode {
  id: string;
  title: string;
  price: string;
  product?: { id?: string; title?: string };
  inventoryItem?: { unitCost?: { amount?: string } };
}
interface VariantsResponse {
  productVariants: {
    edges: { node: VariantNode }[];
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
}

const VARIANTS_QUERY = `#graphql
  query MarginVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after, query: "inventory_quantity:>0") {
      edges {
        node {
          id
          title
          price
          product { id title }
          inventoryItem {
            unitCost { amount }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// A store can easily have more than 250 in-stock variants; without paging
// through the full set this check would silently only ever look at the
// first page and under-report (or completely miss) negative-margin SKUs
// on larger catalogs. 8 pages * 250 = up to 2,000 variants scanned per
// audit run — a deliberate ceiling so one huge catalog can't turn a
// single audit into an unbounded chain of GraphQL calls.
const VARIANTS_PAGE_SIZE = 250;
const VARIANTS_PAGE_CAP = 8;

interface MarginOffender {
  title: string;
  price: number;
  cost: number;
  netMargin: number;
  marginPercent: number;
  // Relative admin path to this exact product's edit page, so the
  // dashboard can link straight to the offending SKU instead of just the
  // generic Products list. Null if we couldn't extract a usable id.
  actionHref: string | null;
}

export async function auditNegativeMarginSkus(
  admin: AdminContext,
  settings: AuditSettings,
): Promise<LeakResult> {
  const variants: { node: VariantNode }[] = [];
  let after: string | null = null;
  let pagesFetched = 0;

  do {
    const data: { data: VariantsResponse } = await graphqlWithRetry(
      admin,
      VARIANTS_QUERY,
      { variables: { first: VARIANTS_PAGE_SIZE, after } },
    );
    const page: VariantsResponse["productVariants"] | undefined = data.data?.productVariants;
    variants.push(...(page?.edges ?? []));
    pagesFetched += 1;
    after = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
  } while (after && pagesFetched < VARIANTS_PAGE_CAP);

  if (variants.length === 0) {
    return insufficientData(
      "negative_margin",
      "Negative-Margin SKUs",
      "No in-stock variants found yet — add products with inventory to run this check.",
      { label: "View Products", href: "/products" },
    );
  }

  const withCost = variants.filter(
    (e) => e.node.inventoryItem?.unitCost?.amount != null,
  );
  if (withCost.length === 0) {
    return insufficientData(
      "negative_margin",
      "Negative-Margin SKUs",
      `Set cost-per-item on your top SKUs to unlock margin tracking (0 of ${variants.length} variants have a cost set).`,
      { label: "Set Cost Per Item", href: BULK_EDIT_VARIANT_COSTS_PATH },
    );
  }

  const offenders: MarginOffender[] = withCost
    .map((e): MarginOffender => {
      const price = parseFloat(e.node.price ?? "0");
      const cost = parseFloat(e.node.inventoryItem?.unitCost?.amount ?? "0");
      const netMargin = price - cost - settings.shippingCostPerOrder;
      const marginPercent = price > 0 ? (netMargin / price) * 100 : 0;
      const productId = numericId(e.node.product?.id);
      return {
        title: `${e.node.product?.title ?? ""} — ${e.node.title}`,
        price,
        cost,
        netMargin,
        marginPercent,
        actionHref: productId ? `/products/${productId}` : null,
      };
    })
    .filter((v) => v.marginPercent < settings.targetMarginPercent)
    .sort((a, b) => a.marginPercent - b.marginPercent);

  // Placeholder velocity assumption (~3 units/mo per offending SKU) until
  // real order-line history is wired in — flag clearly to the user as such.
  const monthlyImpact = offenders.reduce(
    (sum, v) => sum + Math.max(0, -v.netMargin) * 3,
    0,
  );

  return {
    id: "negative_margin",
    title: "Negative-Margin SKUs",
    status: offenders.length > 0 ? "leaking" : "ok",
    monthlyImpact: round2(monthlyImpact),
    headline:
      offenders.length > 0
        ? `${offenders.length} SKU${offenders.length > 1 ? "s are" : " is"} selling below your ${settings.targetMarginPercent}% target margin after estimated shipping cost.`
        : `All SKUs are meeting your ${settings.targetMarginPercent}% target margin after estimated shipping.`,
    actionLabel: "Set Cost Per Item",
    actionHref: BULK_EDIT_VARIANT_COSTS_PATH,
    details: {
      skusChecked: withCost.length,
      skusMissingCost: variants.length - withCost.length,
      worstOffenders: offenders.slice(0, 5),
    },
  };
}

// ---------------------------------------------------------------
// 4. Return rate drift
// ---------------------------------------------------------------
interface RefundNode {
  totalRefundedSet: { shopMoney: { amount: string } };
}
interface ReturnOrderNode {
  id: string;
  currentTotalPriceSet: { shopMoney: { amount: string } };
  refunds?: RefundNode[];
}
interface ReturnOrdersResponse {
  orders: { edges: { node: ReturnOrderNode }[] };
}

const REFUNDS_QUERY = `#graphql
  query RefundLeakOrders($first: Int!, $query: String) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          currentTotalPriceSet { shopMoney { amount } }
          refunds {
            totalRefundedSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

export async function auditReturnRateDrift(admin: AdminContext): Promise<LeakResult> {
  const since = daysAgoIso(LOOKBACK_DAYS);
  const data = await graphqlWithRetry<{ data: ReturnOrdersResponse }>(admin, REFUNDS_QUERY, {
    variables: { first: 250, query: `created_at:>=${since}` },
  });
  const orders = data.data?.orders?.edges ?? [];

  if (orders.length < 5) {
    return insufficientData(
      "return_drift",
      "Return Rate Drift",
      `Only ${orders.length} order(s) in the last ${LOOKBACK_DAYS} days — need more order volume for a reliable return rate.`,
      { label: "View Orders", href: "/orders" },
    );
  }

  let totalRevenue = 0;
  let totalRefunded = 0;
  let refundedOrderCount = 0;
  // A few specific refunded orders, so the dashboard can link straight to
  // them instead of only the generic Orders list.
  const refundedOrders: { id: string; actionHref: string }[] = [];

  for (const { node } of orders) {
    const orderTotal = parseFloat(
      node.currentTotalPriceSet?.shopMoney?.amount ?? "0",
    );
    totalRevenue += orderTotal;
    const refundedForOrder = (node.refunds ?? []).reduce(
      (sum, r) =>
        sum + parseFloat(r.totalRefundedSet?.shopMoney?.amount ?? "0"),
      0,
    );
    if (refundedForOrder > 0) {
      refundedOrderCount += 1;
      const orderId = numericId(node.id);
      if (orderId && refundedOrders.length < 5) {
        refundedOrders.push({ id: orderId, actionHref: `/orders/${orderId}` });
      }
    }
    totalRefunded += refundedForOrder;
  }

  const returnRate = orders.length > 0 ? refundedOrderCount / orders.length : 0;
  const drift = returnRate - RETURN_RATE_BENCHMARK;
  const monthlyImpact = drift > 0 ? totalRefunded * (30 / LOOKBACK_DAYS) : 0;

  return {
    id: "return_drift",
    title: "Return Rate Drift",
    status: drift > 0.01 ? "leaking" : "ok",
    monthlyImpact: round2(monthlyImpact),
    headline:
      drift > 0.01
        ? `Your return rate is ${(returnRate * 100).toFixed(1)}%, ${(drift * 100).toFixed(1)}pp above the ${(RETURN_RATE_BENCHMARK * 100).toFixed(0)}% benchmark.`
        : `Return rate is ${(returnRate * 100).toFixed(1)}%, within the normal range.`,
    actionLabel: "Investigate Return Drivers",
    actionHref: "/orders",
    details: {
      returnRate: round2(returnRate * 100),
      totalRefunded: round2(totalRefunded),
      totalRevenue: round2(totalRevenue),
      ordersAnalyzed: orders.length,
      refundedOrders,
    },
  };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
export function insufficientData(
  id: LeakResult["id"],
  title: string,
  message: string,
  // Sends "Learn More" somewhere actually useful instead of a dead "#" —
  // wherever a merchant would go to unblock this specific check.
  action?: { label: string; href: string },
): LeakResult {
  return {
    id,
    title,
    status: "insufficient_data",
    monthlyImpact: 0,
    headline: message,
    actionLabel: action?.label ?? "Learn More",
    actionHref: action?.href ?? "#",
  };
}

export function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Shopify GraphQL ids look like "gid://shopify/Product/123456789" — Admin
// URLs (e.g. /products/123456789) just want the trailing numeric id.
export function numericId(gid: string | undefined): string | null {
  if (!gid) return null;
  const match = gid.match(/(\d+)$/);
  return match ? match[1] : null;
}
