import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef } from "react";
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
import { authenticate } from "../shopify.server";

async function getSettings(shop: string) {
  return db.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const report = await runAudit(admin, session.shop, {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
  });

  return { report, weeklyAlertEnabled: settings.weeklyAlertEnabled };
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

  // default intent: re-run the scan, using whatever settings are saved now
  const settings = await getSettings(session.shop);
  const report = await runAudit(admin, session.shop, {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
  });
  return { report };
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

// Format in the SHOP's own currency (not hardcoded $) — see audit.server.ts
// for why this matters for any non-USD merchant.
function formatMoney(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Unknown/invalid currency code — fail soft instead of crashing the page.
    return `${amount.toLocaleString()} ${currencyCode}`;
  }
}

export default function Index() {
  const { report, weeklyAlertEnabled } = useLoaderData<typeof loader>();
  const rescanFetcher = useFetcher<typeof action>();
  const alertFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const wasScanning = useRef(false);

  const liveReport: AuditReport = rescanFetcher.data?.report ?? report;
  const liveAlertEnabled =
    alertFetcher.data?.weeklyAlertEnabled ?? weeklyAlertEnabled;
  const isScanning = rescanFetcher.state !== "idle";

  // Toast once the re-scan fetcher goes from busy -> idle with a fresh report.
  useEffect(() => {
    if (wasScanning.current && !isScanning && rescanFetcher.data?.report) {
      shopify.toast.show(
        `Scan completed. ${rescanFetcher.data.report.leaks.length} vectors updated.`,
      );
    }
    wasScanning.current = isScanning;
  }, [isScanning, rescanFetcher.data, shopify]);

  const handleRescan = () => {
    rescanFetcher.submit({ intent: "rescan" }, { method: "post" });
  };

  const handleToggleAlert = () => {
    alertFetcher.submit(
      { intent: "toggle-weekly-alert", enabled: String(!liveAlertEnabled) },
      { method: "post" },
    );
  };

  return (
    <s-page heading="LeakAudit">
      <s-button
        slot="primary-action"
        onClick={handleRescan}
        {...(isScanning ? { loading: true } : {})}
      >
        Re-Scan Store
      </s-button>

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

      {liveReport.leaks.map((leak) => (
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

            {leak.status === "error" &&
              typeof leak.details?.errorMessage === "string" && (
                <s-paragraph color="subdued">
                  Technical detail: {leak.details.errorMessage}
                </s-paragraph>
              )}

            <s-stack direction="inline" gap="base">
              <s-button
                href={
                  leak.actionHref.startsWith("shopify:")
                    ? undefined
                    : leak.actionHref
                }
                onClick={
                  leak.actionHref.startsWith("shopify:")
                    ? () => {
                        // In-admin deep links (shopify:admin/...) — swap for
                        // shopify.intents.invoke(...) once you confirm the
                        // exact deep-link API for your version.
                      }
                    : undefined
                }
              >
                {leak.actionLabel}
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ))}

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

      <s-section slot="aside" heading="Early Access Beta">
        <s-paragraph>
          🎉 100% free while in private beta. Thank you for helping us shape
          LeakAudit!
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
