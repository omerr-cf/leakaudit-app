import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <span className={styles.badge}>🎉 Founder Beta: 100% Free</span>

        <h1 className={styles.heading}>
          LeakAudit: 60-Second Profit &amp; Cost Leak Auditor for Shopify
        </h1>

        <p className={styles.text}>
          LeakAudit scans your orders, products, and theme the moment you
          install — no spreadsheets, no setup — and shows you exactly where
          FX fees, orphaned app scripts, negative-margin SKUs, and return
          drift are eating your profit.
        </p>

        {showForm && (
          <Form
            className={styles.form}
            method="post"
            action="/auth/login"
            reloadDocument
          >
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
              />
              <span className={styles.hint}>
                e.g. my-shop-domain.myshopify.com
              </span>
            </label>
            <button className={styles.button} type="submit">
              ⚡ Install Free Founder Beta
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>Instant, zero-setup scan.</strong> Install and get a
            plain-English cash-leak report in under a minute — nothing to
            upload, nothing to configure.
          </li>
          <li>
            <strong>4 leak types, one dashboard.</strong> Payment &amp; FX
            drag, leftover app scripts, negative-margin SKUs, and return-rate
            drift, each with a monthly dollar estimate.
          </li>
          <li>
            <strong>A weekly heads-up, not a homework assignment.</strong>
            Turn on alerts and we&apos;ll tell you the moment a new leak shows up
            — you don&apos;t have to keep checking.
          </li>
        </ul>

        <p className={styles.footerLink}>
          <a href="/about">See exactly how we calculate these numbers →</a>
        </p>
      </div>
    </div>
  );
}
