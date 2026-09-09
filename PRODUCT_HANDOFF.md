# LeakAudit — Engineering → Product Handoff

**From:** Claude (implementation — the one actually touching the code this week)
**To:** Gemini (product lead) and Omer
**As of:** 2026-09-09
**Purpose:** A single, honest brief of exactly what's built, what's verified, and what's genuinely still open — so product direction gets decided on real code state, not assumptions. Everything below is grounded in the actual repo (`app/services/audit.server.ts`, `app/routes/app*.tsx`, `RELEASE_CHECKLIST.md`), not a general description of what the app "should" do.

---

## 1. What LeakAudit is

A free/low-cost Shopify embedded app: scans a merchant's live store data and surfaces four concrete, dollar-denominated "profit leaks" within seconds of opening it. No manual setup, no CSV upload — it reads directly from the Shopify Admin GraphQL API.

Stack: React Router (Remix-style) + Shopify App Bridge / Polaris web components, Prisma + SQLite, deployed on Fly.io.

## 2. The four checks (what's actually being measured)

| Check | What it measures | Known limitation (disclose honestly, don't oversell) |
|---|---|---|
| **Payment / FX Drag** | Estimated markup on cross-border/multi-currency orders (30-day window) | It's a 1.8%-of-revenue *estimate*, not a real per-order fee lookup — Shopify doesn't expose the actual FX rate applied |
| **Negative-Margin SKUs** | Variants where price − cost − shipping < target margin | Monthly $ impact uses a flat ×3 "units sold" placeholder, not real sales velocity — a good v1.1 upgrade, not done yet |
| **Script/App Bloat** | Leftover third-party script tags in the live theme from apps the merchant uninstalled | Only regex-matches 7 known signatures (Klaviyo, Loox, Judge.me, Privy, AfterShip, Wheelio, Rebuy) against `theme.liquid` — misses modern Shopify 2.0 app-block/theme-extension injections |
| **Return-Rate Drift** | Refund rate vs. an 8% benchmark (60-day window) | Straightforward, no major caveat |

Health Score = `100 − 15×(checks leaking) − 5×(checks erroring)`.

## 3. What shipped this week, in order

1. **QA Diagnostics Inspector** (Settings tab, dev/beta-only via `SHOW_QA_DIAGNOSTICS`) — shows the raw Shopify inputs, exact formula, and status per check, so the math is auditable rather than a black box.
2. **Smart history dedup + Savings Ledger** — scan history only records a new row on real change (not every passive page load), and the Home/History pages show "$X/mo recovered since install."
3. **Simulation layer fully removed (Sep 9)** — the app initially had a synthetic-data "QA simulator" for testing without touching real Shopify data. Once you had real test data in the store, we deleted it entirely (`qaSimulator.server.ts`, the simulate buttons, the `activeSimulationScenario` DB column via a proper migration). **Every scan, everywhere in the app, now runs against live Shopify data only.**
4. **Itemized "View Details" drill-down** — each leak card's modal now shows an actual table of the offending records (SKU/variant, order, refund) with a direct one-click link into Shopify Admin, instead of a vague rollup number. Capped at 25 items per check.
5. **Theme-scanning bug fixed (the important one)** — the Bloat check was silently failing on the real live store ("Couldn't read theme.liquid") because of a GraphQL argument-type mismatch on the `themes` query's `roles` filter. After two attempts at guessing the right nesting, the durable fix was to **stop filtering by `roles` in GraphQL entirely** and pick the MAIN theme in plain TypeScript instead — this can't break on a schema mismatch again, on any Shopify API version.
6. **Bulk-editor deep link fixed** — "Set Cost Per Item" now opens Shopify's bulk editor with the Price and Cost columns actually pre-selected (needed the `variants.price` field name, not bare `price`), and scoped via `&ids=...` to just the flagged variants instead of the whole catalog.
7. **Dashboard UX polish** — a "Total Money You Can Recover Today: $X/month" hero card with a one-click "Copy Leak Summary" button, and primary/action-verb buttons on leaking cards ("Fix N Negative-Margin SKUs in Bulk ↗", etc.) instead of generic labels.

**Verified today, live, on your real store (your words):** the FX and App Bloat cards are now correctly reporting Healthy, and the itemized/bulk-editor deep links open the exact right thing in Shopify Admin.

**Automated coverage:** 55 vitest tests, all green. `tsc --noEmit`, `eslint`, and a production build (`npm run build`) all pass clean as of the last commit (`b34a1c4`).

## 4. What is genuinely still open (from `RELEASE_CHECKLIST.md`, not new)

These are the honest gaps — not blockers to trying the app, but things that shouldn't be assumed "done" without a look:

- **Real-browser dashboard check.** One prior automated-browser test showed a blank content area; unclear if that was a genuine bug or a browser-automation artifact. Worth a normal-Chrome open-and-look before trusting it fully.
- **Production persistence confirmation.** The checklist documents *what's required* for Fly.io (a mounted volume, `DATABASE_URL` pointing at it, migrations applied against that path) but doesn't yet have a checkmark confirming this was actually verified against the live deploy — worth a quick `fly ssh console` + `ls /data` sanity check.
- **Production secrets audit.** `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`, `DATABASE_URL`, `RESEND_API_KEY` should all be confirmed set via `fly secrets set` (not just present in local `.env`, which is a different environment).
- **Manual seeding pass (Section 3.2 of the checklist).** Deliberately triggering each of the 4 leaks with real (or test) store data, plus the review-banner snooze logic and the feedback→email loop, hasn't been formally checked off end-to-end — automated tests cover the math, not the live merchant experience end-to-end.
- **Resend sending domain.** Currently on Resend's shared/onboarding domain, which commonly lands in spam. Fine for beta, worth fixing before relying on weekly alert emails at scale.

## 5. Roadmap as currently planned (for product-strategy input)

- **Phase 1 (now):** 100% free "Founder Beta." Primary growth lever is the in-app review-request banner — target 15–20 five-star App Store reviews before turning on billing.
- **Phase 2:** Flip on billing — "LeakAudit Pro Plan," $49/month, 14-day trial, already configured in `shopify.server.ts` and gated behind `BILLING_ENABLED`.
- **Phase 3 (not required for v1, worth Gemini's prioritization input):**
  - AI-generated, store-specific fix explanations (replacing the current one-fixed-sentence-per-leak-type copy)
  - Real sales-velocity data replacing the ×3 placeholder multiplier on the margin check
  - Theme-app-extension/app-block detection for the Bloat check (catches what the current regex approach misses)
  - Weekly automated alerts beyond email (WhatsApp/Slack) as a stickiness feature

## 6. The one open product question worth Gemini's input

Given the pre-launch checklist above is now mostly engineering-verified (theme fix, itemized modals, bulk-editor scoping, UI polish all shipped and tested today), the real open decision is **sequencing**: finish the remaining manual/production-verification checklist items first (safer, slower to first beta merchant), or start recruiting beta stores now in parallel while treating the open items as fast-follow (faster feedback loop, some risk of a rough first impression if the untested paths have issues). That's a product call, not an engineering one — flagging it explicitly rather than deciding it myself.

---

*Everything above is grounded in the current repo state and `RELEASE_CHECKLIST.md`, which remains the canonical, continuously-updated source of truth for exact formulas, secrets, and test coverage.*
