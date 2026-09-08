# LeakAudit — Release Checklist

**Status:** Pre-beta / pre-deployment
**Last updated:** 2026-09-07
**Scope:** This document is the single source of truth for what LeakAudit actually does today, what must be verified before real merchants touch it, how to test it, and the launch/monetization plan. It replaces informal notes with values pulled directly from the current codebase (`app/services/audit.server.ts`, `app/shopify.server.ts`, `app/routes/app*.tsx`).

> A note on an earlier draft of this checklist: a version of this document was drafted externally (by another AI) before this one. Several of its claims didn't match the actual code — most importantly, it implied GraphQL rate-limiting is handled (it isn't) and used a slightly wrong framing for the FX check (it's an *estimate*, not a real fee lookup). This version corrects those points and is grounded in the real source.

---

## 1. Core Value & Leak Calculation Engine

LeakAudit runs 4 independent checks against a store's live Shopify Admin data. Each check returns one of three statuses: `ok`, `leaking`, or `insufficient_data` (or `error` if the query itself fails). The dashboard's Health Score is:

```
healthScore = max(0, 100 − 15 × (# checks leaking) − 5 × (# checks in error))
```

Below is the exact math and data source for each.

### 1.1 Payment / FX Drag Leak

**What it measures:** an *estimate* of the markup a store likely absorbs on cross-border/multi-currency orders. This is not a real-time fee lookup against Shopify Payments' actual FX rate (Shopify does not expose that per-order) — it's a benchmark-based proxy, and the About/methodology page says so explicitly.

- **Data source:** Shopify Admin GraphQL, `orders(first: 250)` over the **last 30 days**, selecting `totalPriceSet` and `presentmentCurrencyCode` per order plus the shop's own currency.
- **Formula:**
  ```
  crossBorderRevenue = Σ order.total   for every order where presentmentCurrencyCode ≠ shopCurrencyCode
  monthlyImpact = crossBorderRevenue × 0.018   (FX_MARKUP_ESTIMATE = 1.8%)
  status = "leaking" if monthlyImpact > $1.00, else "ok"
  ```
- **Insufficient data:** 0 orders in the 30-day window.
- **Suggested action:** "Review FX Routing" → deep-links to `/settings/payments`.

### 1.2 Negative-Margin SKU Leak

**What it measures:** product variants that are losing money once landed cost and a flat shipping allowance are subtracted from price.

- **Data source:** Shopify Admin GraphQL, `productVariants(first: 250, query: "inventory_quantity:>0")`, selecting `price` and `inventoryItem.unitCost.amount`.
- **Formula (per variant):**
  ```
  netMargin     = price − unitCost − shippingCostPerOrder     (shippingCostPerOrder default = $5.00)
  marginPercent = (netMargin / price) × 100
  offender if marginPercent < targetMarginPercent              (default = 20%)
  monthlyImpact = Σ max(0, −netMargin) × 3     ← placeholder velocity multiplier, NOT real sales-per-SKU data
  ```
  Worst 5 offenders (lowest `marginPercent`) are surfaced in the detail modal.
- **Insufficient data:** 0 in-stock variants, or 0 variants have a cost set at all (`unitCost.amount` empty — this is common on stores that never filled in "Cost per item").
- **Suggested action:** "Set Cost Per Item" → deep-links to the bulk variant editor: `/bulk?resource_name=ProductVariant&edit=price,inventory_item.cost`.
- **Known limitation to disclose honestly:** the ×3 velocity multiplier is a flat placeholder, not units-sold. It should be called an *estimate* in any merchant-facing copy, not a precise number. Actual sales velocity per SKU (via `orders`/`lineItems`) is a good v1.1 improvement, not required for beta.

### 1.3 Script / App Bloat Leak

**What it measures:** leftover third-party app script tags still injected into the theme after the merchant uninstalled the app — pure cost with zero benefit.

- **Data source:** Shopify Admin GraphQL, `themes(first: 5, roles: [MAIN])`, then fetches `layout/theme.liquid` asset content for the main theme.
- **Formula:**
  ```
  found = theme.liquid content matched against 7 known "orphan" signatures
          (judge.me, Loox, Klaviyo, Privy, AfterShip, Wheelio, Rebuy)
  monthlyImpact = found.length × $45          (flat per-orphan estimate, not each app's real price)
  status = "leaking" if found.length > 0, else "ok"
  ```
- **Suggested action:** "Clean Leftover Scripts" → deep-links to `/themes/current/editor`.
- **Known limitation:** this only checks 7 known signatures via regex against the main theme's `theme.liquid`. It will miss orphaned scripts injected via theme app extensions/app blocks (the modern Shopify 2.0 method), custom snippets, or apps not on the known list. This is a deliberate, disclosed v1 scope limit — not a bug — but it should be stated plainly in merchant-facing copy ("checks for common leftover scripts," not "detects all bloat").

### 1.4 Return-Rate Drift Leak

**What it measures:** whether a store's refund rate has drifted meaningfully above a normal benchmark.

- **Data source:** Shopify Admin GraphQL, `orders(first: 250)` over the **last 60 days**, checking each order's refund status and `totalRefundedSet`.
- **Formula:**
  ```
  returnRate = refundedOrderCount / totalOrders
  drift = returnRate − 0.08                    (RETURN_RATE_BENCHMARK = 8%)
  status = "leaking" if drift > 0.01 (i.e. return rate > 9%), else "ok"
  monthlyImpact = totalRefundedAmount × (30 / 60)     when leaking, else $0
  ```
  Up to 5 refunded orders are listed in the detail modal.
- **Insufficient data:** fewer than 5 orders in the 60-day window.
- **Suggested action:** "Investigate Return Drivers" → deep-links to `/orders`.

---

## 2. Pre-Launch Verification Checklist

| Area | What to verify | Current status |
|---|---|---|
| **OAuth flow** | App installs cleanly on a fresh dev store; session token issued and refreshed without manual code. | ✅ Verified live on Fly.io (Sep 7): `GET /auth?shop=...` returns a clean 200 and correctly redirects into the embedded Shopify Admin frame (`admin.shopify.com/store/leakaudit-test-store/apps/leakaudit-app`). ⚠️ Found and fixed one real bug during this check: the standalone `/auth/login` page (manual "type your shop domain" form) threw `Error: Bad Request` on submit — React Router's single-fetch data protocol can't carry the cross-origin redirect that `shopify.login()` throws. Fixed by adding `reloadDocument` to the `<Form>` in `app/routes/auth.login/route.tsx` (forces a real full-page POST instead of a client-side fetch) — **this fix is committed to disk but not yet deployed; run `fly deploy` to ship it.** ❓ Still needs a real-browser check: the embedded dashboard content area appeared blank when loaded through an automated browser session — unclear yet if that is a genuine bug or a browser-automation artifact. Open the app from the dev store in your own normal Chrome window and confirm the dashboard actually renders before checking this row off. |
| **GraphQL rate limits** | Confirm the app degrades gracefully if Shopify throttles a request. | ⚠️ **Not implemented.** All 4 audit queries (`FX_QUERY`, `THEME_QUERY`, `VARIANTS_QUERY`, `REFUNDS_QUERY`) fetch `first: 250` with no `THROTTLED`-error retry/backoff and no pagination past 250 records. On a store with >250 orders or variants in the lookback window, the audit will silently look at only the first 250 (understating impact) rather than erroring. This is an honest, currently-open gap — acceptable for a small private beta of low-to-mid-volume stores, but should be fixed (basic cost-aware retry + pagination) before any paid/high-volume rollout. |
| **Prisma / SQLite persistence** | Data survives deploys and restarts. | Locally, `DATABASE_URL="file:dev.sqlite"`. **On Fly.io this must point at the mounted volume**, e.g. `DATABASE_URL="file:/data/prod.sqlite"` set as a `fly secrets set` value — the container filesystem outside `/data` is wiped on every deploy/restart. Confirm the volume is mounted (`fly volumes create leakaudit_data`) and `DATABASE_URL` is set to the volume path *before* the first production deploy, and that migrations are applied against that same path (`npx prisma migrate deploy` in a release step or on boot). |
| **Billing toggle** | Beta stores are never charged; toggling billing on works cleanly. | `BILLING_ENABLED` (default off) and `BILLING_TEST_MODE` (default **on**, i.e. safe/non-charging) are read in `app/shopify.server.ts` / `app/routes/app.tsx`. Billing plan config (`LeakAudit Pro Plan`, $49/30 days, 14-day trial) is always present in the `shopifyApp()` config regardless of the flag — only whether `billing.require()` is actually *called* is gated. Verify: with `BILLING_ENABLED=false` the "Founder Beta: Free Lifetime Access" badge shows and no billing screen ever appears; with `BILLING_ENABLED=true` + `BILLING_TEST_MODE=true`, installing triggers a Shopify test (non-charging) approval screen. |
| **Review banner dismissal** | Dismissal/snooze persists per shop, not per browser. | Stored server-side on `ShopSettings.reviewBannerDismissedAt` / `reviewBannerRemindAt` (Prisma/SQLite) — deliberately not `localStorage`, since embedded Admin can be opened from different browsers/devices for the same shop. Verify: dismiss or snooze the banner, reload from a different browser session, confirm it stays hidden (or reappears only after the 7-day snooze window). |
| **Secrets** | No API keys ever leak into logs, git, or generated docs. | `RESEND_API_KEY` confirmed present in `.env` and never printed/logged/committed. `.env` is gitignored. This checklist and all app code reference it only via `process.env.RESEND_API_KEY`. |

---

## 3. Store Testing Scenarios (Manual & Automated)

### 3.1 Automated coverage

`app/services/audit.server.test.ts` has **36 vitest tests** covering `computeHealthScore`, `round2`, `daysAgoIso`, `insufficientData`, `errorLeak`, all 4 audit functions (including exact-threshold boundary cases: FX right at the $1/mo line, return rate right at the 8% benchmark, 5-signature bloat stacking, 8-offender/10-refund truncation to top-5), `numericId`, and full `runAudit()` end-to-end paths. Run with:

```
npm test
```

This should pass with 0 failures before every deploy.

### 3.2 Manual seeding steps (per leak, on the dev store)

1. **FX Drag → "leaking":** place a test order using a checkout market/currency different from the shop's base currency (e.g. shop is USD, checkout in EUR/GBP via a test payment method). Repeat until cumulative cross-border order value in the trailing 30 days exceeds **~$55.56** (0.018 × $55.56 ≈ $1.00, crossing the threshold).
2. **Negative Margin SKU → "leaking":** pick any in-stock variant, set its price (e.g. $20) and "Cost per item" (e.g. $17) so that `price − cost − $5 shipping < 0` and `marginPercent` falls under 20%. Confirm it appears in the "Worst Offenders" list in the detail modal, sorted correctly.
3. **Script/App Bloat → "leaking":** manually add a `<script>` tag matching one of the 7 known signatures (e.g. a Loox-style snippet) into the main theme's `layout/theme.liquid`, even without the real app installed, to simulate an orphaned script. Confirm the leak fires and the "Clean Leftover Scripts" action opens the theme code editor.
4. **Return Drift → "leaking":** place at least 5 orders within 60 days, then refund enough of them that the refund rate exceeds 9% (8% benchmark + 1% drift tolerance). Confirm refunded orders appear (capped at 5) in the detail modal.
5. **Insufficient data:** on a brand-new/empty dev store (or a fresh scope with 0 orders), confirm all checks correctly show "insufficient data" rather than a false "healthy" or a crash.
6. **Review banner:** trigger the banner's display condition, dismiss it, reload — confirm it stays hidden; use "Remind Me Later," confirm it reappears only after 7 days (or adjust the clock/DB field manually to verify the snooze logic without waiting a week).
7. **Feedback loop:** submit feedback from the dashboard, confirm it appears in Settings → "Feedback You've Sent," and confirm the Resend notification email arrives (check spam folder — current sender is on Resend's onboarding/shared domain, which commonly lands in spam until a custom sending domain is verified).

---

## 4. Launch & Monetization Roadmap

### Phase 1 — Private Beta (current target)
- `BILLING_ENABLED=false` → app is 100% free, "Founder Beta: Free Lifetime Access" badge shown to every install.
- Goal: **15–20 five-star reviews** on the Shopify App Store before flipping on billing.
- Primary lever: the in-app review-request banner (persisted via `ShopSettings`, deep-links to the App Store review modal, "Remind Me Later" snoozes 7 days) — this is the main mechanism for collecting those reviews, not manual outreach.
- Recruit beta stores manually (existing network, Shopify merchant communities) rather than paid acquisition — no reason to spend ad budget on a free tier.

### Phase 2 — Commercial Launch
- Flip `BILLING_ENABLED=true`, `BILLING_TEST_MODE=false`.
- Plan already configured in `app/shopify.server.ts`: **"LeakAudit Pro Plan," $49/month, 14-day free trial**, billed via Shopify Managed Pricing (`billing.require()` in the shared `app.tsx` loader — gates every route under `/app`).
- Before flipping this on: fix the GraphQL rate-limit/pagination gap (Section 2) so paying merchants on higher-volume stores get accurate numbers, not silently-truncated ones.
- Consider verifying a custom Resend sending domain at this stage so transactional/feedback emails stop landing in spam.

### Phase 3 — Future Roadmap (post-launch, not required for v1)
- **AI Fix Explainer / Action Advisor:** replace the current static "Smart Action Tip" copy (one fixed sentence per leak type) with an LLM-generated, store-specific explanation and recommended next step per leak.
- **Real sales-velocity weighting** for the Negative-Margin check, replacing the flat ×3 placeholder multiplier with actual units-sold data from `orders`/`lineItems`.
- **Theme App Extension / app-block detection** for the Bloat check, to catch modern Shopify 2.0 orphaned blocks that the current `theme.liquid`-regex approach can't see.
- **Weekly automated alerts** (email today; WhatsApp/Slack as a stickiness feature) surfacing new leaks or health-score drops between manual visits — natural extension of the existing scan History/timeline data already captured in `AuditSnapshot`.
- **GraphQL throttle handling + pagination past 250 records**, promoted from "known gap" to "fixed" once real paid-tier volume justifies the engineering time.

---

*This document reflects the codebase as of 2026-09-07. Update it whenever the audit formulas, billing plan, or persistence strategy change.*
