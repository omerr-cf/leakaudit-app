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

- **Instant 60-second scan, zero setup.** Install and get a real, plain-English cash-leak
  report immediately — no CSV uploads, no manual configuration, no spreadsheets. LeakAudit
  reads directly from your live Shopify data the moment you open it.
- **Payment & FX fee drag.** Flags the estimated currency-conversion cost hiding in your
  cross-border and multi-currency orders over the last 30 days.
- **Leftover app script bloat.** Scans your live theme for known scripts left behind by
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

## Shopify App Store Search Keywords

```
profit tracker, net profit, fee audit, currency markup, app bloat, margin calculator, return rate, cost leak, shopify profit app
```

The first five are as specified by product; the last three (`margin calculator`,
`return rate`, `cost leak`, `shopify profit app`) are additions worth a second look before
finalizing, not yet confirmed against actual App Store keyword-competition data.
