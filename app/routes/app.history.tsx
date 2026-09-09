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

interface SnapshotView {
  id: string;
  scannedAt: string;
  healthScore: number;
  totalMonthlyLeak: number;
  currencyCode: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // The table only ever shows the last 30 (now-deduplicated) snapshots,
  // but the "Total Money Recovered Since Install" ledger needs the TRUE
  // first-ever scan as its baseline — which may well have scrolled past
  // that 30-row window on a store that's been live a while — so it's
  // fetched separately rather than assumed to be `snapshots[snapshots.
  // length - 1]`.
  const [snapshots, firstSnapshot, latestSnapshot] = await Promise.all([
    db.auditSnapshot.findMany({
      where: { shop: session.shop },
      orderBy: { scannedAt: "desc" },
      take: 30,
    }),
    db.auditSnapshot.findFirst({
      where: { shop: session.shop },
      orderBy: { scannedAt: "asc" },
    }),
    db.auditSnapshot.findFirst({
      where: { shop: session.shop },
      orderBy: { scannedAt: "desc" },
    }),
  ]);

  const ledger =
    firstSnapshot && latestSnapshot
      ? {
          installedAt: firstSnapshot.scannedAt.toISOString(),
          recoveredMonthlyEstimate:
            Math.round(
              Math.max(
                0,
                firstSnapshot.totalMonthlyLeak -
                  latestSnapshot.totalMonthlyLeak,
              ) * 100,
            ) / 100,
          currencyCode: latestSnapshot.currencyCode,
        }
      : null;

  return {
    snapshots: snapshots.map((s) => ({
      id: s.id,
      scannedAt: s.scannedAt.toISOString(),
      healthScore: s.healthScore,
      totalMonthlyLeak: s.totalMonthlyLeak,
      currencyCode: s.currencyCode,
    })),
    ledger,
  };
};

type HistoryDisplayRow =
  | {
      type: "single";
      id: string;
      scannedAt: string;
      healthScore: number;
      totalMonthlyLeak: number;
      currencyCode: string;
      // null only for the very first recorded scan (nothing to compare to).
      leakDelta: number | null;
    }
  | {
      type: "collapsed";
      // Newest-first, so `to` is the most recent scan in the run and
      // `from` is the oldest — matches how the range reads left-to-right.
      fromScannedAt: string;
      toScannedAt: string;
      count: number;
      healthScore: number;
      totalMonthlyLeak: number;
      currencyCode: string;
    };

// snapshots is sorted newest-first (see the loader above). A run of 2+
// CONSECUTIVE scans that all show zero change (same health score, same
// total monthly leak as the scan right before them) collapses into a
// single summary row — "the merchant only sees meaningful milestones",
// not a dozen identical "No change" lines. A lone no-change scan (run
// length 1) still renders as its own normal row; only actual runs collapse.
export function buildHistoryDisplayRows(
  snapshots: SnapshotView[],
): HistoryDisplayRow[] {
  const rows: HistoryDisplayRow[] = [];
  let run: SnapshotView[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      const snap = run[0];
      rows.push({
        type: "single",
        id: snap.id,
        scannedAt: snap.scannedAt,
        healthScore: snap.healthScore,
        totalMonthlyLeak: snap.totalMonthlyLeak,
        currencyCode: snap.currencyCode,
        leakDelta: 0, // by construction, every run member is a "no change" row
      });
    } else {
      const newest = run[0];
      const oldest = run[run.length - 1];
      rows.push({
        type: "collapsed",
        fromScannedAt: oldest.scannedAt,
        toScannedAt: newest.scannedAt,
        count: run.length,
        healthScore: newest.healthScore,
        totalMonthlyLeak: newest.totalMonthlyLeak,
        currencyCode: newest.currencyCode,
      });
    }
    run = [];
  };

  snapshots.forEach((snap, i) => {
    // Chronologically-before neighbor — snapshots is newest-first, so
    // that's the NEXT item in the array.
    const previous = snapshots[i + 1];

    if (!previous) {
      // The very first recorded scan ever — always its own row, never
      // part of a collapsed run, and flushes whatever run preceded it.
      flushRun();
      rows.push({
        type: "single",
        id: snap.id,
        scannedAt: snap.scannedAt,
        healthScore: snap.healthScore,
        totalMonthlyLeak: snap.totalMonthlyLeak,
        currencyCode: snap.currencyCode,
        leakDelta: null,
      });
      return;
    }

    const leakDelta = snap.totalMonthlyLeak - previous.totalMonthlyLeak;
    const noChange =
      leakDelta === 0 && snap.healthScore === previous.healthScore;

    if (noChange) {
      run.push(snap);
    } else {
      flushRun();
      rows.push({
        type: "single",
        id: snap.id,
        scannedAt: snap.scannedAt,
        healthScore: snap.healthScore,
        totalMonthlyLeak: snap.totalMonthlyLeak,
        currencyCode: snap.currencyCode,
        leakDelta,
      });
    }
  });
  flushRun();

  return rows;
}

export default function History() {
  const { snapshots, ledger } = useLoaderData<typeof loader>();
  const displayRows = buildHistoryDisplayRows(snapshots);

  return (
    <s-page heading="Scan History">
      <s-button slot="primary-action" href="/app">
        Back to Home
      </s-button>

      {ledger && (
        <s-section heading="Total Money Recovered Since Install">
          {ledger.recoveredMonthlyEstimate > 0 ? (
            <s-banner
              tone="success"
              heading={`You have eliminated ${formatMoney(ledger.recoveredMonthlyEstimate, ledger.currencyCode)}/mo in margin leaks since installing LeakAudit`}
            >
              <s-paragraph>
                Based on your first scan (
                {new Date(ledger.installedAt).toLocaleDateString()}) compared to
                your most recent one.
              </s-paragraph>
            </s-banner>
          ) : (
            <s-paragraph color="subdued">
              Apply the recommended fixes to see your recovered profit
              accumulate here.
            </s-paragraph>
          )}
        </s-section>
      )}

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
              {displayRows.map((row) =>
                row.type === "collapsed" ? (
                  <s-table-row key={`collapsed-${row.toScannedAt}`}>
                    <s-table-cell>
                      {new Date(row.fromScannedAt).toLocaleDateString()} –{" "}
                      {new Date(row.toScannedAt).toLocaleDateString()}
                    </s-table-cell>
                    <s-table-cell>{row.healthScore}/100</s-table-cell>
                    <s-table-cell>
                      {formatMoney(row.totalMonthlyLeak, row.currencyCode)}/mo
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        No change across {row.count} scans
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                ) : (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      {new Date(row.scannedAt).toLocaleString()}
                    </s-table-cell>
                    <s-table-cell>{row.healthScore}/100</s-table-cell>
                    <s-table-cell>
                      {formatMoney(row.totalMonthlyLeak, row.currencyCode)}/mo
                    </s-table-cell>
                    <s-table-cell>
                      {row.leakDelta === null ? (
                        <s-text color="subdued">First recorded scan</s-text>
                      ) : row.leakDelta < 0 ? (
                        <s-text tone="success">
                          -
                          {formatMoney(
                            Math.abs(row.leakDelta),
                            row.currencyCode,
                          )}
                          /mo recovered
                        </s-text>
                      ) : row.leakDelta > 0 ? (
                        <s-text tone="critical">
                          +{formatMoney(row.leakDelta, row.currencyCode)}/mo
                          worse
                        </s-text>
                      ) : (
                        <s-text color="subdued">No change</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ),
              )}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
