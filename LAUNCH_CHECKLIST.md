# Re-Golf launch checklist

Created 17 November 2026 from a full review of the code and of DEVELOPMENT_PLAN.md / RELEASE_PLAN.md.
Goal: a publishable UK marketplace where the buyer's payment is held and released to the seller a few days after delivery (the Vinted model).

This is the working list. The two plan files stay as background; where they disagree with this file, this file wins. Tick an item only when its check passes.

Legend: **[J]** needs a decision or action from Jonny. **[D]** development. Items are in the order they should be worked.

## Review summary

What is solid: listings, photos, favourites, messaging, blocking/reporting, database-enforced ownership (RLS), server-side validation, the private Render preview, 54 passing tests.

What stands between this and a publishable app:

1. **No real money path.** The only checkout is a simulation on separate test tables. The buyer "pays" by clicking a button; there is no hold period, no completion step, no issue reporting, no refund, no payout record and no audit trail.
2. **The flat £2.50 buyer fee loses money on most clubs.** Card processing is a percentage of the whole basket, so the cost grows with the price while the fee does not. The fee needs a percentage part (Vinted charges roughly 5% + £0.70). See section 1.
3. **Sold items were not protected at the database.** The browser holds the Supabase key, so a seller can call the database directly. Nothing stopped a seller re-activating or re-pricing a listing once a buyer had reserved it. (Fixed in section 2.)
4. **Operational gaps for real transactions:** no admin tools, no transactional or notification emails, Supabase's built-in email sender is rate-limited to a handful per hour, no error monitoring, no account deletion, no terms/privacy/refund pages, no delivery address capture.
5. **The plan documents have drifted.** Stacked "this supersedes the above" notes, and Phase 1–2 boxes left unticked although the work passed hosted acceptance.

## 0. Stabilise what is in flight

- [x] [D] Baseline recorded: typecheck clean, 54/54 tests pass on the working tree (17 Nov). Now 76/76.
- [x] [D] Simulated checkout put behind `TEST_CHECKOUT_ENABLED`, off by default and not set on Render.
- [x] [J] Simulation migration `20261117123645_test_checkout_orders.sql`: checked 17 Nov — it **is applied** to the development database (`test_listings` and `test_orders` exist, both empty). Harmless: the real order flow below does not depend on it or conflict with it. When the simulation is deleted, add a migration that drops those two tables, the two `test_checkout` functions and `private.test_checkout_settings`, and revokes `usage` on schema `private` from `authenticated`.
- [ ] [D] Delete the simulation once the real flow has passed a hosted test: `server/checkout.ts`, `src/checkout.ts`, `tests/checkout.test.ts`, `scripts/test-checkout-live.ts`, its migration, the "Checkout testing" dialog and the flag. Left in place for now because the files are uncommitted and could not be recovered.
- [ ] [J] Review and commit this work (nothing has been committed or pushed).

## 1. Decisions

Decided 17 November 2026:

- [x] **Payment provider: Stripe Connect**, "separate charges and transfers". The buyer pays Re-Golf's Stripe platform account; the money stays in the platform balance during the hold; the server then transfers the seller's share to their connected account. Chargebacks fall on the platform.
- [x] **Fee: £0.70 + 5% of the item price**, paid by the buyer (database setting, changeable without code).
- [x] **Hold rules** (database settings): checkout reservation 35 min; seller must post within 5 days or the buyer is refunded automatically; if the buyer never confirms, the item counts as delivered 10 days after posting; **payment is released 48 hours after delivery** unless the buyer reports a problem; the buyer can release early.
- [x] **Delivery: tracked postage always.** The seller arranges it and must enter carrier and tracking number to mark an order posted. The buyer pays a fixed delivery charge (£5.95 setting) which is passed to the seller with the item price.

Chosen by default during the build — say if any should change:

- Sellers can sell before setting up payouts; their money waits until they finish Stripe onboarding. (Alternative: block "Buy" until the seller has onboarded.) Stripe limits how long funds can be held, so chase sellers who do not onboard.
- Refunds are for the full amount including the buyer fee.
- The seller's view of the delivery address closes once the order completes.

Still open:

- [ ] [J] Is £5.95 right for golf clubs? A tracked parcel long enough for a driver usually costs more. Consider a price per category (clubs vs. bags vs. small items).
- [ ] [J] Scope confirmation: UK only, GBP, individual sellers, one item per order. Professional verification deferred.
- [ ] [J] **Price display.** UK rules on "drip pricing" (DMCC Act 2024) expect unavoidable fees to be included in the headline price. Listing cards should probably show the price including the buyer fee, as Vinted does. Confirm with the policy review in section 7.

## 2. Order and escrow core [D]

The database decides what should happen to the money; the server carries it out with Stripe.

- [x] Listing states `reserved` and `sold`; sellers cannot edit, re-activate or archive a listing while an order holds it, even by calling the database directly.
- [x] `orders` table with price/fee/delivery snapshot, separate fulfilment status and funds status (`none → held → release_due → released`, or `refund_due → refunded`).
- [x] Atomic reservation: one live order per listing, idempotent retries, own-listing and blocked-user checks, per-buyer rate limit.
- [x] Payment confirmation only from the server role (a verified webhook), never the browser. Duplicate events are ignored; a late success after expiry either revives the order (item still free) or queues a refund (item gone).
- [x] Hold window with early release and issue reporting, which freezes release.
- [x] Mandatory carrier and tracking number on dispatch.
- [x] Sweep: expire reservations, refund undispatched orders, assume delivery, release after the hold.
- [x] Dispute resolution (release or refund) restricted to the server role; audit trail in `order_events`.
- [x] Private delivery address: visible to the buyer, and to the seller only from payment until completion.
- [x] Server-enforced checkout switch in the database, **off by default**.
- [x] API routes (`/api/orders…`, `/api/payouts/onboard`) and an Orders screen for buyers and sellers; "Buy now" on listings shows the full server-calculated price before payment.
- [x] Tests: `tests/orders.test.ts` (database rules, 16 scenarios), `tests/payments.test.ts` (webhook, settlement, configuration).
- [ ] The Orders screen and "Buy now" have not been exercised in a browser yet (needs the migration and Stripe keys below).

## 3. Stripe integration (test mode)

Built and unit-tested, but **not yet run against Stripe** — no keys were available. Expect small fixes on first contact.

- [x] [D] Hosted Stripe Checkout created server-side from the reserved order; collects the UK delivery address; expires before the reservation does.
- [x] [D] Webhook `/api/stripe/webhook`: signature verified on the raw body, amount and currency checked against the order, events de-duplicated. Exempt from the preview password.
- [x] [D] Settlement runs inside the web server every 5 minutes: applies deadlines, refunds `refund_due`, transfers `release_due` to sellers with payouts enabled. Idempotency key per order and action.
- [x] [D] Seller payout onboarding (Stripe Express account + hosted onboarding link); `account.updated` keeps payout status current.
- [x] [D] Card dispute (`charge.dispute.created`) freezes an order whose funds are still held.
- [x] [D] Live keys refused unless `ALLOW_LIVE_PAYMENTS=true`.
- [ ] [J] **Create a Stripe account and enable Connect** (test mode is enough to start).
- [ ] [J] In Stripe test mode, add a webhook endpoint for `https://re-golf-development.onrender.com/api/stripe/webhook` **twice** (Stripe allows one scope per destination), both with snapshot payloads: scope "Your account" with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.dispute.created`; and scope "Connected accounts" with `account.updated`.
- [ ] [J] Put `STRIPE_SECRET_KEY` (sk_test_…) `STRIPE_WEBHOOK_SECRET` (whsec_… of the "Your account" destination) and `STRIPE_CONNECT_WEBHOOK_SECRET` (whsec_… of the "Connected accounts" destination) into Render and local `.env`. Never into chat or the repository.
- [ ] [J]/[D] Apply migration `20261117150000_orders_escrow.sql` to the development database, then turn buying on: `update private.marketplace_settings set checkout_enabled = true;`
- [ ] [D] Hosted acceptance with Stripe test cards: success, declined card, abandoned checkout, two simultaneous buyers, duplicate webhook, late webhook, refund for non-dispatch, dispute then refund, release after hold, seller onboarding then payout.
- [ ] [D] Charge refunded or disputed **after** release: reverse the transfer and record it (not built).
- [ ] [D] Daily reconciliation script: Stripe balance transactions vs `orders`; any difference is an alert.
- [ ] [D] The free Render service sleeps when idle, which delays webhooks and the 5-minute settlement. Acceptable for testing; production needs an always-on plan.

## 4. Delivery and completion [D]

- [x] Carrier and tracking number required on dispatch and shown to the buyer.
- [ ] Turn the tracking number into a carrier link; optionally confirm delivery from carrier tracking instead of the buyer.
- [x] Order deadlines run inside the web server (no paid scheduler needed). Photo cleanup still needs one, or can be moved in-process the same way.
- [x] Buyer can report a problem, which freezes payment.
- [ ] Richer issue handling: photos, seller response, return postage, partial refunds.
- [ ] Delete delivery addresses a set time after completion (retention).
- [ ] Reviews: one per participant per completed order.

## 5. Notifications and email [D]/[J]

- [ ] [J] Custom SMTP sender on a Re-Golf domain (Supabase's default sender is for testing only and heavily rate-limited). Needs the domain from section 8.
- [ ] Transactional emails: order paid (to seller, with dispatch deadline), dispatched, delivered/hold started, released, refunded, issue opened.
- [ ] New-message notification email (currently messages only appear on manual refresh).

## 6. Admin and support [D]/[J]

- [ ] Role-protected admin page: reports queue, orders, disputes with release/refund buttons, listing takedown, user suspension. Every action written to the audit trail.
- [ ] [J] Named support owner, support mailbox, and a review cadence for reports.
- [ ] Account deletion. Today it would fail or destroy records: conversations, messages and (now) orders reference the profile. Needs anonymise-and-retain for anything financial.

## 7. Legal and policy [J] — get these reviewed; this list is not legal advice

- [ ] Terms, privacy notice, buyer-protection/refund policy, prohibited items, counterfeit reporting.
- [ ] HMRC digital-platform reporting: UK platforms must collect and report seller details and earnings. Stripe onboarding collects most of the identity data; reporting remains Re-Golf's duty.
- [ ] Online Safety Act: private messaging between users brings an illegal-content risk assessment duty.
- [ ] ICO registration and a data-retention schedule (order records kept for tax purposes vs. profile deletion).
- [ ] Company/trading entity and business bank account for the Stripe platform account.

## 8. Production readiness [D]/[J]

- [ ] [J] Domain; separate **production** Supabase project and Render service (paid plan — the free plan sleeps and would miss webhooks).
- [ ] Remove the preview password gate for production; keep `noindex` off; tighten CSP.
- [ ] Error monitoring and alerting (the server currently logs only the error name).
- [ ] Database backups with one rehearsed restore.
- [ ] Photo delivery: every image is proxied through the Node server with `no-store`. Fine for a preview, slow and costly in public. Move to short-lived signed URLs or private caching.
- [ ] Search covers brand and description as well as name; price/condition filters.
- [ ] Remove "Development preview" banners and example listings from the production build.
- [ ] Accessibility and slow-network pass on mobile.
- [ ] Rate limiter is in-memory: fine for one instance, revisit before scaling out.

## 9. Pilot and launch [J]/[D]

- [ ] One real low-value purchase end to end, including the hold, release and seller payout; one real refund.
- [ ] Invited pilot (10–20 people), at least five completed orders across more than one buyer and seller, all reconciled.
- [ ] Go/no-go recorded; open public purchases; daily reconciliation for the first two weeks.

## Smaller findings from the code review

- `listings` update permission includes `status` for signed-in users. Now constrained by a trigger; consider removing the column grant and routing all status changes through functions.
- The simulation migration grants `usage` on the `private` schema to signed-in users. Harmless while the API exposes only `public`, but the new order functions avoid needing it. Revoke when the simulation is retired.
- `GET /api/photos/:id` and every authenticated route call Supabase Auth over the network per request. Acceptable now; verify JWTs locally if latency matters.
- Reserved/sold listings disappear from public reads, so their photos do too. Order pages will need a participant-read policy for the purchased item's main photo.
- `scripts/test-checkout-live.ts` imports `playwright`, which is not in package.json.
- Buyers and sellers can read Stripe reference IDs on their own orders if they query the database directly. Not secrets, but could be hidden with column grants.
- DEVELOPMENT_PLAN.md Phase 1–2 checkboxes are stale; tidy when the plans are next edited.
