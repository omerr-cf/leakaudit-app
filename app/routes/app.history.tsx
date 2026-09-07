import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// Same small/large split as the dashboard's formatMoney — tiny amounts
// (a few cents/agorot of margin drag) shouldn't round away to "$0".
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
    return `${amount.toFixed(decimals)} ${currencyCode}`;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const snapshots = await db.auditSnapshot.findMany({
    where: { shop: session.shop },
    orderBy: { scannedAt: "desc" },
    take: 30,
  });

  return {
    snapshots: snapshots.map((s) => ({
      id: s.id,
      scannedAt: s.scannedAt.toISOString(),
      healthScore: s.healthScore,
      totalMonthlyLeak: s.totalMonthlyLeak,
      currencyCode: s.currencyCode,
    })),
  };
};

export default function History() {
  const { snapshots } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Scan History">
      <s-button slot="primary-action" href="/app">
        Back to Home
      </s-button>

      <s-section heading="Every scan, and what changed since the one before it">
        {snapshots.length === 0 ? (
          <s-paragraph>
            No scans recorded yet — run a scan from the Home tab to start
            building your history.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Health Score</s-table-header>
              <s-table-header>Estimated Monthly Leak</s-table-header>
              <s-table-header>Change vs. Previous Scan</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {snapshots.map((snap, i) => {
                // snapshots is sorted newest-first, so the NEXT item in the
                // array is the scan immediately before this one.
                const previous = snapshots[i + 1];
                const leakDelta = previous
                  ? snap.totalMonthlyLeak - previous.totalMonthlyLeak
                  : null;

                return (
                  <s-table-row key={snap.id}>
                    <s-table-cell>
                      {new Date(snap.scannedAt).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>{snap.healthScore}/100</s-table-cell>
                    <s-table-cell>
                      {formatMoney(snap.totalMonthlyLeak, snap.currencyCode)}
                      /mo
                    </s-table-cell>
                    <s-table-cell>
                      {leakDelta === null ? (
                        <s-text color="subdued">First recorded scan</s-text>
                      ) : leakDelta < 0 ? (
                        <s-text tone="success">
                          -{formatMoney(Math.abs(leakDelta), snap.currencyCode)}
                          /mo recovered
                        </s-text>
                      ) : leakDelta > 0 ? (
                        <s-text tone="critical">
                          +{formatMoney(leakDelta, snap.currencyCode)}/mo worse
                        </s-text>
                      ) : (
                        <s-text color="subdued">No change</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
