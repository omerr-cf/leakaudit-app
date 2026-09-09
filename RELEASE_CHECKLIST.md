# LeakAudit — Release Checklist

**Status:** Pre-beta / pre-deployment
**Last updated:** 2026-09-09 (updated again same day — theme query correction + bulk-editor deep link fix)
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

- **Data source:** Shopify Admin GraphQL, `productVariants(first: 250, after: $cursor, query: "inventory_quantity:>0")`, selecting `price` and `inventoryItem.unitCost.amount`. Paginates via `pageInfo.hasNextPage`/`endCursor` up to 8 pages (2,000 variants) so stores with >250 in-stock variants are no longer silently truncated.
- **Formula (per variant):**
  ```
  netMargin     = price − unitCost − shippingCostPerOrder     (shippingCostPerOrder default = $5.00)
  marginPercent = (netMargin / price) × 100
  offender if marginPercent < targetMarginPercent              (default = 20%)
  monthlyImpact = Σ max(0, −netMargin) × 3     ← placeholder velocity multiplier, NOT real sales-per-SKU data
  ```
  Worst 25 offenders (lowest `marginPercent`) are surfaced, one row per SKU/variant, in the "View Details" modal — each with its SKU, retail price, unit cost, estimated shipping, net margin $/%, and a direct `Edit Variant in Shopify ↗` link to `https://admin.shopify.com/store/{shop}/products/{productId}/variants/{variantId}`.
- **Insufficient data:** 0 in-stock variants, or 0 variants have a cost set at all (`unitCost.amount` empty — this is common on stores that never filled in "Cost per item").
- **Suggested action:** "Set Cost Per Item" → deep-links to the bulk variant editor: `/bulk?resource_name=ProductVariant&edit=variants.price,inventory_item.cost` (the `variants.` prefix is what actually pre-opens the Price column — a bare `price` field name does not), scoped to the specific flagged variant ids via `&ids=...` (capped at `MODAL_DETAIL_CAP`, 25) when the leaking variants are known.
- **Known limitation to disclose honestly:** the ×3 velocity multiplier is a flat placeholder, not units-sold. It should be called an *estimate* in any merchant-facing copy, not a precise number. Actual sales velocity per SKU (via `orders`/`lineItems`) is a good v1.1 improvement, not required for beta.

### 1.3 Script / App Bloat Leak

**What it measures:** leftover third-party app script tags still injected into the theme after the merchant uninstalled the app — pure cost with zero benefit.

- **Data source:** Shopify Admin GraphQL, `themes(first: 10)` (no `roles:` filter — see the correction below), then fetches `layout/theme.liquid` asset content for the theme whose `role` is `"MAIN"`. **Corrected Sep 9 (second pass):** the first fix tried `roles: [[MAIN]]` on the theory that the argument was doubly-nested — Shopify's own live error (`Argument 'roles' on Field 'themes' has an invalid value ([[MAIN]]). Expected type '[ThemeRole!]'.`) proved that theory wrong too. Rather than keep guessing at the exact accepted shape across API versions, the query no longer filters by `roles` in GraphQL at all: it fetches the first 10 themes with their `role` field and picks the `MAIN` one in plain TypeScript (`data.themes.nodes.find(t => t.role === "MAIN")`) — this can't break on a GraphQL argument-type mismatch again. `graphqlWithRetry()`'s response is also checked for a genuine `errors` array and surfaced as an `error` status (with the underlying GraphQL message attached) instead of being silently misreported as `insufficient_data`.
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
  Up to 25 refunded orders are listed in the "View Details" modal, each with its order name, refund date, refunded amount, and a direct `View Order ↗` link to `https://admin.shopify.com/store/{shop}/orders/{orderId}`.
- **Insufficient data:** fewer than 5 orders in the 60-day window.
- **Suggested action:** "Investigate Return Drivers" → deep-links to `/orders`.

---

## 2. Pre-Launch Verification Checklist

| Area | What to verify | Current status |
|---|---|---|
| **OAuth flow** | App installs cleanly on a fresh dev store; session token issued and refreshed without manual code. | ✅ Verified live on Fly.io (Sep 7): `GET /auth?shop=...` returns a clean 200 and correctly redirects into the embedded Shopify Admin frame (`admin.shopify.com/store/leakaudit-test-store/apps/leakaudit-app`). ⚠️ Found and fixed one real bug during this check: the standalone `/auth/login` page (manual "type your shop domain" form) threw `Error: Bad Request` on submit — React Router's single-fetch data protocol can't carry the cross-origin redirect that `shopify.login()` throws. Fixed by adding `reloadDocument` to the `<Form>` in `app/routes/auth.login/route.tsx` (forces a real full-page POST instead of a client-side fetch) — **this fix is committed to disk but not yet deployed; run `fly deploy` to ship it.** ❓ Still needs a real-browser check: the embedded dashboard content area appeared blank when loaded through an automated browser session — unclear yet if that is a genuine bug or a browser-automation artifact. Open the app from the dev store in your own normal Chrome window and confirm the dashboard actually renders before checking this row off. ✅ **Resolved (Sep 8):** a second, separate `/auth/login` failure — `Error: origin does not match` / CSRF check tripping on every submit once deployed to Fly.io — was root-caused to Fly.io terminating TLS at its edge and forwarding plain HTTP internally; `@react-router/serve` never enables Express's `trust proxy`, so `req.protocol` always reported `"http"` even for real HTTPS requests, making React Router's own same-origin check see a scheme mismatch. Fixed via React Router's supported `allowedActionOrigins` config (`react-router.config.ts`), adding `"leakaudit-app.fly.dev"` to the allowlist — no custom Express server needed. Verified via a full production build and confirming the compiled `build/server/index.js` contains the updated allowlist. ⚠️ **Found and fixed (Sep 9):** `shopify.app.toml`'s `redirect_urls` was set to `https://leakaudit-app.fly.dev/api/auth` — a path that does not correspond to any route in this codebase. `app/shopify.server.ts` sets `authPathPrefix: "/auth"`, and the `@shopify/shopify-app-react-router` package (confirmed directly in its source, `shopify-app.js`) derives its real OAuth callback path as `${authPathPrefix}/callback`, i.e. `/auth/callback` — served by the existing `app/routes/auth.$.tsx` catch-all. The registered redirect URL had never matched the route a real merchant install would hit at the token-exchange step. Fixed to `redirect_urls = [ "https://leakaudit-app.fly.dev/auth/callback" ]` — **not yet pushed to Shopify Partners; run `npx shopify app config push` to sync.** ❓ **Still open:** a complete fresh-install round-trip (authorize → Shopify calls back → token exchange succeeds) has never been exercised end-to-end — only the initial `GET /auth` redirect has been verified. Do this once after `config push`, before onboarding the first real beta merchant. |
| **GraphQL rate limits** | Confirm the app degrades gracefully if Shopify throttles a request. | ✅ **Fixed (Sep 8).** All 4 audit queries (`FX_QUERY`, `THEME_QUERY`, `VARIANTS_QUERY`, `REFUNDS_QUERY`) now go through a shared `graphqlWithRetry()` wrapper in `audit.server.ts`: any GraphQL error with `extensions.code === "THROTTLED"` is retried with exponential backoff (1s, 2s, 4s, 8s — 4 retries max) instead of failing the check outright. Separately, `VARIANTS_QUERY` (the negative-margin check) now follows Shopify’s `pageInfo.hasNextPage`/`endCursor` cursor across up to 8 pages (2,000 in-stock variants) instead of silently stopping at the first 250. `FX_QUERY` and `REFUNDS_QUERY` still only look at the first 250 orders in their respective lookback windows (30/60 days) — for stores that genuinely place >250 orders in that window, revisit adding the same pagination pattern; low/mid-volume beta stores are unaffected. Covered by 5 new tests in `audit.server.test.ts` (throttle-then-succeed, exhausted-retries, non-throttled-error-not-retried, multi-page-follow, page-cap-stops-runaway-loop). |
| **Prisma / SQLite persistence** | Data survives deploys and restarts. | ✅ **Verified in production (Sep 9).** `fly ssh console --app leakaudit-app -C "ls -la /data"` confirmed `prod.sqlite` present on the mounted volume (57344 bytes, fresh mtime), proving `DATABASE_URL` is correctly pointed at `/data` and migrations ran against that path, not the ephemeral container filesystem. `fly deploy` completed cleanly (image `deployment-01M22TVEW4PGCS0C1WE8MBV48D`, 129 MB) and `curl -I https://leakaudit-app.fly.dev/` returned `HTTP/2 200 OK` (request `01M22WDQV6FM6265XVVXCY0Y5M-ams`). `fly.toml`'s `min_machines_running = 1` / `auto_stop_machines = false` were already correct from the very first commit adding the file (Sep 7) — the earlier `fly status` "stopped" reading was a stale machine that just needed this deploy to resync, not a config gap. |
| **Billing toggle** | Beta stores are never charged; toggling billing on works cleanly. | `BILLING_ENABLED` (default off) and `BILLING_TEST_MODE` (default **on**, i.e. safe/non-charging) are read in `app/shopify.server.ts` / `app/routes/app.tsx`. Billing plan config (`LeakAudit Pro Plan`, $49/30 days, 14-day trial) is always present in the `shopifyApp()` config regardless of the flag — only whether `billing.require()` is actually *called* is gated. Verify: with `BILLING_ENABLED=false` the "Founder Beta: Free Lifetime Access" badge shows and no billing screen ever appears; with `BILLING_ENABLED=true` + `BILLING_TEST_MODE=true`, installing triggers a Shopify test (non-charging) approval screen. |
| **Review banner dismissal** | Dismissal/snooze persists per shop, not per browser. | Stored server-side on `ShopSettings.reviewBannerDismissedAt` / `reviewBannerRemindAt` (Prisma/SQLite) — deliberately not `localStorage`, since embedded Admin can be opened from different browsers/devices for the same shop. Verify: dismiss or snooze the banner, reload from a different browser session, confirm it stays hidden (or reappears only after the 7-day snooze window). |
| **Secrets** | No API keys ever leak into logs, git, or generated docs. | `RESEND_API_KEY` confirmed present in `.env` and never printed/logged/committed. `.env` is gitignored. This checklist and all app code reference it only via `process.env.RESEND_API_KEY`. |
| **QA Diagnostics & Calculation Inspector** | Visual confidence in the leak math before real merchants see it. | ✅ **Built (Sep 8), simulation removed (Sep 9).** Settings → "🛠️ Developer Diagnostics & Calculation Inspector" (gated by `SHOW_QA_DIAGNOSTICS`, on automatically outside production, off in production unless a `SHOW_QA_DIAGNOSTICS=true` Fly secret is explicitly set) shows, per check: the raw Shopify inputs the last scan pulled, the exact plain-English formula applied, and the resulting status — always from a real, live scan (see the row below). The raw "Feedback You've Sent" list on Settings is gated behind the same `SHOW_QA_DIAGNOSTICS` flag — real merchants only ever see the clean "Send Us Feedback" input card on Home. |
| **Simulation & mock layer removed** | The app operates 100% against live store data — no synthetic/mock branching anywhere. | ✅ **Removed (Sep 9).** Deleted `app/services/qaSimulator.server.ts` and its test file entirely. Removed every simulation code path from `app/routes/app._index.tsx` and `app/routes/app.settings.tsx` — the "🧪 Simulate…" buttons, the "Simulated data — nothing written to your store" banner, `runAuditRespectingSimulation()`/`summarizeWithoutRecording()`, and all `isSimulated`/`scenarioLabel` state. Dropped `ShopSettings.activeSimulationScenario` from the schema via a new migration (`prisma/migrations/20260909100000_drop_simulation_scenario/`) — see Section 5. Every scan, Home dashboard and Settings Inspector alike, now runs strictly through `runAudit(admin, ...)` against the real Shopify Admin GraphQL API. |
| **Itemized drill-down modals ("View Details")** | Merchants can see and act on the exact offending items behind each leak, not just a rollup number. | ✅ **Built (Sep 9).** Each leak card's "View Details" modal now renders a proper table of the underlying records instead of a capped teaser list duplicated in the card body: Negative-Margin shows up to 25 SKUs (title, SKU, retail price, unit cost, est. shipping, net margin $/%, `Edit Variant in Shopify ↗` deep link to `/products/{id}/variants/{id}`); Payment & FX Drag shows up to 25 offending orders (order name, date, foreign-currency total, estimated FX drag $, `View Order ↗` deep link to `/orders/{id}`); Return-Rate Drift shows up to 25 refunded orders (order name, refunded $, `View Order ↗` deep link). All three share a new `MODAL_DETAIL_CAP = 25` constant in `audit.server.ts` (up from the old teaser cap of 5, since the modal is now the sole itemized view, not a preview). |
| **Live `theme.liquid` scanning fixed** | The Script/App Bloat check reads the store's actual published theme. | ✅ **Fixed (Sep 9), corrected same day.** Root-caused the "Couldn't read theme.liquid" error hit on a real live store to the `themes` query's `roles` argument. The first attempt (`roles: [[MAIN]]`, doubly-nested) was itself rejected by Shopify with a live error confirming the schema actually wants `[ThemeRole!]` — rather than keep chasing the exact nesting across API versions, the `roles` filter was dropped from GraphQL entirely: the query now fetches the first 10 themes with their `role` field and picks the `MAIN` one in TypeScript, which can't break on a GraphQL argument-type mismatch again. Also hardened `auditAppBloatLeak()` to check for a genuine GraphQL `errors` array and return an `error` status (with the real message attached) instead of always falling through to the generic "insufficient data" copy. Covered by a new test asserting the MAIN theme is correctly picked even when it isn't the first node Shopify returns. |
| **Bulk-editor deep link now pre-selects columns** | Clicking "Set Cost Per Item" opens the spreadsheet with Price and Cost per item already visible, no manual "Columns" click needed. | ✅ **Fixed (Sep 9).** The `edit=` query param needed the `variants.price` field name (not bare `price`) to actually pre-open the Price column — Shopify silently ignored the unprefixed field name. Also added an optional `&ids=...` param scoping the link to the specific flagged variant ids (capped at `MODAL_DETAIL_CAP`, 25) when they're known, so the "Set Cost Per Item" button on a leaking Negative-Margin card opens the bulk editor pre-filtered to exactly the offending rows instead of the whole catalog. Covered by 2 new tests (correct `edit=`/`ids=` params, and the 25-id cap). |

---

## 2a. Required Fly secrets before `fly deploy`

Confirmed against every `process.env.*` reference in the codebase (`app/shopify.server.ts`, `app/services/email.server.ts`) — set each with `fly secrets set KEY=value`, never committed to git or this checklist:

| Secret | Required? | Notes |
|---|---|---|
| `SHOPIFY_API_KEY` | **Required** | From the Partner Dashboard app config. |
| `SHOPIFY_API_SECRET` | **Required** | From the Partner Dashboard app config. |
| `SCOPES` | **Required** | Comma-separated. Must match `shopify.app.toml`'s `access_scopes` — read-only today, by design. |
| `SHOPIFY_APP_URL` | **Required** | The app's public HTTPS URL (`https://leakaudit-app.fly.dev` or your custom domain). |
| `DATABASE_URL` | **Required** | Must point at the mounted volume in production, e.g. `file:/data/prod.sqlite` — **not** the local `file:dev.sqlite` default. |
| `RESEND_API_KEY` | **Required** | Powers weekly alert emails + feedback notifications. |
| `RESEND_FROM_ADDRESS` | Optional | Defaults to `onboarding@resend.dev` (Resend's shared sending domain — commonly lands in spam until a custom domain is verified). |
| `SUPPORT_NOTIFICATION_EMAIL` | Optional | Where in-app feedback notifications are sent; feedback is still saved to the DB either way if unset. |
| `SHOP_CUSTOM_DOMAIN` | Optional | Only needed if testing against a custom shop domain. |
| `BILLING_ENABLED` | Optional | Default `false` (off) — flip to `true` for Phase 2 commercial launch. |
| `BILLING_TEST_MODE` | Optional | Default `true` (safe/non-charging) — set `false` only once ready to actually charge stores. |
| `SHOW_QA_DIAGNOSTICS` | **Leave unset in production** | Only for internal/beta testing on a deployed environment — turns on the Diagnostics & Calculation Inspector panel for whoever opens Settings. Off automatically whenever `NODE_ENV=production` unless this is explicitly set to `"true"`. |
| `SHOPIFY_APP_STORE_SLUG` | Optional | Needed for the review-request banner to deep-link to the real App Store listing; falls back to a placeholder slug until set. |

---

## 3. Store Testing Scenarios (Manual & Automated)

### 3.1 Automated coverage

**55 vitest tests total**, all in `app/services/audit.server.test.ts` (the simulation module and its own 4 tests were deleted Sep 9 along with `qaSimulator.server.ts`), run with:

- Covers `computeHealthScore`, `round2`, `daysAgoIso`, `insufficientData`, `errorLeak`, all 4 audit functions (including exact-threshold boundary cases: FX right at the $1/mo line, return rate right at the 8% benchmark, 5-signature bloat stacking, and 30-offender/30-refund/1-FX-order itemization truncated to `MODAL_DETAIL_CAP` (25)), `numericId`, full `runAudit()` end-to-end paths, and the GraphQL throttle-retry + `VARIANTS_QUERY` pagination behavior (Sep 8). New Sep 9: the `auditAppBloatLeak` `error` vs. `insufficient_data` distinction (a genuine GraphQL `errors` response now correctly surfaces as `error` — including updating the two pre-existing throttle-exhausted/non-throttled-error tests, which previously asserted the old, incorrect `insufficient_data` behavior), plus itemized-field assertions for negative-margin SKUs (`sku`/`variantId`/`productId`/`actionHref`), FX offending orders (`name`/`foreignAmount`/`foreignCurrency`/`estimatedDrag`), and refunded orders (`name`/`createdAt`/`refundedAmount`).

```
npm test
```

This should pass with 0 failures before every deploy.

### 3.2 Manual seeding steps (per leak, on the dev store)

1. **FX Drag → "leaking":** place a test order using a checkout market/currency different from the shop's base currency (e.g. shop is USD, checkout in EUR/GBP via a test payment method). Repeat until cumulative cross-border order value in the trailing 30 days exceeds **~$55.56** (0.018 × $55.56 ≈ $1.00, crossing the threshold).
2. **Negative Margin SKU → "leaking":** pick any in-stock variant, set its price (e.g. $20) and "Cost per item" (e.g. $17) so that `price − cost − $5 shipping < 0` and `marginPercent` falls under 20%. Confirm it appears in the "Worst Offenders" table inside the "View Details" modal (SKU, price, cost, shipping, net margin, and an `Edit Variant in Shopify ↗` link), sorted correctly.
3. **Script/App Bloat → "leaking":** manually add a `<script>` tag matching one of the 7 known signatures (e.g. a Loox-style snippet) into the main theme's `layout/theme.liquid`, even without the real app installed, to simulate an orphaned script. Confirm the leak fires and the "Clean Leftover Scripts" action opens the theme code editor.
4. **Return Drift → "leaking":** place at least 5 orders within 60 days, then refund enough of them that the refund rate exceeds 9% (8% benchmark + 1% drift tolerance). Confirm refunded orders appear (capped at 25) as a table in the "View Details" modal, each with a `View Order ↗` link.
5. **Insufficient data:** on a brand-new/empty dev store (or a fresh scope with 0 orders), confirm all checks correctly show "insufficient data" rather than a false "healthy" or a crash.
6. **Review banner:** trigger the banner's display condition, dismiss it, reload — confirm it stays hidden; use "Remind Me Later," confirm it reappears only after 7 days (or adjust the clock/DB field manually to verify the snooze logic without waiting a week).
7. **Feedback loop:** submit feedback from the dashboard, confirm it appears in Settings → "Feedback You've Sent" (only visible with `SHOW_QA_DIAGNOSTICS` on — see Section 2), and confirm the Resend notification email arrives (check spam folder — current sender is on Resend's onboarding/shared domain, which commonly lands in spam until a custom sending domain is verified).

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
- The GraphQL rate-limit/pagination gap (Section 2) is now fixed for the negative-margin check; if paid-tier stores turn out to place >250 orders in the FX/return-drift lookback windows, extend the same pagination pattern to `FX_QUERY`/`REFUNDS_QUERY` before relying on those numbers at scale.
- Consider verifying a custom Resend sending domain at this stage so transactional/feedback emails stop landing in spam.

### Phase 3 — Future Roadmap (post-launch, not required for v1)
- **AI Fix Explainer / Action Advisor:** replace the current static "Smart Action Tip" copy (one fixed sentence per leak type) with an LLM-generated, store-specific explanation and recommended next step per leak.
- **Real sales-velocity weighting** for the Negative-Margin check, replacing the flat ×3 placeholder multiplier with actual units-sold data from `orders`/`lineItems`.
- **Theme App Extension / app-block detection** for the Bloat check, to catch modern Shopify 2.0 orphaned blocks that the current `theme.liquid`-regex approach can't see.
- **Weekly automated alerts** (email today; WhatsApp/Slack as a stickiness feature) surfacing new leaks or health-score drops between manual visits — natural extension of the existing scan History/timeline data already captured in `AuditSnapshot`.
- ~~GraphQL throttle handling + pagination past 250 records~~ — done Sep 8 for throttle retry (all 4 queries) and pagination (`VARIANTS_QUERY`). Remaining: apply the same pagination pattern to `FX_QUERY`/`REFUNDS_QUERY` if a paid-tier store ever places >250 orders inside a 30/60-day lookback window.

---

---

## 5. Simulation layer removal — schema cleanup (Sep 9)

`ShopSettings.activeSimulationScenario` (added Sep 8 for the now-deleted QA simulator) was dropped via a new migration, `prisma/migrations/20260909100000_drop_simulation_scenario/`. The column was also removed directly from the local `dev.sqlite`, with the migration recorded as already-applied in `_prisma_migrations` so it won't be re-run or double-applied.

**No manual step needed.** `shopify.web.toml` already runs `npx prisma generate` as a `predev` hook and `npx prisma migrate deploy` at the start of `dev` — the next `npm run dev` / `shopify app dev` automatically regenerates the Prisma Client to match the trimmed schema and confirms the migration is already applied. Production is unaffected the same way it always has been: the Fly.io Docker build runs `prisma generate`/`migrate deploy` fresh on every deploy.

---

*This document reflects the codebase as of 2026-09-09. Update it whenever the audit formulas, billing plan, or persistence strategy change.*
