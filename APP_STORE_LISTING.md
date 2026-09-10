# LeakAudit — Shopify App Store Listing Copy

Draft copy for the App Store listing form. Every feature claim below is grounded in what
`app/services/audit.server.ts` actually computes today — nothing here describes a
capability that isn't shipped. Cross-check current Shopify App Store review requirements
and field character limits against Shopify's Partner docs before submitting; those
requirements do change over time and haven't been independently re-verified here.

## App Title (max 30 characters)

```
LeakAudit: Profit & Cost Leaks
```

30 characters exactly — no room to spare if this is edited.

## Tagline (max 100 characters)

```
Find the FX fees, app bloat, bad-margin SKUs & returns quietly draining your profit.
```

84 characters.

## Key Features

- **Instant 60-second audit, zero setup.** Install and get a real, plain-English cash-leak
  report immediately — no CSV uploads, no manual configuration, no spreadsheets. LeakAudit
  reads directly from your live Shopify data the moment you open it.
- **Payment & FX fee drag.** Flags the estimated currency-conversion markup hiding in your
  cross-border and multi-currency orders over the last 30 days.
- **Theme script bloat.** Scans your live theme for known scripts left behind by
  apps you've already uninstalled — slowing your store down for no benefit.
- **Negative-margin SKU detector.** Surfaces exactly which product variants are losing you
  money on every sale, using your own cost, price, and shipping assumptions.
- **Return-rate drift alert.** Flags when your refund rate rises meaningfully above a
  healthy e-commerce benchmark, using your last 60 days of orders.
- **One-click fixes, not just numbers.** Every flagged leak deep-links straight into
  Shopify's own bulk editor or admin — pre-filtered to the exact offending SKUs or orders,
  so you can act immediately instead of hunting for them yourself.
- **100% read-only.** LeakAudit never writes to your store, your products, or your orders —
  it only reads what it needs to compute your numbers.

## Pricing

```
100% Free during Founder Beta
```

Structural claim, not yet customer-facing copy: the plan already configured in
`app/shopify.server.ts` (gated behind `BILLING_ENABLED`, currently off) is a
**flat $49/month** -- one price regardless of order volume, never a per-order
or per-order-count tier. That's the real differentiator vs. Lifetimely/
BeProfit-style volume-based pricing cliffs, but it isn't live yet (still
Founder Beta free), so it's noted here for when billing turns on -- don't
put a "$49/mo" claim in front of merchants while `BILLING_ENABLED` is off
and everything is actually free.

## Shopify App Store Search Keywords

```
profit tracker, net profit, fee audit, currency markup, currency conversion markup, app bloat, theme script bloat, margin calculator, return rate, cost leak, shopify profit app
```

Added `currency conversion markup` and `theme script bloat` per the 2026-09-10
ASO request -- both now also appear verbatim in the feature-bullet copy above
(see the FX and theme-script bullets), not just in this list.

Important caveat, checked before treating this list as an SEO lever: Shopify's
Partner Dashboard does not have a distinct submittable "keywords" or "search
terms" field the way Google Search Console or an App Store Connect listing
does. Shopify's own app-search relevance comes from whether a merchant's
search terms appear in the **app name, tagline, and feature/description
copy** that's actually shown to merchants -- not from a hidden metadata
field. So this list is an internal reference for which terms the visible
copy should contain, not a field to paste into Shopify's submission form
verbatim. That's also why `margin calculator` deliberately isn't forced into
the Negative-Margin SKU bullet below -- LeakAudit detects and flags
margin problems, it doesn't function as a manual calculator, and claiming
otherwise in a feature bullet risks a functionality mismatch during
Shopify's app review.

`margin calculator`, `return rate`, `cost leak`, `shopify profit app` are
additions worth a second look before finalizing, not yet confirmed against
actual App Store keyword-competition data.
