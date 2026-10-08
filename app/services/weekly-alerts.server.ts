import { runAudit, type AdminGraphQLClient, type AuditReport } from "./audit.server";
import { sendAuditAlertEmail, type SendAlertResult } from "./email.server";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000; // check for due shops once an hour
const FIRST_TICK_DELAY_MS = 2 * 60 * 1000; // let the server finish booting first
const BETWEEN_SHOPS_MS = 2000; // be gentle with Shopify API limits

export interface DueShop {
  shop: string;
  notificationEmail: string | null;
  shippingCostPerOrder: number;
  targetMarginPercent: number;
}

// Everything the job touches from the outside world is injected, so the
// logic below is unit-testable without a database, Shopify or Resend.
export interface WeeklyAlertDeps {
  now: () => Date;
  findDueShops: (dueBefore: Date) => Promise<DueShop[]>;
  getAdmin: (
    shop: string,
  ) => Promise<{ admin: AdminGraphQLClient; fallbackEmail: () => Promise<string> } | null>;
  audit: (admin: AdminGraphQLClient, shop: string, s: DueShop) => Promise<AuditReport>;
  send: (to: string, report: AuditReport) => Promise<SendAlertResult>;
  markSent: (shop: string, at: Date) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface WeeklyAlertSummary {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runWeeklyAlerts(deps: WeeklyAlertDeps): Promise<WeeklyAlertSummary> {
  const now = deps.now();
  const due = await deps.findDueShops(new Date(now.getTime() - WEEK_MS));
  const summary: WeeklyAlertSummary = { due: due.length, sent: 0, skipped: 0, failed: 0 };

  for (const [i, s] of due.entries()) {
    if (i > 0) await deps.sleep(BETWEEN_SHOPS_MS);
    try {
      const ctx = await deps.getAdmin(s.shop);
      if (!ctx) {
        // No offline session = the app was uninstalled. Nothing to scan.
        summary.skipped++;
        continue;
      }
      const to = s.notificationEmail?.trim() || (await ctx.fallbackEmail());
      if (!to) {
        summary.skipped++;
        deps.log(`[weekly-alerts] ${s.shop}: no recipient email, skipped`);
        continue;
      }
      const report = await deps.audit(ctx.admin, s.shop, s);
      const result = await deps.send(to, report);
      if (!result.sent) {
        summary.failed++;
        deps.log(`[weekly-alerts] ${s.shop}: email not sent: ${result.reason}`);
        continue; // not marked, so the next hourly tick retries
      }
      await deps.markSent(s.shop, deps.now());
      summary.sent++;
    } catch (err) {
      summary.failed++;
      deps.log(`[weekly-alerts] ${s.shop}: failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

const SHOP_EMAIL_QUERY = `#graphql
  query ShopEmail { shop { email } }
`;

async function realDeps(): Promise<WeeklyAlertDeps> {
  // Imported lazily so this file stays importable in unit tests without
  // booting the Shopify app object or the Prisma client.
  const { unauthenticated } = await import("../shopify.server");
  const { default: db } = await import("../db.server");
  return {
    now: () => new Date(),
    findDueShops: async (dueBefore) => {
      const rows = await db.shopSettings.findMany({
        where: {
          weeklyAlertEnabled: true,
          OR: [{ lastWeeklyAlertAt: null }, { lastWeeklyAlertAt: { lte: dueBefore } }],
        },
      });
      return rows.map((r) => ({
        shop: r.shop,
        notificationEmail: r.notificationEmail,
        shippingCostPerOrder: r.shippingCostPerOrder,
        targetMarginPercent: r.targetMarginPercent,
      }));
    },
    getAdmin: async (shop) => {
      const hasSession = await db.session.findFirst({ where: { shop, isOnline: false } });
      if (!hasSession) return null;
      const { admin } = await unauthenticated.admin(shop);
      return {
        admin: admin as unknown as AdminGraphQLClient,
        fallbackEmail: async () => {
          const res = await admin.graphql(SHOP_EMAIL_QUERY);
          const data = (await res.json()) as { data?: { shop?: { email?: string } } };
          return data.data?.shop?.email ?? "";
        },
      };
    },
    audit: (admin, shop, s) =>
      runAudit(admin, shop, {
        shippingCostPerOrder: s.shippingCostPerOrder,
        targetMarginPercent: s.targetMarginPercent,
      }),
    send: sendAuditAlertEmail,
    markSent: async (shop, at) => {
      await db.shopSettings.update({ where: { shop }, data: { lastWeeklyAlertAt: at } });
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __leakauditWeeklySchedulerStarted: boolean | undefined;
}

// Starts the in-process weekly scheduler. Safe to call more than once (only
// the first call does anything). Runs on the single always-on Fly machine;
// set WEEKLY_ALERTS_ENABLED=false in the environment to switch it off.
export function startWeeklyAlertScheduler(): void {
  if (globalThis.__leakauditWeeklySchedulerStarted) return;
  if (process.env.WEEKLY_ALERTS_ENABLED === "false") return;
  if (process.env.NODE_ENV !== "production") return; // never email from local dev
  globalThis.__leakauditWeeklySchedulerStarted = true;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const deps = await realDeps();
      const s = await runWeeklyAlerts(deps);
      if (s.due > 0) console.log(`[weekly-alerts] due=${s.due} sent=${s.sent} skipped=${s.skipped} failed=${s.failed}`);
    } catch (err) {
      console.error("[weekly-alerts] tick failed:", err);
    } finally {
      running = false;
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), TICK_MS).unref();
  }, FIRST_TICK_DELAY_MS).unref();
  console.log("[weekly-alerts] scheduler started");
}
