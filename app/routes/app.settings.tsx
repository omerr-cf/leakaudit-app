import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import {
  buildDiagnostics,
  runAudit,
  type AuditReport,
  type DiagnosticRow,
} from "../services/audit.server";
import { sendAuditAlertEmail } from "../services/email.server";
import { authenticate, SHOW_QA_DIAGNOSTICS } from "../shopify.server";
import { badgeLabel, formatMoney, healthTone, toneFor } from "../utils/format";

interface ShopEmailResponse {
  shop: { email: string };
}

const SHOP_EMAIL_QUERY = `#graphql
  query ShopEmail { shop { email } }
`;

// Just the pieces of AuditReport the Diagnostics header actually shows —
// keeps the loader/action payloads small instead of round-tripping every
// leak's full details twice (once raw, once via buildDiagnostics()).
type DiagnosticsReportSummary = Pick<
  AuditReport,
  "scannedAt" | "currencyCode" | "healthScore" | "totalMonthlyLeak"
>;

function summarizeReport(report: AuditReport): DiagnosticsReportSummary {
  return {
    scannedAt: report.scannedAt,
    currencyCode: report.currencyCode,
    healthScore: report.healthScore,
    totalMonthlyLeak: report.totalMonthlyLeak,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const settings = await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  let shopEmail = "";
  if (!settings.notificationEmail) {
    const res = await admin.graphql(SHOP_EMAIL_QUERY);
    const data = (await res.json()) as { data: ShopEmailResponse };
    shopEmail = data.data?.shop?.email ?? "";
  }

  // Dev/beta only, gated the same as the Diagnostics panel — a real
  // merchant never sees this list, so there's no reason to spend a query
  // fetching it for them.
  const feedbackEntries = SHOW_QA_DIAGNOSTICS
    ? await db.feedback.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];

  // The extra scan for the Diagnostics panel only runs when the panel can
  // actually be seen — no reason to spend a real merchant's GraphQL
  // rate-limit budget computing a table they'll never load (SHOW_QA_
  // DIAGNOSTICS is off in production unless explicitly flipped on — see
  // shopify.server.ts). Always a real, live scan — LeakAudit has no
  // simulation/mock layer.
  let diagnostics: DiagnosticRow[] = [];
  let diagnosticsReport: DiagnosticsReportSummary | null = null;
  if (SHOW_QA_DIAGNOSTICS) {
    const report = await runAudit(admin, session.shop, {
      shippingCostPerOrder: settings.shippingCostPerOrder,
      targetMarginPercent: settings.targetMarginPercent,
    });
    diagnostics = buildDiagnostics(report);
    diagnosticsReport = summarizeReport(report);
  }

  return {
    shippingCostPerOrder: settings.shippingCostPerOrder,
    targetMarginPercent: settings.targetMarginPercent,
    notificationEmail: settings.notificationEmail ?? shopEmail,
    feedback: feedbackEntries.map((f) => ({
      id: f.id,
      message: f.message,
      createdAt: f.createdAt.toISOString(),
    })),
    showDiagnostics: SHOW_QA_DIAGNOSTICS,
    diagnostics,
    diagnosticsReport,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "send-test-alert") {
    // Uses whatever's already SAVED for this shop, not an unsaved form
    // field — save settings first, then send the test.
    const settings = await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    });
    const report = await runAudit(admin, session.shop, {
      shippingCostPerOrder: settings.shippingCostPerOrder,
      targetMarginPercent: settings.targetMarginPercent,
    });
    const result = await sendAuditAlertEmail(
      settings.notificationEmail ?? "",
      report,
    );
    return { testAlert: result };
  }

  if (intent === "rerun-diagnostics") {
    // Belt-and-suspenders: even if this POST is crafted directly, never
    // run (or reveal the results of) an extra scan outside the gated
    // dev/beta panel.
    if (!SHOW_QA_DIAGNOSTICS) {
      return { diagnosticsRerun: null };
    }
    const settings = await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    });
    const report = await runAudit(admin, session.shop, {
      shippingCostPerOrder: settings.shippingCostPerOrder,
      targetMarginPercent: settings.targetMarginPercent,
    });
    return {
      diagnosticsRerun: {
        diagnostics: buildDiagnostics(report),
        report: summarizeReport(report),
      },
    };
  }

  const shippingCostPerOrder = clampNumber(
    form.get("shippingCostPerOrder"),
    0,
    1000,
    5.0,
  );
  const targetMarginPercent = clampNumber(
    form.get("targetMarginPercent"),
    0,
    100,
    20,
  );
  const notificationEmail =
    String(form.get("notificationEmail") ?? "").trim() || null;

  await db.shopSettings.upsert({
    where: { shop: session.shop },
    update: { shippingCostPerOrder, targetMarginPercent, notificationEmail },
    create: {
      shop: session.shop,
      shippingCostPerOrder,
      targetMarginPercent,
      notificationEmail,
    },
  });

  return {
    saved: true,
    shippingCostPerOrder,
    targetMarginPercent,
    notificationEmail,
  };
};

function clampNumber(
  value: FormDataEntryValue | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = parseFloat(String(value ?? ""));
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSaving = navigation.state !== "idle";
  const testAlertFetcher = useFetcher<typeof action>();
  const diagnosticsFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isSendingTest = testAlertFetcher.state !== "idle";
  const isRerunningDiagnostics = diagnosticsFetcher.state !== "idle";

  // Collapsed by default so the panel never dominates the Settings page —
  // "toggled by a button" per the spec, on top of the SHOW_QA_DIAGNOSTICS
  // gate that keeps it out of production entirely.
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  // Starts from whatever the loader's own scan found; replaced in place
  // once "Re-Run Diagnostics Scan" comes back with a fresh one, so newly
  // seeded/fixed data shows up without a full page reload.
  const [diagnostics, setDiagnostics] = useState(data.diagnostics);
  const [diagnosticsReport, setDiagnosticsReport] = useState(
    data.diagnosticsReport,
  );

  useEffect(() => {
    const result = testAlertFetcher.data?.testAlert;
    if (!result || isSendingTest) return;
    shopify.toast.show(
      result.sent
        ? "Test alert email sent — check your inbox."
        : `Couldn't send test alert: ${result.reason}`,
      { isError: !result.sent },
    );
    // Only fire when a fresh result actually arrives, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testAlertFetcher.data]);

  useEffect(() => {
    const rerun = diagnosticsFetcher.data?.diagnosticsRerun;
    if (!rerun || isRerunningDiagnostics) return;
    setDiagnostics(rerun.diagnostics);
    setDiagnosticsReport(rerun.report);
    shopify.toast.show("Diagnostics re-scanned — figures below are live.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosticsFetcher.data]);

  const handleSendTestAlert = () => {
    testAlertFetcher.submit({ intent: "send-test-alert" }, { method: "post" });
  };

  const handleRerunDiagnostics = () => {
    diagnosticsFetcher.submit(
      { intent: "rerun-diagnostics" },
      { method: "post" },
    );
  };

  return (
    <s-page heading="LeakAudit Settings">
      <s-section heading="Audit assumptions">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-number-field
              label="Average shipping cost per order"
              name="shippingCostPerOrder"
              step={0.01}
              defaultValue={String(data.shippingCostPerOrder)}
              details="Used to estimate net margin on the Negative-Margin SKUs check. In your store's own currency, not USD."
            />
            <s-number-field
              label="Target minimum profit margin (%)"
              name="targetMarginPercent"
              step={1}
              defaultValue={String(data.targetMarginPercent)}
              details="A SKU is flagged as leaking when its estimated net margin falls below this percentage."
            />
            <s-email-field
              label="Notification email for weekly alerts"
              name="notificationEmail"
              defaultValue={data.notificationEmail}
              details="Defaults to your store's account email."
            />
            <s-button
              variant="primary"
              type="submit"
              {...(isSaving ? { loading: true } : {})}
            >
              Save Settings
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Weekly alert email">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Send yourself a real test email right now, using whatever
            notification email is currently saved above (save it first if you
            just changed it).
          </s-paragraph>
          <s-button
            onClick={handleSendTestAlert}
            {...(isSendingTest ? { loading: true } : {})}
          >
            Send Test Alert Now
          </s-button>
          <s-paragraph color="subdued">
            This sends one email immediately — it doesn&apos;t yet run
            automatically on a weekly schedule (that needs the app deployed
            somewhere that can run a schedule, not just your laptop).
          </s-paragraph>
        </s-stack>
      </s-section>

      {data.showDiagnostics && (
        <s-section heading="🛠️ Developer Diagnostics & Calculation Inspector">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Dev/beta only — this never appears for real merchants (gated by
              SHOW_QA_DIAGNOSTICS, see shopify.server.ts). Shows exactly what
              the last scan pulled from Shopify for each of the 4 checks, the
              literal formula applied, and the resulting status — so you can
              sanity-check the math before launch instead of trusting it
              blindly. Runs strictly against real, live store data.
            </s-paragraph>

            <s-stack direction="inline" gap="base">
              <s-button onClick={() => setDiagnosticsExpanded((v) => !v)}>
                {diagnosticsExpanded ? "Hide Inspector" : "Show Inspector"}
              </s-button>
              {diagnosticsExpanded && (
                <s-button
                  onClick={handleRerunDiagnostics}
                  {...(isRerunningDiagnostics ? { loading: true } : {})}
                >
                  🔄 Re-Run Diagnostics Scan
                </s-button>
              )}
            </s-stack>

            {diagnosticsExpanded && diagnosticsReport && (
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="base">
                  <s-badge tone={healthTone(diagnosticsReport.healthScore)}>
                    Health Score: {diagnosticsReport.healthScore}/100
                  </s-badge>
                  <s-badge
                    tone={
                      diagnosticsReport.totalMonthlyLeak > 0
                        ? "critical"
                        : "success"
                    }
                  >
                    Total leak:{" "}
                    {formatMoney(
                      diagnosticsReport.totalMonthlyLeak,
                      diagnosticsReport.currencyCode,
                    )}
                    /mo
                  </s-badge>
                </s-stack>
                <s-paragraph color="subdued">
                  Scanned{" "}
                  {new Date(diagnosticsReport.scannedAt).toLocaleString()}
                </s-paragraph>

                {diagnostics.map((row) => (
                  <s-box
                    key={row.id}
                    padding="base"
                    borderWidth="base"
                    borderRadius="base"
                  >
                    <s-stack direction="block" gap="small">
                      <s-stack direction="inline" gap="base">
                        <s-text>
                          <strong>{row.title}</strong>
                        </s-text>
                        <s-badge tone={toneFor(row.status)}>
                          {badgeLabel(row.status)}
                        </s-badge>
                      </s-stack>

                      {row.rawInputs.length > 0 && (
                        <s-stack direction="block" gap="small">
                          <s-paragraph color="subdued">
                            Raw Shopify data inputs:
                          </s-paragraph>
                          {row.rawInputs.map((input) => (
                            <s-stack
                              key={input.label}
                              direction="inline"
                              gap="small"
                            >
                              <s-text>{input.label}:</s-text>
                              <s-text>
                                <strong>{input.value}</strong>
                              </s-text>
                            </s-stack>
                          ))}
                        </s-stack>
                      )}

                      <s-paragraph color="subdued">
                        Formula applied:
                      </s-paragraph>
                      <s-paragraph>
                        <code>{row.formula}</code>
                      </s-paragraph>

                      <s-text>
                        <strong>Computed Output:</strong> {row.computedOutput}
                      </s-text>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-section>
      )}

      {data.showDiagnostics && (
        // Dev/beta only, same as the Diagnostics panel above — a raw list
        // of past feedback submissions reads like an internal debug log,
        // not something a real merchant should see. Merchants only ever
        // interact with the clean "Send Us Feedback" input card on the
        // Home tab; this view is purely for us to confirm a submission
        // actually landed while testing.
        <s-section heading="Feedback You've Sent">
          {data.feedback.length === 0 ? (
            <s-paragraph color="subdued">
              Nothing yet — anything you type into the &quot;Send Us
              Feedback&quot; box on the Home tab will show up here, permanently
              saved, whether or not email notifications are set up.
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="base">
              {data.feedback.map((entry) => (
                <s-box
                  key={entry.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small">
                    <s-paragraph>{entry.message}</s-paragraph>
                    <s-paragraph color="subdued">
                      {new Date(entry.createdAt).toLocaleString()}
                    </s-paragraph>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-section>
      )}
    </s-page>
  );
}
