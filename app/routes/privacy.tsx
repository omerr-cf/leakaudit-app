// Public, unauthenticated page — required for Shopify App Store submission
// (every listed app needs a reachable privacy policy URL). This is a
// DRAFT written to accurately describe what the app actually does today;
// have it reviewed before relying on it for a real launch.
export default function Privacy() {
  return (
    <main
      style={{
        maxWidth: "42rem",
        margin: "0 auto",
        padding: "3rem 1.5rem",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        lineHeight: 1.6,
        color: "#14181f",
      }}
    >
      <h1>LeakAudit Privacy Policy</h1>
      <p>
        <em>Last updated: draft — replace this date when you publish.</em>
      </p>

      <p>
        LeakAudit (&quot;the App&quot;) is a Shopify app that scans store data to identify
        potential sources of lost revenue. This policy explains what data the
        App accesses, why, and how it&apos;s handled.
      </p>

      <h2>What we access</h2>
      <p>The App requests read-only access to:</p>
      <ul>
        <li>
          <strong>Orders</strong> — order totals, currency, dates, and refund
          amounts, to estimate FX drag and return-rate trends. We do not access
          customer names, emails, addresses, or payment details.
        </li>
        <li>
          <strong>Products</strong> — prices, costs, and inventory levels, to
          identify SKUs selling below your target margin.
        </li>
        <li>
          <strong>Themes</strong> — your published theme&apos;s code, to detect
          leftover snippets from apps you may have uninstalled.
        </li>
        <li>
          <strong>Payouts</strong> — payment payout data, to estimate payment
          processing and currency-conversion costs.
        </li>
      </ul>
      <p>
        The App never writes to, modifies, or deletes anything in your store.
      </p>

      <h2>What we store</h2>
      <p>
        We store your shop domain, your app settings (shipping cost assumption,
        target margin, and an optional notification email you provide), your
        session token, and a history of past scan results (health score and
        estimated monthly leak amount) so we can show you a trend over time. We
        do not store customer personal data.
      </p>

      <h2>Data sharing</h2>
      <p>
        We do not sell or share your data with third parties. Data is used
        solely to power the App&apos;s own dashboard for your store.
      </p>

      <h2>Data retention and deletion</h2>
      <p>
        If you uninstall the App, your stored settings and scan history are
        deleted. You can request deletion of your data at any time by contacting
        us (see below) — this is also handled automatically via Shopify&apos;s
        mandatory GDPR compliance webhooks.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data can be sent to:{" "}
        <strong>[add your support email here]</strong>.
      </p>
    </main>
  );
}
