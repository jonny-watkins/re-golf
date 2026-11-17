# Re Golf development and launch plan

Updated: 17 November 2026

## Latest verified position — 17 November 2026

Hosting update: the password-protected Render Free preview is live at https://re-golf-development.onrender.com, running commit `86c6807`. HTTPS protection, real Supabase reads, multi-account/headless social acceptance and photo upload/download/removal passed on the deployed host. GitHub publication and initial deployment are complete. The owner saved Supabase redirect settings; generated confirmation and recovery links passed headless acceptance on Render, including password change/sign-in and reuse rejection. Hourly cleanup and invitation readiness remain pending. See SETUP.md for access and validation. This update supersedes older hosting-pending statements below.

This record supersedes the historical implementation notes below. Supabase development project `ihndsjxwnogyxcixujwv` is connected. Foundation and photo migrations are applied; do not rerun either. Photos, golf details, listing persistence, owner controls, search, private profiles and multi-user access restrictions passed hosted acceptance. Headless Edge desktop/mobile viewport photo flows passed. The latest recorded local verification is 34 tests, TypeScript and production build passing.

Actual confirmation and recovery email delivery passed on 17 November using the user-controlled AOL test inbox. Supabase verified confirmation; the owner confirmed the recovery form, password replacement and subsequent sign-in worked. Earlier generated-link tests also verified reuse rejection. Inbox/spam placement, detailed rendering and elapsed-time expiry remain unverified. All existing accounts and the new email-test account were preserved. See SETUP.md for evidence and send times.

Persistent favourites and private listing conversations with blocking/reporting are implemented and applied to the development database. All 42 tests, TypeScript, production build, smoke checks, hosted multi-account checks and headless desktop/mobile checks passed. See SETUP.md for limits and the manual report-review procedure. Messages refresh on request; notifications and an admin moderation interface remain future work.

Next milestone: a private listing preview for 5–10 trusted golfers, purchases disabled. Remaining work: legacy function-permission hardening, hourly photo cleanup on the eventual host, remaining email checks, assigning report review, source review/publication, Render configuration and hosted preview acceptance. No Render deployment is recorded. Public deployment and paid resources need separate authorization.

Build Re-Golf into a marketplace where golfers buy and sell directly. Sellers list for free and receive the agreed item price; buyers pay the Re-Golf fee and delivery, plus optional verification when available. Start with a mobile-friendly web app published at a custom domain. Native iPhone and Android apps are a later phase.

This is the working checklist for implementation. Tick items only when the acceptance checks pass, and record decisions and outstanding issues as work progresses.

## Current position

- [x] Inspect the existing project and agree the marketplace model.
- [x] Save this development plan.
- [x] Begin backend implementation.

The original standalone demo now has a TypeScript/Express API, Supabase account integration, and a PostgreSQL migration for profiles and seller-owned listings. The existing design is connected to listing APIs, with create, edit, and archive controls. A Supabase development project still needs to be created and connected; hosted account flows and end-to-end persistence have not yet been verified. See [SETUP.md](SETUP.md).

The original demo used a £2.50 buyer fee, £5.95 standard delivery, £9.95 verification-route postage, and £10 verification charge. These were illustrative, not agreed commercial prices. The earlier £5 fee example was also illustrative. The current interface shows the item price and states that checkout and verification are unavailable.

## Agreed product rules

- Buyers and sellers transact directly through Re-Golf.
- Listing and ordinary selling are free; the buyer pays the platform fee.
- Sellers receive the agreed item price. Payment-provider costs must be accounted for in Re-Golf's margins.
- Show the buyer the full breakdown before payment, including any verification route costs.
- Use Vinted as a product reference, while creating Re-Golf's own design, policies, and implementation.
- Keep fee settings configurable and save the exact amounts against each order.
- A buyer cannot buy their own listing or purchase an item already reserved or sold.
- Seller payment becomes eligible only after the required order completion checks. The payment provider must support the chosen payout flow.

## Initial scope and assumptions

Plan for UK sales in GBP, individual sellers, one listing per checkout, and one available item per listing. Confirm these assumptions before payment implementation. Start with fixed-price purchases; offers, bundles, promoted listings, international shipping, and native apps can follow.

Include accounts, photos, search, favourites, seller listing controls, basic messaging, tracked orders, payments, reporting, and admin support in the public launch scope. Reviews should be tied to completed purchases.

PGA verification is optional scope: launch it only after a partner, inspection process, shipping route, pricing, and failure/refund handling are confirmed. Otherwise remove purchase options and claims implying that the service is available.

## Technical approach

Use a TypeScript application with a server API, PostgreSQL for persistent data, managed authentication, and object storage for photos. Preserve the existing visual design while replacing browser-only demo actions with real application flows.

Selected for the foundation: Vite/TypeScript for the existing browser interface, Express/TypeScript for the server, and Supabase Auth/PostgreSQL for accounts and listings. Supabase Storage is intended for phase 2. Render is selected for hosting, with a development Blueprint in render.yaml. Marketplace payments remain to be selected before their implementation phase. No hosted services are connected yet.

Keep development, staging, and production separate. Store secrets in environment configuration, provide an example configuration without real credentials, and keep database changes in versioned migrations. Financial amounts use integer pence, with all authoritative prices and fees calculated on the server.

## Phase 1 Foundations and first working backend

Owner: development, with the account owner connecting selected services when required.

- [ ] Confirm initial UK/GBP web-app scope and record service choices.
- [x] Set up the application structure, local start commands, environment example, and ignored secret files.
- [x] Add database migrations for profiles and listings, with ownership and timestamps.
- [ ] Add registration, email verification, login, logout, and password recovery using managed authentication.
- [ ] Add public browsing of active listings and authenticated creation, editing, and archiving of a seller's own listings.
- [x] Validate category, condition, text length, and price on the server.
- [ ] Connect the existing browsing and selling interface to persistent records.
- [x] Keep sample records clearly separate from real listings.

Implementation note: account screens and listing API integration are written. Their checkboxes remain open until the hosted acceptance checks in SETUP.md pass. The migration and ownership rules pass local PostgreSQL tests. UK/GBP remains the working scope assumption, to confirm before payments. Browser visual checks remain outstanding because the browser tools could not complete verification.

Acceptance: a seller can register and create a listing; it remains after refresh and is visible from another session. Another seller cannot edit or delete it, even through a direct API request. Anonymous visitors can browse but cannot create listings. No payment is taken.

## Phase 2 Photos and usable selling

16 November implementation update: multiple photos (up to six), main-photo selection, removal, card/gallery images, and optional handedness, shaft flex and loft are implemented locally. Server-side image validation, orientation, resizing, metadata stripping, private storage access, database ownership checks and a retryable cleanup command are included. Apply the new migration and configure the server-only storage secret using [SETUP.md](SETUP.md#enable-listing-photos-and-golf-details). Hosted photo acceptance and the cleanup schedule remain pending, so the acceptance checkboxes below stay open. Persistent favourites and messaging are not part of this update.

- [ ] Add photo uploads with file size, type, and count limits; validate actual file content.
- [ ] Restrict uploads and deletion to the listing owner, strip location metadata, and clean up abandoned uploads.
- [ ] Add seller profiles and a My listings area with draft, active, reserved, sold, and archived states.
- [ ] Add useful golf details such as brand, club type, handedness, shaft flex, and condition.
- [x] Save favourites per account and add search, filters, pagination, empty states, and error states.
- [x] Add private buyer–seller conversations with participant-only access, blocking, reporting, and basic abuse limits.
- [ ] Use safe rendering for user text and avoid exposing private contact or address details publicly.

Acceptance: a seller can publish and manage a listing with real photos on mobile. A second account can find, save, and ask about it. Unrelated accounts cannot read the conversation or alter its photos.

## Phase 3 Checkout and payments in test mode

Dependencies: account owner confirms the buyer fee, delivery approach, business/payment-provider setup, and refund rules.

- [ ] Select a UK-compatible marketplace payment provider and confirm seller onboarding, split payments, payout timing, refunds, disputes, and fees.
- [ ] Connect test credentials and implement seller onboarding with provider-required identity checks.
- [ ] Calculate an authoritative checkout quote from the stored listing price and configured fees.
- [ ] Snapshot item details, seller proceeds, fees, delivery, and verification choices on each order.
- [ ] Reserve the listing atomically so two buyers cannot purchase the same club.
- [ ] Expire abandoned reservations safely and reconcile late payment events.
- [ ] Create hosted checkout sessions on the server; never store raw card details.
- [ ] Verify payment webhook signatures and handle duplicate or out-of-order events safely.
- [ ] Mark orders paid from verified provider events, not the browser success page.
- [ ] Record payment, refund, dispute, and payout references separately from fulfilment status.
- [ ] Implement cancellation and refund paths, including failed payments and seller non-dispatch.

Acceptance: test purchases succeed with the correct breakdown and seller amount. Failed payments, repeated callbacks, late events, and simultaneous buyers cannot create duplicate charges, orders, or sales. Refund and payout accounting reconcile with the provider.

## Phase 4 Delivery and completion

- [ ] Choose supported delivery services suitable for golf-club parcel dimensions and value.
- [ ] Confirm who buys the label, how prices are quoted, tracking requirements, and loss/damage handling.
- [ ] Collect delivery addresses privately and expose them only where needed for fulfilment.
- [ ] Build buyer and seller order pages with dispatch and delivery tracking.
- [ ] Define dispatch deadlines, the buyer issue window, automatic completion, and escalation rules.
- [ ] Trigger seller payout eligibility only when completion rules and provider requirements are satisfied.
- [ ] Allow buyers to report non-arrival or an item not matching its description; pause completion while reviewed.
- [ ] Send transactional emails for important account and order events.
- [ ] Allow one review per eligible participant after a completed purchase.
- [ ] If verification launches, add inspection receipt, pass/fail, onward dispatch, and return/refund steps.

Suggested ordinary order progression: awaiting payment → paid → dispatched → delivered → completed. Cancellation, refund, and dispute handling need explicit transitions and an audit trail. Verification orders need additional inspection stages.

Acceptance: a full test order progresses from purchase to delivery and payout eligibility. Reported issues suspend automatic completion. Cancellation and refund scenarios work without leaving an item incorrectly available or sold.

## Phase 5 Admin and launch readiness

- [ ] Add role-protected admin tools for listings, users, reports, orders, and disputes.
- [ ] Audit sensitive admin actions and require stronger authentication for administrators.
- [ ] Publish marketplace terms, privacy information, buyer-fee disclosures, prohibited-item rules, and delivery/refund policies appropriate to the actual service.
- [ ] Arrange appropriate review of consumer, privacy, marketplace, and seller-reporting obligations before accepting real transactions.
- [ ] Provide a support address and a practical procedure for counterfeit reports, complaints, and payment disputes.
- [ ] Add account deletion/data-request handling with required transaction retention separated from public profiles.
- [ ] Add error monitoring, rate limiting, database backups, and a tested restore procedure.
- [ ] Check keyboard navigation, form labels, mobile layouts, loading states, and slow-network behaviour.
- [ ] Test authorization boundaries for listings, photos, messages, orders, and admin routes.
- [ ] Run integration checks for payment reconciliation, stock reservation, refunds, and payout eligibility.
- [ ] Review production configuration, secret handling, dependency security, and upload controls.

Acceptance: core flows pass on staging, access-control checks pass, support and policies are in place, and a backup can be restored. No demo-only claims or pretend checkout controls remain in the live purchase flow.

## Phase 6 Publish and controlled launch

- [ ] Connect hosting, production database/storage/authentication, and the custom domain with HTTPS.
- [ ] Configure production email delivery and authentication callback URLs.
- [ ] Complete payment-provider approval and connect live credentials and webhooks securely.
- [ ] Apply migrations, verify monitoring/backups, and document deployment and rollback commands.
- [ ] Invite a small pilot group and test listing, buying, dispatch, support, and seller payout end to end.
- [ ] Complete an authorised low-value live transaction and refund to verify production money movement.
- [ ] Fix pilot blockers and confirm readiness before opening public purchases.
- [ ] Publish publicly and monitor failed payments, order issues, support demand, and operating margins.

Acceptance: the app works at its public domain, real buyers and sellers can complete transactions, payouts and refunds reconcile, and support can resolve an issue. Publishing the landing page alone does not complete this milestone.

## What the account owner needs to do

| When | Action |
| --- | --- |
| Before connecting hosted services | Create or connect the selected hosting, database/authentication, and storage accounts. Development can begin locally first. |
| Before checkout work | Set the buyer-fee formula and confirm whether UK-only, individual sellers, and single-item orders match the intended launch. |
| Before delivery work | Choose a shipping approach and confirm golf-club parcel pricing and responsibility for lost or damaged parcels. |
| Before verification is offered | Agree the PGA partner arrangement, inspection standard, pricing, and failed-inspection process. |
| Before live payments | Supply the payment provider's required business, identity, and bank information directly through its secure onboarding. |
| Before public launch | Connect a domain, support mailbox, and approved policies; agree the pilot and live transaction checks. |

Do not put passwords, payment secrets, or identity documents in this repository or chat. Use provider dashboards and deployment secret settings.

## Working data model

Start with profiles and listings. Add listing photos, favourites, conversations, messages, orders, order events, payment events, shipments, reviews, reports, and admin audit events as their phases begin. Add inspections only if verification proceeds.

Store private addresses separately from public profiles. Enforce ownership and participant access on the server/database. Keep order amounts and item snapshots stable when a listing or fee setting later changes. Keep provider event identifiers unique for safe retries.

## Next work session

Actual confirmation/reset email delivery, password replacement and subsequent sign-in passed. Remaining email checks are inbox/spam placement, detailed rendering and elapsed-time expiry. Follow the latest verification record in SETUP.md; hosted multi-user and photo acceptance already passed. Continue with function-permission hardening and preview work. Do not rerun the foundation or photo migrations.

Render preparation is also complete locally: network binding, public-origin detection, proxy-aware rate limiting, health checks, graceful shutdown, explicit Node version, CI workflow, and a development Blueprint. Next external steps are connecting the Render/Supabase integrations, publishing the reviewed source to GitHub, and creating the development deployment. These do not complete the phase 6 public-launch milestone.

## Progress log

| Date | Progress | Next action |
| --- | --- | --- |
| 14 November 2026 | User confirmed signing in to the connected app. | Save the first test listing, then verify persistence and owner controls. |
| 14 November 2026 | User applied the foundation migration. Verified hosted listings read returns HTTP 200 with an empty marketplace, and anonymous profile access is denied. | Create and confirm the first app account, then verify listing creation and two-account ownership. |
| 14 November 2026 | Connected the supplied Supabase project locally with its publishable key. Auth settings returned HTTP 200 with email confirmation enabled. Listings query returned PGRST205 because the table is not yet present. | Apply the foundation SQL migration, then test two-account listing ownership and persistence. |
| 14 November 2026 | Inspected the static demo, confirmed direct selling and buyer-paid fees, and created the launch checklist. Backend implementation has not started. | Begin phase 1 foundations. |
| 14 November 2026 | Implemented the API, account screens, listing integration, and database migration. All 17 local automated checks and production build passed; HTTP preview responded successfully. Hosted integration and browser verification remain pending. | User creates Supabase development project; follow SETUP.md to connect and verify. |
| 14 November 2026 | Prepared Render hosting and connection instructions. All 19 local automated checks, build, and production smoke checks passed. Render/Supabase integrations discovered but not connected; no cloud resources created and source not pushed. | User connects accounts; apply migration and deploy a development preview. |
