// Loads .env at module import time so RESEND_API_KEY is available even
// though nothing else in this project reads a .env file directly today
// (Shopify CLI injects SHOPIFY_* vars into the process itself). Safe to
// import repeatedly — dotenv no-ops if the vars are already set.
import "dotenv/config";
import { Resend } from "resend";
import type { AuditReport } from "./audit.server";

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || "onboarding@resend.dev";

export interface SendAlertResult {
  sent: boolean;
  reason?: string;
}

function formatMoney(amount: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currencyCode}`;
  }
}

function reportToHtml(report: AuditReport): string {
  const rows = report.leaks
    .map((leak) => {
      const badge =
        leak.status === "leaking"
          ? `<strong style="color:#b3261e">Leaking</strong>`
          : leak.status === "ok"
            ? `<span style="color:#0f7a4d">Healthy</span>`
            : leak.status === "error"
              ? `<span style="color:#b3261e">Error</span>`
              : `<span style="color:#8a6d1a">Needs setup</span>`;
      const impact =
        leak.status === "leaking"
          ? ` — ${formatMoney(leak.monthlyImpact, report.currencyCode)}/mo`
          : "";
      return `<li><strong>${leak.title}</strong>: ${badge}${impact}<br/><span style="color:#555">${leak.headline}</span></li>`;
    })
    .join("");

  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; color:#14181f; max-width: 40rem;">
      <h2>LeakAudit weekly check-in for ${report.shopDomain}</h2>
      <p>Health Score: <strong>${report.healthScore}/100</strong></p>
      <p>Total estimated leak: <strong>${formatMoney(report.totalMonthlyLeak, report.currencyCode)}/mo</strong></p>
      <ul style="padding-left: 1.2rem;">${rows}</ul>
      <p style="color:#8a8f9c; font-size: 0.85rem;">
        Scanned ${new Date(report.scannedAt).toLocaleString()}. Open LeakAudit
        in your Shopify Admin to take action on any leak above.
      </p>
    </div>
  `;
}

// Notifies you (the app builder) when a merchant leaves feedback in the
// app. Set SUPPORT_NOTIFICATION_EMAIL in .env to enable — without it,
// feedback is still saved to the database, it just won't also email you.
export async function sendFeedbackNotification(
  shop: string,
  message: string,
): Promise<SendAlertResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.SUPPORT_NOTIFICATION_EMAIL;
  if (!apiKey || !to) {
    return {
      sent: false,
      reason:
        "Not emailed (RESEND_API_KEY and/or SUPPORT_NOTIFICATION_EMAIL not set) — saved to the database only.",
    };
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: `LeakAudit feedback from ${shop}`,
    html: `<p><strong>${shop}</strong> sent this feedback:</p><p>${message.replace(/</g, "&lt;")}</p>`,
  });

  if (error) {
    return { sent: false, reason: error.message };
  }
  return { sent: true };
}

// Sends one alert email summarizing the given audit report. Returns
// {sent: false, reason} instead of throwing when there's no API key
// configured yet, so callers (e.g. a "Send Test Alert" button) can show a
// clear message rather than a crash.
export async function sendAuditAlertEmail(
  to: string,
  report: AuditReport,
): Promise<SendAlertResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      sent: false,
      reason:
        "RESEND_API_KEY is not set — add it to your .env file (see the Settings page) to enable sending.",
    };
  }
  if (!to) {
    return { sent: false, reason: "No notification email is configured yet." };
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject:
      report.totalMonthlyLeak > 0
        ? `LeakAudit: ${formatMoney(report.totalMonthlyLeak, report.currencyCode)}/mo in leaks found`
        : "LeakAudit: no leaks detected this week",
    html: reportToHtml(report),
  });

  if (error) {
    return { sent: false, reason: error.message };
  }
  return { sent: true };
}
