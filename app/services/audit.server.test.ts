import { describe, expect, it } from "vitest";
import {
  auditAppBloatLeak,
  auditNegativeMarginSkus,
  auditPaymentFxLeak,
  auditReturnRateDrift,
  computeHealthScore,
  daysAgoIso,
  DEFAULT_AUDIT_SETTINGS,
  errorLeak,
  insufficientData,
  numericId,
  round2,
  runAudit,
  type AdminGraphQLClient,
  type LeakResult,
} from "./audit.server";

// ---------------------------------------------------------------
// Test helper: a fake Shopify admin GraphQL client. Real behavior is
// "one query string in, one JSON response out" — this fake just looks at
// which query was sent (by a short, unique substring of its name) and
// hands back whatever canned response the test configured for it, so call
// order (which Promise.all does not guarantee) never matters.
// ---------------------------------------------------------------
function fakeAdmin(responses: Record<string, unknown>): AdminGraphQLClient {
  return {
    async graphql(query: string) {
      const match = Object.keys(responses).find((key) => query.includes(key));
      if (!match) {
        throw new Error(`fakeAdmin: no canned response for query: ${query}`);
      }
      return { json: async () => responses[match] };
    },
  };
}

describe("computeHealthScore", () => {
  const leak = (status: LeakResult["status"]): LeakResult => ({
    id: "fx_fees",
    title: "x",
    status,
    monthlyImpact: 0,
    headline: "",
    actionLabel: "",
    actionHref: "",
  });

  it("is 100 when nothing is leaking or erroring", () => {
    expect(computeHealthScore([leak("ok"), leak("insufficient_data")])).toBe(
      100,
    );
  });

  it("deducts 15 per leaking check", () => {
    expect(computeHealthScore([leak("leaking"), leak("ok")])).toBe(85);
  });

  it("deducts 5 per errored check", () => {
    expect(computeHealthScore([leak("error"), leak("ok")])).toBe(95);
  });

  it("never drops below 0", () => {
    const leaks = Array.from({ length: 10 }, () => leak("leaking"));
    expect(computeHealthScore(leaks)).toBe(0);
  });
});

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(3.14159)).toBe(3.14);
    expect(round2(10)).toBe(10);
    expect(round2(0.001)).toBe(0);
  });
});

describe("daysAgoIso", () => {
  it("returns an ISO date string (YYYY-MM-DD)", () => {
    expect(daysAgoIso(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("moves further back in time as the day count increases", () => {
    const today = daysAgoIso(0);
    const oneMonthAgo = daysAgoIso(30);
    const twoMonthsAgo = daysAgoIso(60);
    // ISO date strings sort lexicographically, so this also sorts
    // chronologically.
    expect(twoMonthsAgo < oneMonthAgo).toBe(true);
    expect(oneMonthAgo < today).toBe(true);
  });
});

describe("insufficientData", () => {
  it("builds a zero-impact, insufficient_data leak with the given message", () => {
    const leak = insufficientData("fx_fees", "Payment & FX Fee Drag", "hi");
    expect(leak.status).toBe("insufficient_data");
    expect(leak.monthlyImpact).toBe(0);
    expect(leak.headline).toBe("hi");
  });
});

describe("errorLeak", () => {
  it("captures a real Error's message", () => {
    const leak = errorLeak("fx_fees", "Payment & FX Fee Drag", new Error("boom"));
    expect(leak.status).toBe("error");
    expect(leak.details?.errorMessage).toBe("boom");
  });

  it("stringifies a non-Error thrown value instead of crashing", () => {
    const leak = errorLeak("fx_fees", "Payment & FX Fee Drag", "just a string");
    expect(leak.details?.errorMessage).toBe("just a string");
  });
});

describe("auditPaymentFxLeak", () => {
  it("reports insufficient_data with zero orders", async () => {
    const admin = fakeAdmin({ FxLeakOrders: { data: { orders: { edges: [] } } } });
    const result = await auditPaymentFxLeak(admin, "USD");
    expect(result.status).toBe("insufficient_data");
  });

  it("is ok when there's no meaningful cross-border revenue", async () => {
    const admin = fakeAdmin({
      FxLeakOrders: {
        data: {
          orders: {
            edges: [
              {
                node: {
                  id: "1",
                  createdAt: "2026-01-01",
                  presentmentCurrencyCode: "USD",
                  currentTotalPriceSet: { shopMoney: { amount: "100", currencyCode: "USD" } },
                },
              },
            ],
          },
        },
      },
    });
    const result = await auditPaymentFxLeak(admin, "USD");
    expect(result.status).toBe("ok");
  });

  it("flags leaking when cross-border revenue is high enough", async () => {
    const admin = fakeAdmin({
      FxLeakOrders: {
        data: {
          orders: {
            edges: [
              {
                node: {
                  id: "1",
                  createdAt: "2026-01-01",
                  presentmentCurrencyCode: "EUR",
                  currentTotalPriceSet: { shopMoney: { amount: "1000", currencyCode: "USD" } },
                },
              },
            ],
          },
        },
      },
    });
    const result = await auditPaymentFxLeak(admin, "USD");
    // 1000 * 1.8% = 18, comfortably above the $1 "leaking" threshold.
    expect(result.status).toBe("leaking");
    expect(result.monthlyImpact).toBe(18);
  });
});

describe("auditAppBloatLeak", () => {
  it("reports insufficient_data when the theme can't be read", async () => {
    const admin = fakeAdmin({
      ActiveThemeAsset: { data: { themes: { nodes: [] } } },
    });
    const result = await auditAppBloatLeak(admin);
    expect(result.status).toBe("insufficient_data");
  });

  it("is ok when no known orphan signatures are found", async () => {
    const admin = fakeAdmin({
      ActiveThemeAsset: {
        data: {
          themes: {
            nodes: [
              {
                id: "1",
                name: "Dawn",
                files: { nodes: [{ filename: "layout/theme.liquid", body: { content: "<html></html>" } }] },
              },
            ],
          },
        },
      },
    });
    const result = await auditAppBloatLeak(admin);
    expect(result.status).toBe("ok");
  });

  it("flags leaking when a known orphan app signature is present", async () => {
    const admin = fakeAdmin({
      ActiveThemeAsset: {
        data: {
          themes: {
            nodes: [
              {
                id: "1",
                name: "Dawn",
                files: {
                  nodes: [
                    {
                      filename: "layout/theme.liquid",
                      body: { content: "<!-- klaviyo onsite tracking -->" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const result = await auditAppBloatLeak(admin);
    expect(result.status).toBe("leaking");
    expect(result.monthlyImpact).toBe(45);
  });
});

describe("auditNegativeMarginSkus", () => {
  it("reports insufficient_data with no in-stock variants", async () => {
    const admin = fakeAdmin({ MarginVariants: { data: { productVariants: { edges: [] } } } });
    const result = await auditNegativeMarginSkus(admin, DEFAULT_AUDIT_SETTINGS);
    expect(result.status).toBe("insufficient_data");
  });

  it("flags a SKU priced below the target margin after shipping", async () => {
    const admin = fakeAdmin({
      MarginVariants: {
        data: {
          productVariants: {
            edges: [
              {
                node: {
                  id: "v1",
                  title: "Default",
                  price: "20.00",
                  product: { title: "Widget" },
                  inventoryItem: { unitCost: { amount: "16.00" } },
                },
              },
            ],
          },
        },
      },
    });
    // price 20, cost 16, shipping 5 -> net margin = -1 -> -5%, well under 20%.
    const result = await auditNegativeMarginSkus(admin, DEFAULT_AUDIT_SETTINGS);
    expect(result.status).toBe("leaking");
  });

  it("is ok when every costed SKU clears the target margin", async () => {
    const admin = fakeAdmin({
      MarginVariants: {
        data: {
          productVariants: {
            edges: [
              {
                node: {
                  id: "v1",
                  title: "Default",
                  price: "100.00",
                  product: { title: "Widget" },
                  inventoryItem: { unitCost: { amount: "20.00" } },
                },
              },
            ],
          },
        },
      },
    });
    // price 100, cost 20, shipping 5 -> net margin = 75 -> 75%, well above 20%.
    const result = await auditNegativeMarginSkus(admin, DEFAULT_AUDIT_SETTINGS);
    expect(result.status).toBe("ok");
  });
});

describe("auditReturnRateDrift", () => {
  function orderNode(id: string, refunded: number) {
    return {
      node: {
        id,
        currentTotalPriceSet: { shopMoney: { amount: "100" } },
        refunds: refunded > 0 ? [{ totalRefundedSet: { shopMoney: { amount: String(refunded) } } }] : [],
      },
    };
  }

  it("reports insufficient_data with fewer than 5 orders", async () => {
    const admin = fakeAdmin({
      RefundLeakOrders: {
        data: { orders: { edges: [orderNode("1", 0), orderNode("2", 0)] } },
      },
    });
    const result = await auditReturnRateDrift(admin);
    expect(result.status).toBe("insufficient_data");
  });

  it("is ok when the return rate is within the benchmark", async () => {
    const admin = fakeAdmin({
      RefundLeakOrders: {
        data: {
          orders: {
            edges: [
              orderNode("1", 0),
              orderNode("2", 0),
              orderNode("3", 0),
              orderNode("4", 0),
              orderNode("5", 0),
            ],
          },
        },
      },
    });
    const result = await auditReturnRateDrift(admin);
    expect(result.status).toBe("ok");
  });

  it("flags leaking when the return rate is well above the benchmark", async () => {
    const admin = fakeAdmin({
      RefundLeakOrders: {
        data: {
          orders: {
            edges: [
              orderNode("1", 100),
              orderNode("2", 0),
              orderNode("3", 0),
              orderNode("4", 0),
              orderNode("5", 0),
            ],
          },
        },
      },
    });
    // 1 refund out of 5 orders = 20% return rate, vs. the 8% benchmark.
    const result = await auditReturnRateDrift(admin);
    expect(result.status).toBe("leaking");
  });
});

describe("runAudit", () => {
  it("combines all 4 checks into one report with a perfect health score when everything's healthy", async () => {
    const admin = fakeAdmin({
      ShopCurrency: { data: { shop: { currencyCode: "USD" } } },
      FxLeakOrders: { data: { orders: { edges: [] } } },
      ActiveThemeAsset: { data: { themes: { nodes: [] } } },
      MarginVariants: { data: { productVariants: { edges: [] } } },
      RefundLeakOrders: { data: { orders: { edges: [] } } },
    });
    const report = await runAudit(admin, "test-shop.myshopify.com");
    expect(report.leaks).toHaveLength(4);
    expect(report.healthScore).toBe(100);
    expect(report.totalMonthlyLeak).toBe(0);
    expect(report.currencyCode).toBe("USD");
  });

  it("surfaces a query failure as an 'error' leak instead of throwing", async () => {
    const admin: AdminGraphQLClient = {
      async graphql(query: string) {
        if (query.includes("FxLeakOrders")) {
          throw new Error("simulated network failure");
        }
        if (query.includes("ShopCurrency")) {
          return { json: async () => ({ data: { shop: { currencyCode: "USD" } } }) };
        }
        return { json: async () => ({ data: {} }) };
      },
    };
    const report = await runAudit(admin, "test-shop.myshopify.com");
    const fxLeak = report.leaks.find((l) => l.id === "fx_fees");
    expect(fxLeak?.status).toBe("error");
    expect(fxLeak?.details?.errorMessage).toBe("simulated network failure");
  });
});

describe("numericId", () => {
  it("extracts the trailing numeric id from a Shopify GID", () => {
    expect(numericId("gid://shopify/Product/123456789")).toBe("123456789");
    expect(numericId("gid://shopify/Order/1")).toBe("1");
  });

  it("returns null for undefined or a GID with no trailing digits", () => {
    expect(numericId(undefined)).toBeNull();
    expect(numericId("gid://shopify/Product/")).toBeNull();
  });
});

describe("insufficientData default action", () => {
  it("falls back to a 'Learn More' / '#' action when none is given", () => {
    const leak = insufficientData("fx_fees", "Payment & FX Fee Drag", "hi");
    expect(leak.actionLabel).toBe("Learn More");
    expect(leak.actionHref).toBe("#");
  });

  it("uses the provided action label and href when given", () => {
    const leak = insufficientData("fx_fees", "Payment & FX Fee Drag", "hi", {
      label: "View Orders",
      href: "/orders",
    });
    expect(leak.actionLabel).toBe("View Orders");
    expect(leak.actionHref).toBe("/orders");
  });
});

describe("errorLeak shape", () => {
  it("always routes 'Retry' to a dead href — the UI supplies the real retry handler", () => {
    const leak = errorLeak("fx_fees", "Payment & FX Fee Drag", new Error("boom"));
    expect(leak.actionLabel).toBe("Retry");
    expect(leak.actionHref).toBe("#");
    expect(leak.monthlyImpact).toBe(0);
  });
});

describe("auditPaymentFxLeak — boundary cases", () => {
  it("is 'ok', not 'leaking', just under the $1/mo threshold", async () => {
    // 55.55 * 1.8% = 0.9999, just under the ">1" leaking cutoff.
    const admin = fakeAdmin({
      FxLeakOrders: {
        data: {
          orders: {
            edges: [
              {
                node: {
                  id: "1",
                  createdAt: "2026-01-01",
                  presentmentCurrencyCode: "EUR",
                  currentTotalPriceSet: {
                    shopMoney: { amount: "55.55", currencyCode: "USD" },
                  },
                },
              },
            ],
          },
        },
      },
    });
    const result = await auditPaymentFxLeak(admin, "USD");
    expect(result.monthlyImpact).toBeLessThanOrEqual(1);
    expect(result.status).toBe("ok");
  });

  it("does not divide by zero when total revenue is 0", async () => {
    const admin = fakeAdmin({
      FxLeakOrders: {
        data: {
          orders: {
            edges: [
              {
                node: {
                  id: "1",
                  createdAt: "2026-01-01",
                  presentmentCurrencyCode: "EUR",
                  currentTotalPriceSet: { shopMoney: { amount: "0", currencyCode: "USD" } },
                },
              },
            ],
          },
        },
      },
    });
    const result = await auditPaymentFxLeak(admin, "USD");
    expect(result.status).toBe("ok");
    expect(Number.isFinite(result.monthlyImpact)).toBe(true);
  });
});

describe("auditNegativeMarginSkus — offender list details", () => {
  function variantNode(id: string, price: string, cost: string, productId?: string) {
    return {
      node: {
        id,
        title: "Default",
        price,
        product: { title: `Product ${id}`, ...(productId ? { id: productId } : {}) },
        inventoryItem: { unitCost: { amount: cost } },
      },
    };
  }

  it("truncates worstOffenders to 5 in details even when more SKUs are leaking", async () => {
    const edges = Array.from({ length: 8 }, (_, i) =>
      variantNode(`v${i}`, "20.00", "16.00", `gid://shopify/Product/${i}`),
    );
    const admin = fakeAdmin({
      MarginVariants: { data: { productVariants: { edges } } },
    });
    const result = await auditNegativeMarginSkus(admin, DEFAULT_AUDIT_SETTINGS);
    expect(result.status).toBe("leaking");
    expect(result.headline).toContain("8 SKUs");
    const details = result.details as { worstOffenders: unknown[] };
    expect(details.worstOffenders).toHaveLength(5);
  });

  it("gives a null actionHref when the product id can't be extracted", async () => {
    const admin = fakeAdmin({
      MarginVariants: {
        data: { productVariants: { edges: [variantNode("v1", "20.00", "16.00")] } },
      },
    });
    const result = await auditNegativeMarginSkus(admin, DEFAULT_AUDIT_SETTINGS);
    const details = result.details as { worstOffenders: { actionHref: string | null }[] };
    expect(details.worstOffenders[0].actionHref).toBeNull();
  });
});

describe("auditReturnRateDrift — boundary cases", () => {
  function orderNode(id: string, refunded: number) {
    return {
      node: {
        id,
        currentTotalPriceSet: { shopMoney: { amount: "100" } },
        refunds: refunded > 0 ? [{ totalRefundedSet: { shopMoney: { amount: String(refunded) } } }] : [],
      },
    };
  }

  it("is 'ok' exactly AT the return-rate benchmark (8%)", async () => {
    // 2 refunded out of 25 orders = 8.0% exactly -> drift == 0
    const edges = [
      orderNode("1", 50),
      orderNode("2", 50),
      ...Array.from({ length: 23 }, (_, i) => orderNode(`ok${i}`, 0)),
    ];
    const admin = fakeAdmin({ RefundLeakOrders: { data: { orders: { edges } } } });
    const result = await auditReturnRateDrift(admin);
    expect(result.status).toBe("ok");
  });

  it("caps refundedOrders detail list at 5 even with more refunded orders", async () => {
    const edges = Array.from({ length: 10 }, (_, i) => orderNode(`r${i}`, 20));
    const admin = fakeAdmin({ RefundLeakOrders: { data: { orders: { edges } } } });
    const result = await auditReturnRateDrift(admin);
    expect(result.status).toBe("leaking");
    const details = result.details as { refundedOrders: unknown[] };
    expect(details.refundedOrders).toHaveLength(5);
  });
});

describe("auditAppBloatLeak — multiple matches", () => {
  it("adds up $45/mo per distinct orphan signature found", async () => {
    const admin = fakeAdmin({
      ActiveThemeAsset: {
        data: {
          themes: {
            nodes: [
              {
                id: "1",
                name: "Dawn",
                files: {
                  nodes: [
                    {
                      filename: "layout/theme.liquid",
                      body: { content: "<!-- klaviyo --><!-- loox.io --><!-- privy -->" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const result = await auditAppBloatLeak(admin);
    expect(result.status).toBe("leaking");
    expect(result.monthlyImpact).toBe(135); // 3 signatures * $45
    const details = result.details as { matches: string[] };
    expect(details.matches).toHaveLength(3);
  });
});

