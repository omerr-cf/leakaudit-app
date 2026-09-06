import type { authenticate } from "../shopify.server";

// Derives the admin GraphQL client's type directly from your generated
// shopify.server.ts, so this always matches whatever Shopify API version
// your app is actually running — no guessing package/type names.
type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

/**
 * LeakAudit — Core Audit Engine
 * ---------------------------------------------------------------
 * Runs 4 independent, read-only audits against the Shopify Admin
 * GraphQL API and returns a single normalized report. Every audit
 * is designed to fail SOFT: if the data needed to compute a number
 * isn't available yet (empty dev store, missing cost-per-item,
 * etc.) it returns a `status: "insufficient_data"` leak with a
 * human prompt instead of throwing (Step 5 requirement).
 */

export type LeakStatus = "ok" | "leaking" | "insufficient_data" | "error";

export interface LeakResult {
  id: "fx_fees" | "app_bloat" | "negative_margin" | "return_drift";
  title: string;
  status: LeakStatus;
  monthlyImpactUsd: number; // 0 when status !== "leaking"
  headline: string;         // 1-sentence plain explanation
  actionLabel: string;      // CTA button text
  actionHref: string;       // where the CTA button should route to
  details?: Record<string, unknown>;
}

export interface AuditReport {
  scannedAt: string;
  shopDomain: string;
  totalMonthlyLeakUsd: number;
  leaks: LeakResult[];
}

// ---- Tunable assumptions (documented, not hidden magic numbers) ----
const FX_MARKUP_ESTIMATE = 0.018; // 1.8% assumed drag on cross-border presentment-currency orders
const SHIPPING_BASELINE_PER_ORDER = 6.5; // USD, used when no real shipping cost data exists
const RETURN_RATE_BENCHMARK = 0.08; // 8% treated as "normal" for general e-commerce
const LOOKBACK_DAYS = 60;

export async function runAudit(admin: AdminContext, shopDomain: string): Promise<AuditReport> {
  const [fx, bloat, margin, returns] = await Promise.all([
    auditPaymentFxLeak(admin).catch((e) => errorLeak("fx_fees", "Payment & FX Fee Drag", e)),
    auditAppBloatLeak(admin).catch((e) => errorLeak("app_bloat", "Leftover App Script Bloat", e)),
    auditNegativeMarginSkus(admin).catch((e) => errorLeak("negative_margin", "Negative-Margin SKUs", e)),
    auditReturnRateDrift(admin).catch((e) => errorLeak("return_drift", "Return Rate Drift", e)),
  ]);

  const leaks = [fx, bloat, margin, returns];
  const totalMonthlyLeakUsd = leaks.reduce(
    (sum, l) => sum + (l.status === "leaking" ? l.monthlyImpactUsd : 0),
    0
  );

  return {
    scannedAt: new Date().toISOString(),
    shopDomain,
    totalMonthlyLeakUsd: Math.round(totalMonthlyLeakUsd),
    leaks,
  };
}

function errorLeak(id: LeakResult["id"], title: string, err: unknown): LeakResult {
  console.error(`[LeakAudit] ${id} failed:`, err);
  return {
    id,
    title,
    status: "error",
    monthlyImpactUsd: 0,
    headline: "This check couldn't complete — likely a missing scope or a temporary API error.",
    actionLabel: "Retry",
    actionHref: "#",
  };
}

// ---------------------------------------------------------------
// 1. Payment gateway & FX fee markup
// ---------------------------------------------------------------
const FX_QUERY = `#graphql
  query FxLeakOrders($first: Int!, $query: String) {
    shop {
      currencyCode
    }
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

async function auditPaymentFxLeak(admin: AdminContext): Promise<LeakResult> {
  const since = daysAgoIso(30);
  const response = await admin.graphql(FX_QUERY, {
    variables: { first: 250, query: `created_at:>=${since}` },
  });
  const data = await response.json();

  const shopCurrency: string = data.data?.shop?.currencyCode;
  const orders = data.data?.orders?.edges ?? [];

  if (orders.length === 0) {
    return insufficientData(
      "fx_fees",
      "Payment & FX Fee Drag",
      "No orders in the last 30 days yet — place a test order to see this check run."
    );
  }

  let crossBorderRevenue = 0;
  let totalRevenue = 0;

  for (const { node } of orders) {
    const amount = parseFloat(node.currentTotalPriceSet?.shopMoney?.amount ?? "0");
    totalRevenue += amount;
    if (node.presentmentCurrencyCode && node.presentmentCurrencyCode !== shopCurrency) {
      crossBorderRevenue += amount;
    }
  }

  const monthlyImpact = crossBorderRevenue * FX_MARKUP_ESTIMATE;
  const crossBorderShare = totalRevenue > 0 ? crossBorderRevenue / totalRevenue : 0;

  return {
    id: "fx_fees",
    title: "Payment & FX Fee Drag",
    status: monthlyImpact > 1 ? "leaking" : "ok",
    monthlyImpactUsd: round2(monthlyImpact),
    headline:
      crossBorderShare > 0
        ? `${Math.round(crossBorderShare * 100)}% of your last 30 days of revenue was in a foreign presentment currency, estimated at a ${(FX_MARKUP_ESTIMATE * 100).toFixed(1)}% conversion drag.`
        : "No meaningful cross-border currency exposure detected in the last 30 days.",
    actionLabel: "Review FX Routing",
    actionHref: "shopify:admin/settings/payments",
    details: { crossBorderRevenue: round2(crossBorderRevenue), totalRevenue: round2(totalRevenue), shopCurrency },
  };
}

// ---------------------------------------------------------------
// 2. Abandoned / leftover app script bloat
// ---------------------------------------------------------------
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

async function auditAppBloatLeak(admin: AdminContext): Promise<LeakResult> {
  const response = await admin.graphql(THEME_QUERY);
  const data = await response.json();
  const theme = data.data?.themes?.nodes?.[0];
  const body: string | undefined = theme?.files?.nodes?.[0]?.body?.content;

  if (!body) {
    return insufficientData(
      "app_bloat",
      "Leftover App Script Bloat",
      "Couldn't read theme.liquid — check that the store has an active published theme to scan."
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
    monthlyImpactUsd: found.length > 0 ? estimatedMonthlyImpact : 0,
    headline:
      found.length > 0
        ? `Found ${found.length} leftover script${found.length > 1 ? "s" : ""} from apps you may no longer use: ${found.map((f) => f.label).join(", ")}.`
        : "No known orphaned app scripts detected in your live theme.",
    actionLabel: "Clean Leftover Scripts",
    actionHref: "shopify:admin/themes/current/editor",
    details: { matches: found.map((f) => f.label), themeName: theme?.name },
  };
}

// ---------------------------------------------------------------
// 3. Negative-margin SKUs (post-shipping)
// ---------------------------------------------------------------
const VARIANTS_QUERY = `#graphql
  query MarginVariants($first: Int!) {
    productVariants(first: $first, query: "inventory_quantity:>0") {
      edges {
        node {
          id
          title
          price
          product { title }
          inventoryItem {
            unitCost { amount }
          }
        }
      }
    }
  }
`;

async function auditNegativeMarginSkus(admin: AdminContext): Promise<LeakResult> {
  const response = await admin.graphql(VARIANTS_QUERY, { variables: { first: 250 } });
  const data = await response.json();
  const variants = data.data?.productVariants?.edges ?? [];

  if (variants.length === 0) {
    return insufficientData(
      "negative_margin",
      "Negative-Margin SKUs",
      "No in-stock variants found yet — add products with inventory to run this check."
    );
  }

  const withCost = variants.filter((e: any) => e.node.inventoryItem?.unitCost?.amount != null);
  if (withCost.length === 0) {
    return insufficientData(
      "negative_margin",
      "Negative-Margin SKUs",
      `Set cost-per-item on your top SKUs to unlock margin tracking (0 of ${variants.length} variants have a cost set).`
    );
  }

  const negatives = withCost
    .map((e: any) => {
      const price = parseFloat(e.node.price ?? "0");
      const cost = parseFloat(e.node.inventoryItem.unitCost.amount ?? "0");
      const netMargin = price - cost - SHIPPING_BASELINE_PER_ORDER;
      return { title: `${e.node.product?.title ?? ""} — ${e.node.title}`, price, cost, netMargin };
    })
    .filter((v: any) => v.netMargin <= 0)
    .sort((a: any, b: any) => a.netMargin - b.netMargin);

  // Placeholder velocity assumption (~3 units/mo per losing SKU) until
  // real order-line history is wired in — flag clearly to the user as such.
  const monthlyImpact = negatives.reduce((sum: number, v: any) => sum + Math.abs(v.netMargin) * 3, 0);

  return {
    id: "negative_margin",
    title: "Negative-Margin SKUs",
    status: negatives.length > 0 ? "leaking" : "ok",
    monthlyImpactUsd: round2(monthlyImpact),
    headline:
      negatives.length > 0
        ? `${negatives.length} SKU${negatives.length > 1 ? "s are" : " is"} selling at zero or negative margin after estimated shipping cost.`
        : "No SKUs are selling below cost after estimated shipping.",
    actionLabel: "Fix Negative Margin SKUs",
    actionHref: "shopify:admin/products",
    details: {
      skusChecked: withCost.length,
      skusMissingCost: variants.length - withCost.length,
      worstOffenders: negatives.slice(0, 5),
    },
  };
}

// ---------------------------------------------------------------
// 4. Return rate drift
// ---------------------------------------------------------------
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

async function auditReturnRateDrift(admin: AdminContext): Promise<LeakResult> {
  const since = daysAgoIso(LOOKBACK_DAYS);
  const response = await admin.graphql(REFUNDS_QUERY, {
    variables: { first: 250, query: `created_at:>=${since}` },
  });
  const data = await response.json();
  const orders = data.data?.orders?.edges ?? [];

  if (orders.length < 5) {
    return insufficientData(
      "return_drift",
      "Return Rate Drift",
      `Only ${orders.length} order(s) in the last ${LOOKBACK_DAYS} days — need more order volume for a reliable return rate.`
    );
  }

  let totalRevenue = 0;
  let totalRefunded = 0;
  let refundedOrderCount = 0;

  for (const { node } of orders) {
    const orderTotal = parseFloat(node.currentTotalPriceSet?.shopMoney?.amount ?? "0");
    totalRevenue += orderTotal;
    const refundedForOrder = (node.refunds ?? []).reduce(
      (sum: number, r: any) => sum + parseFloat(r.totalRefundedSet?.shopMoney?.amount ?? "0"),
      0
    );
    if (refundedForOrder > 0) refundedOrderCount += 1;
    totalRefunded += refundedForOrder;
  }

  const returnRate = orders.length > 0 ? refundedOrderCount / orders.length : 0;
  const drift = returnRate - RETURN_RATE_BENCHMARK;
  const monthlyImpact = drift > 0 ? totalRefunded * (30 / LOOKBACK_DAYS) : 0;

  return {
    id: "return_drift",
    title: "Return Rate Drift",
    status: drift > 0.01 ? "leaking" : "ok",
    monthlyImpactUsd: round2(monthlyImpact),
    headline:
      drift > 0.01
        ? `Your return rate is ${(returnRate * 100).toFixed(1)}%, ${(drift * 100).toFixed(1)}pp above the ${(RETURN_RATE_BENCHMARK * 100).toFixed(0)}% benchmark.`
        : `Return rate is ${(returnRate * 100).toFixed(1)}%, within the normal range.`,
    actionLabel: "Investigate Return Drivers",
    actionHref: "shopify:admin/orders?status=refunded",
    details: { returnRate: round2(returnRate * 100), totalRefunded: round2(totalRefunded), ordersAnalyzed: orders.length },
  };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function insufficientData(id: LeakResult["id"], title: string, message: string): LeakResult {
  return {
    id,
    title,
    status: "insufficient_data",
    monthlyImpactUsd: 0,
    headline: message,
    actionLabel: "Learn More",
    actionHref: "#",
  };
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
