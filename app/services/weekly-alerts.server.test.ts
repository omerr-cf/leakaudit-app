import { describe, expect, it, vi } from "vitest";
import { runWeeklyAlerts, WEEK_MS, type DueShop, type WeeklyAlertDeps } from "./weekly-alerts.server";
import type { AuditReport } from "./audit.server";

const report = (shop: string): AuditReport => ({
  scannedAt: "2026-10-08T00:00:00Z",
  shopDomain: shop,
  currencyCode: "USD",
  totalMonthlyLeak: 90,
  healthScore: 85,
  leaks: [],
});
const shopRow = (shop: string, email: string | null = "a@b.com"): DueShop => ({
  shop,
  notificationEmail: email,
  shippingCostPerOrder: 5,
  targetMarginPercent: 20,
});

function deps(over: Partial<WeeklyAlertDeps> & { due: DueShop[] }): WeeklyAlertDeps {
  const { due, ...rest } = over;
  return {
    now: () => new Date("2026-10-08T12:00:00Z"),
    findDueShops: vi.fn(async () => due),
    getAdmin: vi.fn(async () => ({ admin: { graphql: vi.fn() } as never, fallbackEmail: async () => "shop@owner.com" })),
    audit: vi.fn(async (_a, shop) => report(shop)),
    send: vi.fn(async () => ({ sent: true })),
    markSent: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    ...rest,
  };
}

describe("runWeeklyAlerts", () => {
  it("asks for shops last alerted more than 7 days ago", async () => {
    const d = deps({ due: [] });
    await runWeeklyAlerts(d);
    expect(d.findDueShops).toHaveBeenCalledWith(new Date(new Date("2026-10-08T12:00:00Z").getTime() - WEEK_MS));
  });

  it("emails and marks each due shop", async () => {
    const d = deps({ due: [shopRow("a.myshopify.com"), shopRow("b.myshopify.com")] });
    const s = await runWeeklyAlerts(d);
    expect(s).toEqual({ due: 2, sent: 2, skipped: 0, failed: 0 });
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(d.markSent).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledTimes(1); // between shops, not before the first
  });

  it("skips uninstalled shops (no session) without emailing", async () => {
    const d = deps({ due: [shopRow("gone.myshopify.com")], getAdmin: vi.fn(async () => null) });
    const s = await runWeeklyAlerts(d);
    expect(s.skipped).toBe(1);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.markSent).not.toHaveBeenCalled();
  });

  it("falls back to the shop owner's email when none is saved", async () => {
    const d = deps({ due: [shopRow("a.myshopify.com", null)] });
    await runWeeklyAlerts(d);
    expect(d.send).toHaveBeenCalledWith("shop@owner.com", expect.anything());
  });

  it("does not mark a shop as sent when the email fails, and keeps going", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ sent: false, reason: "boom" })
      .mockResolvedValueOnce({ sent: true });
    const d = deps({ due: [shopRow("a.myshopify.com"), shopRow("b.myshopify.com")], send });
    const s = await runWeeklyAlerts(d);
    expect(s).toMatchObject({ sent: 1, failed: 1 });
    expect(d.markSent).toHaveBeenCalledTimes(1);
    expect(d.markSent).toHaveBeenCalledWith("b.myshopify.com", expect.any(Date));
  });

  it("one shop throwing does not stop the others", async () => {
    const audit = vi
      .fn()
      .mockRejectedValueOnce(new Error("api down"))
      .mockImplementationOnce(async (_a, shop: string) => report(shop));
    const d = deps({ due: [shopRow("a.myshopify.com"), shopRow("b.myshopify.com")], audit });
    const s = await runWeeklyAlerts(d);
    expect(s).toMatchObject({ sent: 1, failed: 1 });
  });
});
