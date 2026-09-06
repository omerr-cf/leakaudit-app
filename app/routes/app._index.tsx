import type { ActionFunctionArgs, LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { runAudit, type AuditReport, type LeakResult } from "../services/audit.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const report = await runAudit(admin, session.shop);

  const settings = await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop, weeklyAlertEnabled: false },
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

  // default intent: re-run the scan
  const report = await runAudit(admin, session.shop);
  return { report };
};

function toneFor(status: LeakResult["status"]): "critical" | "success" | "warning" | "info" {
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

export default function Index() {
  const { report, weeklyAlertEnabled } = useLoaderData<typeof loader>();
  const rescanFetcher = useFetcher<typeof action>();
  const alertFetcher = useFetcher<typeof action>();

  const liveReport: AuditReport = rescanFetcher.data?.report ?? report;
  const liveAlertEnabled =
    alertFetcher.data?.weeklyAlertEnabled ?? weeklyAlertEnabled;
  const isScanning = rescanFetcher.state !== "idle";

  const handleRescan = () => {
    rescanFetcher.submit({ intent: "rescan" }, { method: "post" });
  };

  const handleToggleAlert = () => {
    alertFetcher.submit(
      { intent: "toggle-weekly-alert", enabled: String(!liveAlertEnabled) },
      { method: "post" }
    );
  };

  return (
    <s-page heading="LeakAudit">
      <s-button
        slot="primary-action"
        onClick={handleRescan}
        {...(isScanning ? { loading: true } : {})}
      >
        🔄 Run Re-Scan
      </s-button>

      <s-section heading={liveReport.shopDomain}>
        <s-banner
          heading={
            liveReport.totalMonthlyLeakUsd > 0
              ? `Total Estimated Leaks: $${liveReport.totalMonthlyLeakUsd.toLocaleString()} / month`
              : "No leaks detected — nice work."
          }
          tone={liveReport.totalMonthlyLeakUsd > 0 ? "critical" : "success"}
        >
          <s-paragraph>
            Last scanned {new Date(liveReport.scannedAt).toLocaleString()}
          </s-paragraph>
        </s-banner>
      </s-section>

      {liveReport.leaks.map((leak) => (
        <s-section key={leak.id} heading={leak.title}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-badge tone={toneFor(leak.status)}>{badgeLabel(leak.status)}</s-badge>
              {leak.status === "leaking" && (
                <s-text>
                  <strong>${leak.monthlyImpactUsd.toLocaleString()}/mo</strong>
                </s-text>
              )}
            </s-stack>

            <s-paragraph>{leak.headline}</s-paragraph>

            <s-stack direction="inline" gap="base">
              <s-button
                href={leak.actionHref.startsWith("shopify:") ? undefined : leak.actionHref}
                onClick={
                  leak.actionHref.startsWith("shopify:")
                    ? () => {
                        // In-admin deep links (shopify:admin/...) — swap for
                        // shopify.intents.invoke(...) via useAppBridge() once
                        // you confirm the exact deep-link API for your version.
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
    </s-page>
  );
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
