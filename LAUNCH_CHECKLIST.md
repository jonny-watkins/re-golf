# Relofted launch checklist

Created 17 November 2026 from a full review of the code and of the earlier plans (now in docs/archive).
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
- [x] [D] Simulation code deleted (17 Nov). Its database tables are dropped by the pending migration below.
- [x] [D] Work committed and pushed to the `payments` branch; the preview deploys from that branch. `main` is untouched as the fallback.
- [x] [J] Migration `20261117180000_support_and_clawback.sql` applied to the development database (17 Nov). Verified on the preview: reviews, checkout switch, fee-inclusive pricing, audit trail, payout clawback; simulation tables removed.
- [x] [J] Migration `20261117210000_accounts_and_emails.sql` applied to the development database (17 Nov). Verified on the preview: emails queued to the right person at each order step, suspension, account deletion (16 hosted checks pass).
- [x] [J] Migration `20261118130000_minimum_fee_and_payout_rule.sql` applied to the development database (18 Nov). Verified on the preview: £3 minimum fee charged through Stripe, an item cannot be bought until its seller has finished payout setup (19 hosted checks and the browser purchase pass).
- [x] [D] The listing page says when an item cannot be bought yet (19 Nov): buyers see "Not available to buy yet" and why; the seller sees a prompt to set up payouts.
- [ ] [J] **Choose the support administrators:** set `ADMIN_EMAILS` on Render (and in local `.env`) to the sign-in email(s) allowed to open the Support screen, comma-separated. Until then the screen is off.
- [ ] [J] Look over the `payments` branch and merge it into `main` when happy.

## 1. Decisions

Decided 17 November 2026:

- [x] **Payment provider: Stripe Connect**, "separate charges and transfers". The buyer pays Relofted's Stripe platform account; the money stays in the platform balance during the hold; the server then transfers the seller's share to their connected account. Chargebacks fall on the platform.
- [x] **Fee: £0.70 + 5% of the item price**, paid by the buyer (database setting, changeable without code).
- [x] **Hold rules** (database settings): checkout reservation 35 min; seller must post within 5 days or the buyer is refunded automatically; if the buyer never confirms, the item counts as delivered 10 days after posting; **payment is released 48 hours after delivery** unless the buyer reports a problem; the buyer can release early.
- [x] **Delivery: tracked postage always.** The seller arranges it and must enter carrier and tracking number to mark an order posted. The buyer pays a fixed delivery charge (£5.95 setting) which is passed to the seller with the item price.

Chosen by default during the build — say if any should change:

- **Changed 18 Nov:** an item can only be bought once its seller has finished Stripe payout setup, so money is never held for someone who cannot be paid. Sellers can still list first and are prompted to set up payouts straight after. (Database setting `require_payouts`; previously sellers could sell first and their money waited.)
- **Added 18 Nov:** the buyer fee has a minimum of £3 (`fee_min_pence` setting). Below about £46 the £0.70 + 5% formula gives less than that, and card processing plus payout costs would eat most of it.
- Refunds are for the full amount including the buyer fee.
- The seller's view of the delivery address closes once the order completes.

Still open:

- [ ] [J] Is £5.95 right for golf clubs? A tracked parcel long enough for a driver usually costs more. Consider a price per category (clubs vs. bags vs. small items).
- [ ] [J] Scope confirmation: UK only, GBP, individual sellers, one item per order. Professional verification deferred.
- [x] [D] Listing cards and the listing page show the price including the buyer protection fee. [J] still to confirm the exact wording with the policy review in section 7.

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
- [x] Orders screen and "Buy now" exercised in a real (headless Edge) browser on the preview: `npm run test:orders:browser`.

## 3. Stripe integration (test mode)

Sandbox connected 17 Nov. Verified against Stripe: checkout creation (correct total, GB address, 31-minute expiry, idempotent), checkout expiry, refund, seller account creation and onboarding link, both webhook signing secrets on the deployed preview. Not yet verified: a full purchase through the app (needs the orders migration), seller onboarding completion and a real transfer.

- [x] [D] Hosted Stripe Checkout created server-side from the reserved order; collects the UK delivery address; expires before the reservation does.
- [x] [D] Webhook `/api/stripe/webhook`: signature verified on the raw body, amount and currency checked against the order, events de-duplicated. Exempt from the preview password.
- [x] [D] Settlement runs inside the web server every 5 minutes: applies deadlines, refunds `refund_due`, transfers `release_due` to sellers with payouts enabled. Idempotency key per order and action.
- [x] [D] Seller payout onboarding (Stripe Accounts v2 "recipient" with Express dashboard + hosted onboarding link); `account.updated` keeps payout status current, and settlement re-checks with Stripe when money is waiting.
- [x] [D] Card dispute (`charge.dispute.created`) freezes an order whose funds are still held.
- [x] [D] Live keys refused unless `ALLOW_LIVE_PAYMENTS=true`.
- [x] [J] Stripe sandbox created, Connect enabled ("you collect payments and pay recipients").
- [x] [J] In Stripe test mode, add a webhook endpoint for `https://re-golf-development.onrender.com/api/stripe/webhook` **twice** (Stripe allows one scope per destination), both with snapshot payloads: scope "Your account" with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.dispute.created`; and scope "Connected accounts" with `account.updated`.
- [x] [J]/[D] Put `STRIPE_SECRET_KEY` (sk_test_…) `STRIPE_WEBHOOK_SECRET` (whsec_… of the "Your account" destination) and `STRIPE_CONNECT_WEBHOOK_SECRET` (whsec_… of the "Connected accounts" destination) into Render and local `.env`. Never into chat or the repository.
- [x] [J] Migration `20261117150000_orders_escrow.sql` applied to the development database and buying switched on there (17 Nov).
- [x] [D] Hosted acceptance, `npx tsx scripts/test-orders-live.ts` (17 Nov, 11/11 on the Render preview with the Stripe sandbox): quote, two simultaneous buyers, privacy, cancel closes the Stripe checkout, signed payment holds funds, duplicate and forged webhooks, address visibility, mandatory tracking, 48-hour hold, early release, payout waiting for onboarding, problem report then full refund through Stripe, non-dispatch refund, late payment refunded not double-sold. Payment arrival is simulated with a real test-card charge plus a signed event.
- [x] [D] Browser purchase on the preview with Stripe's test card (17 Nov): genuine Stripe webhook marked the order paid, funds held, delivery address saved, seller posted with tracking, buyer confirmed and released, the preview server transferred £10.95 to the seller by itself, seller screen showed "sent". The connected-accounts webhook was subscribed to the wrong event (`account.external_account.updated`); corrected to `account.updated` in the sandbox and proven.
- [ ] [J] Click through Stripe's payout setup form once as a seller (Orders → Set up payouts). Stripe shows a CAPTCHA to scripts, so this one step was not automated; the payout itself was proven with a test seller set up through Stripe's API. Test values: phone "use test number", code 000000, date of birth 01/01/1901, address line `address_full_match`, sort code 108800, account 00012345.
- [x] [D] Checkout limited to cards (Apple Pay and Google Pay included); Klarna and other pay-later methods are off. Buyer email is prefilled.
- [ ] [D] Declined-card behaviour observed in the browser (abandonment and expiry are covered by the hosted checks).
- [x] [D] Bank dispute or support refund after the seller has been paid: the transfer is taken back, then the buyer refunded if that was the decision. Proven against the Stripe sandbox (transfer fully reversed, buyer refunded in full). A real bank dispute event has not been simulated.
- [x] [D] Reconciliation: `npm run orders:reconcile` compares Stripe charges, refunds and seller transfers with the orders table in both directions and exits non-zero on any difference. First run correctly flagged the £100 sample payment Stripe's own setup guide created (no order behind it); refund or ignore it.
- [x] [D] Reconciliation also checks for stuck refunds and payouts, order deadlines not being applied, and emails that keep failing (19 Nov). An hourly GitHub workflow (`.github/workflows/money-check.yml`) runs it and GitHub emails the owner on failure. It does nothing until the `production` secrets exist (GO_LIVE step 5), and scheduled runs start only once this is merged to `main`. It is not pointed at the development sandbox, where deleted test orders leave unmatched test payments.
- [ ] [J] Add the `production` secrets for the money check at launch (GO_LIVE step 5).
- [ ] [D] The free Render service sleeps when idle, which delays webhooks and the 5-minute settlement. Acceptable for testing; production needs an always-on plan.

## 4. Delivery and completion [D]

- [x] Carrier and tracking number required on dispatch and shown to the buyer.
- [x] Tracking numbers link to the carrier's tracking page for Royal Mail, Parcelforce, Evri and UPS (19 Nov). The link formats have not been clicked with a real parcel; do that in the pilot. Other carriers show the number only.
- [ ] Optionally confirm delivery from carrier tracking instead of the buyer.
- [x] Order deadlines run inside the web server (no paid scheduler needed). Photo cleanup still needs one, or can be moved in-process the same way.
- [x] Buyer can report a problem, which freezes payment.
- [x] Settling a reported problem (18 Nov): the seller refunds straight away or asks for the item back at an address they give; the buyer has 5 days (`return_days` setting) to post it with tracking or the seller is paid; the buyer is refunded when the seller confirms it is back, or automatically 10 days after it was posted; the buyer can withdraw the problem; either side can ask support to decide, which stops the automatic deadlines. Card disputes stay support-only. Database rules tested (`tests/returns.test.ts`); emails and policy drafts updated. Hosted check passed 18 Nov against the development database and Stripe sandbox (tracked return refunded through Stripe, missed return pays the seller, asking support to decide).
- [x] [J] Migration `20261118100000_order_returns.sql` applied to the development database (18 Nov).
- [x] [D] Return flow added to `npm run test:orders:live` (18/18 pass).
- [x] [D] Return flow clicked through in a real (headless Edge) browser on the preview as buyer and seller (18 Nov): seller asks for the item back, buyer sees the return address and deadline and posts with tracking, seller confirms, buyer refunded in full through Stripe. `npm run test:returns:browser`.
- [ ] [J] Return postage is paid by the buyer in every case (Vinted's rule). Confirm with the policy review, especially for items not as described.
- [x] [D] Photos with a problem report (19 Nov): while a problem is open the buyer and the seller can each add up to four photos; they are stored privately and shown only to the two of them and to support (order details on the Support screen). Database rules tested (`tests/issue-photos-unread.test.ts`). Checked in a browser on the preview (19 Nov, `npm run test:returns:browser`): the buyer adds a photo, the seller sees it, a stranger cannot fetch it.
- [x] [J] Migration `20261119100000_issue_photos_and_unread.sql` applied to the development database (19 Nov, pasted into the SQL Editor).
- [ ] [D] Delete problem photos a set time after the order is settled (retention), with the delivery addresses.
- [ ] Later on problems: partial refunds, and confirming the return from carrier tracking.
- [ ] Delete delivery addresses a set time after completion (retention).
- [x] Reviews: buyer and seller can each leave one rating and comment after an order completes; the seller's average shows on their listings. Hosted check passed.

## 5. Notifications and email [D]/[J]

- [ ] [J] Custom SMTP sender on a Relofted domain (Supabase's default sender is for testing only and heavily rate-limited). Needs the domain from section 8.
- [x] Emails written and queued by the database for every order step (paid, sold with the post-by deadline, posted with tracking, delivered, completed, paid out, problem reported, refunding, refunded, cancelled) and for new messages (at most one an hour per conversation). Sending is off until `EMAIL_API_KEY` and `EMAIL_FROM` are set; stale emails are dropped rather than sent late. Templates and queue logic are tested; **no real email has been sent**.
- [x] [J] Domain bought: `relofted.co.uk` (GoDaddy), 19 Nov.
- [x] [J]/[D] Resend account created, `relofted.co.uk` verified there (four DNS records at GoDaddy), and `EMAIL_API_KEY` and `EMAIL_FROM` (`Relofted <orders@relofted.co.uk>`) set locally and on the preview (19 Nov). Order and message emails are now switched on for the preview. Addresses at reserved test domains (`example.com` and similar, used by the automated checks) are never emailed, to protect the domain's reputation.
- [ ] [D]/[J] Send one of each email to a real inbox and check wording, links and spam placement: `npx tsx scripts/send-sample-emails.ts <address>`. One sample has been accepted by the provider's test inbox; none has been read in a real inbox yet.
- [x] [J] Sign-up and password-reset emails go through Resend from `accounts@relofted.co.uk` (custom SMTP set in Supabase, 19 Nov). Verified: a sign-up confirmation was delivered to the provider's test inbox from that address.
- [ ] [J] The sign-up and reset emails still use Supabase's default wording ("Confirm Your Signup"). Reword them for Relofted in Supabase → Authentication → Emails → Templates.
- [x] New-message notification email (queued; see above).
- [x] Unread-message indicator (19 Nov): the Messages button shows how many conversations have something new, the conversation list marks them, and opening one clears it. Checked once a minute while the page is open. Database rules tested; the count appearing and clearing was checked in a browser on the preview (19 Nov).

## 6. Admin and support [D]/[J]

- [x] Support screen for administrators named in `ADMIN_EMAILS`: orders needing a decision (release to seller or refund buyer), order history with the buyer–seller messages, reports queue, take a listing off sale, pause all new purchases. Every action requires a reason and is audited. Non-administrators get a plain "not found". Hosted test passed (`npm run test:orders:live`, 13 checks).
- [x] Support can suspend or restore a member from an order's details: they cannot list, message, save or trade, and their listings come off sale; orders already under way continue. Database rules tested; hosted check waits for the pending migration.
- [ ] [J] Named support owner, support mailbox, and a review cadence for reports.
- [x] Account deletion from "My account": refused while an order is in progress; otherwise the profile, listings, photos, saved clubs and delivery addresses are removed, the sign-in email is scrubbed and sign-in blocked, the Stripe payout account is closed, and order records are kept. Messages stay visible to the other person as from a "Deleted member" — [J] confirm that with the privacy review. Hosted check passed.

## 7. Legal and policy [J] — get these reviewed; this list is not legal advice

- [x] [D] Drafts written to match what the app actually does and linked in the site footer: `public/buyer-protection.html`, `public/terms.html`, `public/privacy.html`. Each carries a visible "draft for review" banner.
- [ ] [J] Have the three drafts reviewed by a legal adviser and fill in the [bracketed] details (company, addresses, retention periods, liability wording, return postage). Remove the draft banners only then. Prohibited-items and counterfeit-reporting wording is in the terms; expand if the adviser recommends.
- [ ] HMRC digital-platform reporting: UK platforms must collect and report seller details and earnings. Stripe onboarding collects most of the identity data; reporting remains Relofted's duty.
- [ ] Online Safety Act: private messaging between users brings an illegal-content risk assessment duty.
- [ ] ICO registration and a data-retention schedule (order records kept for tax purposes vs. profile deletion).
- [ ] Company/trading entity and business bank account for the Stripe platform account.

## 8. Production readiness [D]/[J]

- [x] [D] Go-live pack: `GO_LIVE.md` (step-by-step runbook) and `supabase/production-setup.sql` (one paste builds a new production database; a test keeps it in step with the migrations).
- [ ] [J] Domain; separate **production** Supabase project and Render service (paid plan — the free plan sleeps and would miss webhooks).
- [x] [D] Every listing has its own address, `/listing/<id>` (19 Nov): a Share button, link previews for messaging apps and social sites (title, price, main photo), Back and Forward, a sitemap and robots file for search engines, and a clear message when a shared listing has gone. Checked in a browser on the preview (`npm run test:listing:browser`), and the purchase browser check passes with it.
- [x] [D] Database changes go through the Supabase command-line tool (`npm run db:status`, `db:plan`, `db:push`), which records what has been applied (19 Nov). The commands are written and reach the connection step; **not yet run against a real database**.
- [ ] [J] Add `SUPABASE_DB_URL` to the local `.env` (Supabase → Connect → Session pooler connection string, with the database password). [D] then runs `npm run db:baseline` once on the development database and confirms `npm run db:status`.
- [ ] Remove the preview password gate for production; keep `noindex` off; tighten CSP.
- [x] Unexpected server errors are logged with the route and stack trace.
- [ ] Error monitoring service and alerting.
- [ ] Database backups with one rehearsed restore.
- [x] Photos are cached privately in the viewer's browser for a day (a replaced photo gets a new address). Still served through the app server; move to signed storage links only if traffic makes it necessary.
- [x] Search matches every word across name, brand and description ("Ping driver" now works).
- [x] Condition and maximum-price filters on browse, saved clubs and my listings.
- [ ] Remove "Development preview" banners and example listings from the production build.
- [x] Phone layout checked by screenshot at 390px: header, filters, listing card, policy pages. Orders show the item photo.
- [ ] Full accessibility pass (keyboard-only use, screen reader, contrast) and a slow-network check.
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
