// Public, unauthenticated page — a basic terms-of-service draft. Not legal
// advice; have an actual lawyer review this before relying on it, especially
// once billing is turned on.
export default function Terms() {
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
      <h1>LeakAudit Terms of Service</h1>
      <p>
        <em>Last updated: draft — replace this date when you publish.</em>
      </p>

      <h2>The service</h2>
      <p>
        LeakAudit provides estimated, informational scans of your Shopify
        store&apos;s orders, products, and theme to surface potential sources of lost
        revenue. Estimates are based on the assumptions and thresholds you
        configure (or their defaults) and are provided for informational
        purposes only — they are not financial, accounting, or tax advice, and
        you should verify any figure before acting on it.
      </p>

      <h2>Your responsibilities</h2>
      <p>
        You&apos;re responsible for the accuracy of the settings you configure
        (target margin, shipping cost assumption) and for verifying that any
        changes you make in response to the App&apos;s suggestions are correct for
        your business.
      </p>

      <h2>Availability</h2>
      <p>
        We aim to keep the App available and accurate, but we don&apos;t guarantee
        uninterrupted access or that every estimate is error-free. The App is
        provided &quot;as is,&quot; without warranties of any kind.
      </p>

      <h2>Billing</h2>
      <p>
        [Fill in once billing is enabled: pricing, trial period, and
        cancellation terms.]
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms from time to time; continued use of the App
        after a change means you accept the updated terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms can be sent to:{" "}
        <strong>[add your support email here]</strong>.
      </p>
    </main>
  );
}
