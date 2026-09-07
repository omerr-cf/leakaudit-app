import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import db from "../db.server";
import {
  runAudit,
  type AuditReport,
  type LeakResult,
} from "../services/audit.server";
import { sendFeedbackNotification } from "../services/email.server";
import { authenticate, BILLING_ENABLED } from "../shopify.server";

// Configurable once the app has a real Shopify App Store listing — set
// SHOPIFY_APP_STORE_SLUG in .env (or a Fly.io secret) and the review
// banner's link updates automatically, no code change needed.
const APP_STORE_SLUG = process.env.SHOPIFY_APP_STORE_SLUG || "YOUR_APP_SLUG";
const REVIEW_URL = `https://apps.shopify.com/${APP_STORE_SLUG}#modal-show=ReviewListingModal`;
// How long "Remind Me Later" snoozes the review banner for.
const REVIEW_REMIND_DAYS = 7;

async function getSettings(shop: string) {
  return db.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

export interface SavingsSummary {
  scanCount: number;
  firstScannedAt: string | null;
  // How much lower today's estimated monthly leak is than it was on your
  // very first scan. Never negative — if things got worse we just show 0
  // rather than a confusing negative "savings" number.
  recoveredMonthlyEstimate: number;
}

// Records this scan in AuditSnapshot (so the dashboard can show a trend
// instead of only "right now") and returns a simple savings summary.
async function recordSnapshotAndSummarize(
  shop: string,
  report: AuditReport,
): Promise<SavingsSummary> {
  await db.auditSnapshot.create({
    data: {
      shop,
      healthScore: report.healthScore,
      totalMonthlyLeak: report.totalMonthlyLeak,
      currencyCode: report.currencyCode,
    },
  });

  const [scanCount, firstSnapshot] = await Promise.all([
    db.auditSnapshot.count({ where: { shop } }),
    db.auditSnapshot.findFirst({
      where: { shop },
      orderBy: { scannedAt: "asc" },
    }),
  ]);

  const recoveredMonthlyEstimate = firstSnapshot
    ? Math.max(0, firstSnapshot.totalMonthlyLeak - report.totalMonthlyLeak)
    : 0;

  return {
    scanCount,
    firstScannedAt: firstSnapshot?.scannedAt.toISOString() ?? null,
    recoveredMonthlyEstimate: Math.round(recoveredMonthlyEstimate * 100) / 100,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const report = await runAudit(admin, session.shop, {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
  });
  const savings = await recordSnapshotAndSummarize(session.shop, report);

  // Show the review-request banner only when there's actual recoverable
  // cash to show off, the merchant hasn't already told us they reviewed,
  // and any "remind me later" snooze has expired.
  const showReviewBanner =
    report.totalMonthlyLeak > 0 &&
    !settings.reviewBannerDismissedAt &&
    (!settings.reviewBannerRemindAt ||
      settings.reviewBannerRemindAt <= new Date());

  return {
    report,
    weeklyAlertEnabled: settings.weeklyAlertEnabled,
    savings,
    showReviewBanner,
    reviewUrl: REVIEW_URL,
    billingEnabled: BILLING_ENABLED,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "toggle-weekly-alert") {
    const enabled = form.get("enabled") === "true";
    const settings = await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: { weeklyAlertEnabled: enabled },
      create: { shop: session.shop, weeklyAlertEnabled: enabled },
    });
    return { weeklyAlertEnabled: settings.weeklyAlertEnabled };
  }

  if (intent === "submit-feedback") {
    const message = String(form.get("message") ?? "").trim();
    if (!message) {
      return { feedback: { saved: false, reason: "Feedback was empty." } };
    }
    await db.feedback.create({ data: { shop: session.shop, message } });
    // Best-effort — feedback is already safely saved above either way.
    await sendFeedbackNotification(session.shop, message);
    return { feedback: { saved: true } };
  }

  if (intent === "review-banner") {
    const bannerAction = form.get("action"); // "reviewed" | "remind-later"
    if (bannerAction === "reviewed") {
      // They're off to leave a review — never show this again for this shop.
      await db.shopSettings.upsert({
        where: { shop: session.shop },
        update: { reviewBannerDismissedAt: new Date() },
        create: { shop: session.shop, reviewBannerDismissedAt: new Date() },
      });
    } else if (bannerAction === "remind-later") {
      const remindAt = new Date();
      remindAt.setDate(remindAt.getDate() + REVIEW_REMIND_DAYS);
      await db.shopSettings.upsert({
        where: { shop: session.shop },
        update: { reviewBannerRemindAt: remindAt },
        create: { shop: session.shop, reviewBannerRemindAt: remindAt },
      });
    }
    return { reviewBannerHandled: true };
  }

  // default intent: re-run the scan, using whatever settings are saved now
  const settings = await getSettings(session.shop);
  const report = await runAudit(admin, session.shop, {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
  });
  const savings = await recordSnapshotAndSummarize(session.shop, report);
  return { report, savings };
};

function toneFor(
  status: LeakResult["status"],
): "critical" | "success" | "warning" | "info" {
  switch (status) {
    case "leaking":
      return "critical";
    case "ok":
      return "success";
    case "insufficient_data":
      return "warning";
    default:
      return "info";
  }
}

function badgeLabel(status: LeakResult["status"]) {
  switch (status) {
    case "leaking":
      return "Leaking";
    case "ok":
      return "Healthy";
    case "insufficient_data":
      return "Needs setup";
    default:
      return "Error";
  }
}

function healthTone(score: number): "critical" | "warning" | "success" {
  if (score >= 90) return "success";
  if (score >= 70) return "warning";
  return "critical";
}

// Lower number = shown first. Leaking (actually costing money) leads,
// then error (broken, needs attention), then needs-setup, then healthy.
const STATUS_PRIORITY: Record<LeakResult["status"], number> = {
  leaking: 0,
  error: 1,
  insufficient_data: 2,
  ok: 3,
};

// One crisp, plain-English fix per leak type — shown only while that
// check is actually "leaking", right under the headline.
const LEAK_ACTION_TIPS: Record<LeakResult["id"], string> = {
  fx_fees:
    "💡 Fix: Turn on multi-currency payouts under Shopify Payments to eliminate foreign conversion fees.",
  negative_margin:
    "💡 Fix: Update supplier costs or bundle with higher-margin accessories to protect net margin.",
  app_bloat:
    "💡 Fix: Delete the leftover snippet from your theme's code editor — the app it belonged to is already uninstalled, so it's safe to remove.",
  return_drift:
    "💡 Fix: Check sizing charts, product photos/descriptions, and packaging for your most-returned items — most return spikes trace back to expectation mismatches, not defects.",
};

// Format in the SHOP's own currency (not hardcoded $) — see audit.server.ts
// for why this matters for any non-USD merchant.
// Small leaks (a few cents/agorot of margin drag) used to round away to
// "$0", which read as broken. Amounts under 10 units keep 2 decimals;
// anything bigger rounds to whole units so large totals stay clean.
function formatMoney(amount: number, currencyCode: string): string {
  const decimals = Math.abs(amount) > 0 && Math.abs(amount) < 10 ? 2 : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    // Unknown/invalid currency code — fail soft instead of crashing the page.
    return `${amount.toFixed(decimals)} ${currencyCode}`;
  }
}

// Turns a relative admin path (e.g. "/products/123") into the full
// admin.shopify.com URL for this shop, so action buttons actually go
// somewhere instead of doing nothing. `target="_top"` on the <s-button>
// that uses this is what breaks the link out of the app's embedded iframe
// and into the real (top-level) Shopify Admin.
function adminUrl(shopDomain: string, relativePath: string): string {
  const handle = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${handle}${relativePath}`;
}

interface MarginOffenderView {
  title: string;
  marginPercent: number;
  actionHref: string | null;
}

function getWorstOffenders(
  details: Record<string, unknown> | undefined,
): MarginOffenderView[] {
  const raw = details?.worstOffenders;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is MarginOffenderView =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as MarginOffenderView).title === "string" &&
      typeof (o as MarginOffenderView).marginPercent === "number",
  );
}

interface RefundedOrderView {
  id: string;
  actionHref: string;
}

function getRefundedOrders(
  details: Record<string, unknown> | undefined,
): RefundedOrderView[] {
  const raw = details?.refundedOrders;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is RefundedOrderView =>
      typeof o === "object" &&
      o !== null &&
      typeof (o as RefundedOrderView).id === "string" &&
      typeof (o as RefundedOrderView).actionHref === "string",
  );
}

interface FxDetailsView {
  crossBorderRevenue: number;
  totalRevenue: number;
  shopCurrency: string;
}

function getFxDetails(
  details: Record<string, unknown> | undefined,
): FxDetailsView | null {
  if (
    typeof details?.crossBorderRevenue === "number" &&
    typeof details?.totalRevenue === "number" &&
    typeof details?.shopCurrency === "string"
  ) {
    return details as unknown as FxDetailsView;
  }
  return null;
}

interface BloatDetailsView {
  matches: string[];
  themeName?: string;
}

function getBloatDetails(
  details: Record<string, unknown> | undefined,
): BloatDetailsView | null {
  if (Array.isArray(details?.matches)) {
    return {
      matches: details.matches.filter(
        (m): m is string => typeof m === "string",
      ),
      themeName:
        typeof details.themeName === "string" ? details.themeName : undefined,
    };
  }
  return null;
}

export default function Index() {
  const {
    report,
    weeklyAlertEnabled,
    savings,
    showReviewBanner,
    reviewUrl,
    billingEnabled,
  } = useLoaderData<typeof loader>();
  const rescanFetcher = useFetcher<typeof action>();
  const alertFetcher = useFetcher<typeof action>();
  const feedbackFetcher = useFetcher<typeof action>();
  const reviewFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const wasScanning = useRef(false);
  // Instant client-side hide the moment either banner button is clicked,
  // rather than waiting on a full loader re-run.
  const [reviewBannerHidden, setReviewBannerHidden] = useState(false);

  const liveReport: AuditReport = rescanFetcher.data?.report ?? report;
  const liveSavings = rescanFetcher.data?.savings ?? savings;
  const liveAlertEnabled =
    alertFetcher.data?.weeklyAlertEnabled ?? weeklyAlertEnabled;
  const isScanning = rescanFetcher.state !== "idle";
  const isSendingFeedback = feedbackFetcher.state !== "idle";

  // Toast once the re-scan fetcher goes from busy -> idle with a fresh report.
  useEffect(() => {
    if (wasScanning.current && !isScanning && rescanFetcher.data?.report) {
      shopify.toast.show(
        `Scan completed. ${rescanFetcher.data.report.leaks.length} vectors updated.`,
      );
    }
    wasScanning.current = isScanning;
  }, [isScanning, rescanFetcher.data, shopify]);

  useEffect(() => {
    const result = feedbackFetcher.data?.feedback;
    if (!result || isSendingFeedback) return;
    shopify.toast.show(
      result.saved
        ? "Thanks — feedback sent."
        : `Couldn't send feedback: ${result.reason}`,
      { isError: !result.saved },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackFetcher.data]);

  const handleRescan = () => {
    rescanFetcher.submit({ intent: "rescan" }, { method: "post" });
  };

  const handleToggleAlert = () => {
    alertFetcher.submit(
      { intent: "toggle-weekly-alert", enabled: String(!liveAlertEnabled) },
      { method: "post" },
    );
  };

  const handleSubmitFeedback = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const message = String(form.get("message") ?? "").trim();
    if (!message) {
      shopify.toast.show("Type a message before sending.", { isError: true });
      return;
    }
    feedbackFetcher.submit(
      { intent: "submit-feedback", message },
      { method: "post" },
    );
    event.currentTarget.reset();
  };

  const handleLeaveReview = () => {
    setReviewBannerHidden(true);
    // Fires in parallel with the link's own top-level navigation to the
    // App Store review modal — no need to preventDefault or wait for it.
    reviewFetcher.submit(
      { intent: "review-banner", action: "reviewed" },
      { method: "post" },
    );
  };

  const handleRemindReviewLater = () => {
    setReviewBannerHidden(true);
    reviewFetcher.submit(
      { intent: "review-banner", action: "remind-later" },
      { method: "post" },
    );
  };

  const leakingCount = liveReport.leaks.filter(
    (l) => l.status === "leaking",
  ).length;
  const needsSetupCount = liveReport.leaks.filter(
    (l) => l.status === "insufficient_data",
  ).length;
  const errorCount = liveReport.leaks.filter(
    (l) => l.status === "error",
  ).length;
  const healthyCount = liveReport.leaks.filter((l) => l.status === "ok").length;

  // Worst problems first: a merchant should see what's actually costing
  // them money before a check that's already healthy or just needs setup.
  const sortedLeaks = [...liveReport.leaks].sort(
    (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status],
  );

  return (
    <s-page heading="LeakAudit">
      <s-button
        slot="primary-action"
        onClick={handleRescan}
        {...(isScanning ? { loading: true } : {})}
      >
        Re-Scan Store
      </s-button>

      <s-section>
        <s-stack direction="inline" gap="base">
          {!billingEnabled && (
            <s-badge tone="success">
              🎉 Founder Beta: Free Lifetime Access
            </s-badge>
          )}
          <s-badge tone={healthTone(liveReport.healthScore)}>
            Health Score: {liveReport.healthScore}/100
          </s-badge>
          {leakingCount > 0 && (
            <s-badge tone="critical">{leakingCount} leaking</s-badge>
          )}
          {errorCount > 0 && (
            <s-badge tone="critical">{errorCount} error</s-badge>
          )}
          {needsSetupCount > 0 && (
            <s-badge tone="warning">{needsSetupCount} needs setup</s-badge>
          )}
          {healthyCount > 0 && (
            <s-badge tone="success">{healthyCount} healthy</s-badge>
          )}
        </s-stack>
      </s-section>

      <s-section heading={liveReport.shopDomain}>
        <s-banner
          heading={
            liveReport.totalMonthlyLeak > 0
              ? `Total Estimated Leaks: ${formatMoney(liveReport.totalMonthlyLeak, liveReport.currencyCode)} / month`
              : "No leaks detected — nice work."
          }
          tone={liveReport.totalMonthlyLeak > 0 ? "critical" : "success"}
        >
          <s-paragraph>
            Last scanned {new Date(liveReport.scannedAt).toLocaleString()}
          </s-paragraph>
        </s-banner>
      </s-section>

      <s-section heading="Store Margin Health Score">
        <s-stack direction="inline" gap="base">
          <s-badge tone={healthTone(liveReport.healthScore)}>
            Health Score: {liveReport.healthScore}/100
          </s-badge>
          {liveReport.totalMonthlyLeak > 0 && (
            <s-text>
              You are recovering an estimated{" "}
              {formatMoney(
                liveReport.totalMonthlyLeak,
                liveReport.currencyCode,
              )}
              /mo once fixes are applied.
            </s-text>
          )}
        </s-stack>
      </s-section>

      {showReviewBanner && !reviewBannerHidden && (
        <s-section>
          <s-banner heading="Finding LeakAudit helpful?" tone="info">
            <s-paragraph>
              If we helped you spot a leak today, leaving a quick review in the
              Shopify App Store helps our independent team grow!
            </s-paragraph>
            <s-button
              slot="secondary-actions"
              href={reviewUrl}
              target="_top"
              onClick={handleLeaveReview}
            >
              ⭐ Leave a Quick Review
            </s-button>
            <s-button
              slot="secondary-actions"
              onClick={handleRemindReviewLater}
            >
              Remind Me Later
            </s-button>
          </s-banner>
        </s-section>
      )}

      {sortedLeaks.map((leak) => {
        const modalId = `detail-modal-${leak.id}`;
        const fxDetails =
          leak.id === "fx_fees" ? getFxDetails(leak.details) : null;
        const bloatDetails =
          leak.id === "app_bloat" ? getBloatDetails(leak.details) : null;
        const offenders =
          leak.id === "negative_margin" ? getWorstOffenders(leak.details) : [];
        const refundedOrders =
          leak.id === "return_drift" ? getRefundedOrders(leak.details) : [];
        const hasDetails =
          Boolean(fxDetails) ||
          Boolean(bloatDetails) ||
          offenders.length > 0 ||
          refundedOrders.length > 0;
        const crossBorderPercent =
          fxDetails && fxDetails.totalRevenue > 0
            ? Math.round(
                (fxDetails.crossBorderRevenue / fxDetails.totalRevenue) * 100,
              )
            : 0;

        return (
          <s-section key={leak.id} heading={leak.title}>
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-badge tone={toneFor(leak.status)}>
                  {badgeLabel(leak.status)}
                </s-badge>
                {leak.status === "leaking" && (
                  <s-text>
                    <strong>
                      {formatMoney(leak.monthlyImpact, liveReport.currencyCode)}
                      /mo
                    </strong>
                  </s-text>
                )}
              </s-stack>

              <s-paragraph>{leak.headline}</s-paragraph>

              {leak.status === "leaking" && (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-text>{LEAK_ACTION_TIPS[leak.id]}</s-text>
                </s-box>
              )}

              {leak.status === "error" &&
                typeof leak.details?.errorMessage === "string" && (
                  <s-paragraph color="subdued">
                    Technical detail: {leak.details.errorMessage}
                  </s-paragraph>
                )}

              {leak.id === "negative_margin" &&
                leak.status === "leaking" &&
                offenders.length > 0 && (
                  <s-stack direction="block" gap="small">
                    {offenders.map((offender, i) => (
                      <s-stack key={i} direction="inline" gap="small">
                        <s-text>
                          {offender.title} ({offender.marginPercent.toFixed(0)}%
                          margin)
                        </s-text>
                        {offender.actionHref && (
                          <s-button
                            href={adminUrl(
                              liveReport.shopDomain,
                              offender.actionHref,
                            )}
                            target="_top"
                          >
                            Open
                          </s-button>
                        )}
                      </s-stack>
                    ))}
                  </s-stack>
                )}

              {leak.id === "return_drift" &&
                leak.status === "leaking" &&
                refundedOrders.length > 0 && (
                  <s-stack direction="block" gap="small">
                    {refundedOrders.map((order) => (
                      <s-stack key={order.id} direction="inline" gap="small">
                        <s-text>Order #{order.id}</s-text>
                        <s-button
                          href={adminUrl(
                            liveReport.shopDomain,
                            order.actionHref,
                          )}
                          target="_top"
                        >
                          Open
                        </s-button>
                      </s-stack>
                    ))}
                  </s-stack>
                )}

              <s-stack direction="inline" gap="base">
                {leak.status === "error" ? (
                  <s-button
                    onClick={handleRescan}
                    {...(isScanning ? { loading: true } : {})}
                  >
                    {leak.actionLabel}
                  </s-button>
                ) : (
                  <s-button
                    href={adminUrl(liveReport.shopDomain, leak.actionHref)}
                    target="_top"
                  >
                    {leak.actionLabel}
                  </s-button>
                )}
                {hasDetails && (
                  <s-button command="--show" commandFor={modalId}>
                    View Details
                  </s-button>
                )}
              </s-stack>
            </s-stack>

            {hasDetails && (
              <s-modal id={modalId} heading={leak.title}>
                <s-stack direction="block" gap="base">
                  {fxDetails && (
                    <>
                      <s-paragraph>
                        In the last 30 days,{" "}
                        {formatMoney(
                          fxDetails.crossBorderRevenue,
                          fxDetails.shopCurrency,
                        )}{" "}
                        of your{" "}
                        {formatMoney(
                          fxDetails.totalRevenue,
                          fxDetails.shopCurrency,
                        )}{" "}
                        total revenue ({crossBorderPercent}%) came from orders
                        placed in a currency other than your store's default (
                        {fxDetails.shopCurrency}).
                      </s-paragraph>
                      <s-paragraph color="subdued">
                        At an estimated 1.8% conversion &amp; FX drag, that's
                        the{" "}
                        {formatMoney(
                          leak.monthlyImpact,
                          liveReport.currencyCode,
                        )}
                        /mo shown above. Adding local currency pricing for your
                        top markets is the usual fix.
                      </s-paragraph>
                    </>
                  )}

                  {bloatDetails && (
                    <>
                      <s-paragraph>
                        We found {bloatDetails.matches.length} leftover app
                        snippet{bloatDetails.matches.length === 1 ? "" : "s"}{" "}
                        still loaded in your live theme
                        {bloatDetails.themeName
                          ? ` ("${bloatDetails.themeName}")`
                          : ""}
                        :
                      </s-paragraph>
                      <s-stack direction="block" gap="small">
                        {bloatDetails.matches.map((match, i) => (
                          <s-text key={i}>• {match}</s-text>
                        ))}
                      </s-stack>
                      <s-paragraph color="subdued">
                        These are usually left behind by an app you uninstalled.
                        Removing the snippet from your theme code won't break
                        anything — the app it was talking to is already gone.
                      </s-paragraph>
                    </>
                  )}

                  {leak.id === "negative_margin" && offenders.length > 0 && (
                    <>
                      <s-paragraph>
                        These products are priced below your target margin once
                        cost and shipping are factored in:
                      </s-paragraph>
                      <s-stack direction="block" gap="small">
                        {offenders.map((offender, i) => (
                          <s-stack key={i} direction="inline" gap="small">
                            <s-text>
                              {offender.title} (
                              {offender.marginPercent.toFixed(0)}% margin)
                            </s-text>
                            {offender.actionHref && (
                              <s-button
                                href={adminUrl(
                                  liveReport.shopDomain,
                                  offender.actionHref,
                                )}
                                target="_top"
                              >
                                Open
                              </s-button>
                            )}
                          </s-stack>
                        ))}
                      </s-stack>
                    </>
                  )}

                  {leak.id === "return_drift" && refundedOrders.length > 0 && (
                    <>
                      <s-paragraph>
                        These recent orders were refunded and are dragging your
                        return rate above benchmark:
                      </s-paragraph>
                      <s-stack direction="block" gap="small">
                        {refundedOrders.map((order) => (
                          <s-stack
                            key={order.id}
                            direction="inline"
                            gap="small"
                          >
                            <s-text>Order #{order.id}</s-text>
                            <s-button
                              href={adminUrl(
                                liveReport.shopDomain,
                                order.actionHref,
                              )}
                              target="_top"
                            >
                              Open
                            </s-button>
                          </s-stack>
                        ))}
                      </s-stack>
                    </>
                  )}
                </s-stack>
                <s-button
                  slot="secondary-actions"
                  command="--hide"
                  commandFor={modalId}
                >
                  Close
                </s-button>
              </s-modal>
            )}
          </s-section>
        );
      })}

      <s-section slot="aside" heading="Recoverable Cash Today">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Get a weekly email the moment a new leak appears.
          </s-paragraph>
          <s-button onClick={handleToggleAlert}>
            {liveAlertEnabled ? "Weekly Alerts: On" : "Weekly Alerts: Off"}
          </s-button>
          {isScanning && <s-paragraph>Scanning…</s-paragraph>}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Savings So Far">
        <s-stack direction="block" gap="base">
          {liveSavings.recoveredMonthlyEstimate > 0 ? (
            <s-paragraph>
              You've cut your estimated monthly leak by{" "}
              <strong>
                {formatMoney(
                  liveSavings.recoveredMonthlyEstimate,
                  liveReport.currencyCode,
                )}
              </strong>{" "}
              since your first scan.
            </s-paragraph>
          ) : (
            <s-paragraph>
              We'll show your savings here once a scan shows a lower total leak
              than your first one did.
            </s-paragraph>
          )}
          <s-paragraph color="subdued">
            {liveSavings.scanCount} scan
            {liveSavings.scanCount === 1 ? "" : "s"} recorded
            {liveSavings.firstScannedAt
              ? ` since ${new Date(liveSavings.firstScannedAt).toLocaleDateString()}`
              : ""}
            .
          </s-paragraph>
          <s-link href="/app/history">View full scan history →</s-link>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Early Access Beta">
        <s-paragraph>
          🎉 100% free while in private beta. Thank you for helping us shape
          LeakAudit!
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Send Us Feedback">
        <form onSubmit={handleSubmitFeedback}>
          <s-stack direction="block" gap="base">
            <s-text-area
              name="message"
              label="What's working, what's confusing, what's missing?"
              placeholder="Tell us anything — bugs, ideas, confusing bits."
            />
            <s-button
              type="submit"
              {...(isSendingFeedback ? { loading: true } : {})}
            >
              Send Feedback
            </s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
