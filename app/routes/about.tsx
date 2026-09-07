// Public, unauthenticated page explaining exactly how LeakAudit computes
// its numbers — for trust/transparency. Keep this in sync with the real
// constants in app/services/audit.server.ts whenever those change.
export default function About() {
  return (
    <main
      style={{
        maxWidth: "44rem",
        margin: "0 auto",
        padding: "3rem 1.5rem",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        lineHeight: 1.65,
        color: "#14181f",
      }}
    >
      <h1>How LeakAudit calculates its numbers</h1>
      <p>
        LeakAudit runs four independent checks against your store's real
        Shopify data every time you scan. Every number below comes from a
        documented, fixed formula — never a guess, and never anything made
        up to look impressive. Here's exactly how each one works, including
        the assumptions baked in, so you can judge for yourself how much to
        trust it.
      </p>

      <h2>1. Payment &amp; FX Fee Drag</h2>
      <p>
        We look at your last 30 days of orders and add up the ones placed in
        a currency different from your store's own (a "foreign presentment
        currency"). We estimate a <strong>1.8% conversion drag</strong> on
        that revenue — a conservative industry rule of thumb for the
        combined cost of currency conversion and cross-border card fees.
        That's it: cross-border revenue × 1.8% = the monthly estimate you
        see. We don't yet read your actual payment gateway's fee schedule,
        so treat this as a directional estimate, not an invoice-accurate
        figure.
      </p>

      <h2>2. Leftover App Script Bloat</h2>
      <p>
        We read your live theme's code and check it against a short list of
        known snippets left behind by popular apps (review widgets, popups,
        tracking scripts, and similar) after a merchant uninstalls the app
        but the leftover code stays in the theme. Each match found is
        estimated at a flat <strong>$45/month</strong> — a placeholder cost
        representing typical page-speed and conversion drag from unused
        third-party scripts, not a measurement of your specific traffic yet.
      </p>

      <h2>3. Negative-Margin SKUs</h2>
      <p>
        For every in-stock product variant that has a cost-per-item set, we
        calculate: <code>price − cost − your shipping assumption</code>. If
        that's below your target margin percentage (both configurable in
        Settings — default $5.00 shipping, 20% target margin), the SKU is
        flagged. The monthly impact assumes roughly 3 units sold per month
        for each flagged SKU — a placeholder until real per-SKU sales
        velocity is wired in, so treat the dollar figure as directional and
        the flagged SKU list itself as the reliable part.
      </p>

      <h2>4. Return Rate Drift</h2>
      <p>
        We look at your last 60 days of orders and calculate what share of
        them received any refund. We compare that to an{" "}
        <strong>8% benchmark</strong> (a commonly cited average return rate
        for general e-commerce). If your rate is meaningfully above that,
        we estimate the monthly cost from your actual refunded amounts,
        scaled to a 30-day figure. We need at least 5 orders in the window
        to compute a rate we're willing to show you — fewer than that, and
        we tell you honestly that there isn't enough data yet rather than
        showing a misleading percentage.
      </p>

      <h2>Your Health Score</h2>
      <p>
        Starts at 100. Each check that's actively "Leaking" costs 15 points;
        each check that hit an error (couldn't complete, usually a
        permissions or connectivity issue on our end) costs 5 points. A
        check that just needs more setup or data doesn't cost you anything —
        we don't penalize you for us not having enough information yet.
      </p>

      <h2>What we don't do</h2>
      <p>
        We never estimate a number we can't trace back to a formula like the
        ones above. We don't use AI or machine-learning "black box"
        predictions for any of these figures. Every check either has enough
        real data to compute a real number, or it tells you plainly that it
        doesn't yet.
      </p>
    </main>
  );
}
