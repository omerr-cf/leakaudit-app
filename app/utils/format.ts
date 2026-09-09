import type { LeakResult } from "../services/audit.server";

// Shared formatting/label helpers used by both the dashboard (app._index.tsx)
// and the QA Diagnostics panel (app.settings.tsx) — pulled out here so the
// two don't drift out of sync with two separate copies.

// Format in the SHOP's own currency (not hardcoded $) — see audit.server.ts
// for why this matters for any non-USD merchant.
// Small leaks (a few cents/agorot of margin drag) used to round away to
// "$0", which read as broken. Amounts under 10 units keep 2 decimals;
// anything bigger rounds to whole units so large totals stay clean.
export function formatMoney(amount: number, currencyCode: string): string {
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

export function toneFor(
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

export function badgeLabel(status: LeakResult["status"]) {
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

export function healthTone(score: number): "critical" | "warning" | "success" {
  if (score >= 90) return "success";
  if (score >= 70) return "warning";
  return "critical";
}
