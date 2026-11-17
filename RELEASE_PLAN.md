# Re Golf release plan

Updated: 17 November 2026. Status: password-protected Render development preview deployed; authentication URL configuration and invitation readiness remain pending. Not a public marketplace launch.

Release Re-Golf in three steps: a private listing preview, an invited transaction pilot, and a public UK marketplace. Public purchases should open only after payments, delivery, refunds, seller payouts, and support have worked end to end.

This plan defines release gates and rollout responsibilities. [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) remains the detailed implementation checklist; [SETUP.md](SETUP.md) contains setup and account acceptance checks.

## Starting position

The repository contains the web interface, Express API, Supabase account integration, seller-owned listing migration, local tests, CI configuration, and a Render development deployment configuration. Listings support creation, editing, archiving, search, and pagination. Favourites persist per account. Private listing conversations include blocking, reporting, paged history and database-enforced abuse limits.

The latest 17 November records confirm hosted listing persistence, multi-user ownership/privacy checks, real photo uploads and processing, and headless Edge desktop/mobile viewport acceptance. All 34 local tests, TypeScript and the production build passed. Real confirmation and recovery emails reached the user-controlled AOL test inbox; confirmation, password replacement and subsequent sign-in passed. Earlier generated-link tests verified reuse rejection. Inbox/spam placement, detailed email rendering and elapsed-time expiry remain unverified. A Render deployment is not recorded as complete.

Photo uploads, golf details, persistent favourites and private messaging with blocking/reporting are implemented and verified. The latest social-feature acceptance passed all 42 automated tests, TypeScript, production build, smoke checks, hosted multi-account checks and headless desktop/mobile checks. Reports require manual review in the restricted Supabase dashboard; appoint an owner and review cadence before invitations. Checkout, orders, delivery, reviews, admin support and message notifications still need implementation. Legacy function-permission hardening and hourly photo cleanup scheduling remain outstanding. Every release candidate must pass fresh checks.

## Launch scope

Plan for a mobile-friendly website, UK sales in GBP, individual sellers, fixed prices, and one item per checkout. Confirm these assumptions before checkout implementation. Sellers list free and receive the agreed item price; buyers pay the platform fee and delivery. The fee must cover the chosen operating model, including payment-provider costs.

The public release includes accounts and recovery, real listing photos, golf-specific details, search and filters, saved favourites, private messaging, seller controls, checkout, tracked orders, refunds and issue handling, seller payouts, purchase-linked reviews, reporting, and admin tools.

Defer offers, bundles, promoted listings, international sales, and native mobile apps. Keep professional verification out of the initial release unless its partner, inspection process, prices, delivery route, and refund handling are agreed and tested. Remove any claims suggesting it is already available.

## Proposed schedule and responsibilities

Allow roughly 10–16 working weeks from a staffed kickoff, assuming one dedicated developer, prompt business decisions, and access to required accounts. These are planning allowances, not a committed launch date. Provider onboarding, policy review, or pilot delivery cycles may extend elapsed time. Re-estimate after the private preview.

| Stage | Allowance | Main outcome | Proposed owner |
| --- | --- | --- | --- |
| Confirm foundations and decisions | 1 week | Hosted account and listing checks pass; commercial decisions assigned | Developer and Jonny |
| Private preview | 2–3 weeks | Invited users can list, find, save, and discuss equipment | Developer; Jonny recruits testers |
| Transaction implementation | 3–5 weeks | Staging purchases, delivery, refunds, and payouts reconcile | Developer; Jonny completes provider setup |
| Operational readiness | 2–3 weeks | Admin, support, policies, monitoring, and recovery ready | Developer and Jonny; policy reviewer as needed |
| Invited pilot and public rollout | 2–4 weeks | Real orders complete successfully before public purchases open | Jonny makes release decision; developer operates deployment |

Some work can overlap, especially provider onboarding and policy preparation. Each release still depends on its preceding acceptance gate. Name a support owner and a backup before the pilot; Jonny is the proposed business and release owner until roles are assigned.

## Release 1 Private listing preview

Audience: a proposed group of 5–10 trusted golfers. Purchases remain unavailable.

Complete the hosted registration, confirmation, sign-in, logout, and recovery checks. Verify that a listing survives refresh and appears in a separate session, and that a second account cannot edit or archive it through either the interface or direct API requests. Do not rerun the already-applied foundation migration.

Add real photos with upload limits, ownership checks, metadata removal, and cleanup; golf details; persistent favourites; and private messaging with blocking and reporting. Finish usable listing management and search on mobile. Provide a way for the owner to handle reports during the preview.

Deploy a clearly labelled development preview using the existing Render setup after reviewing and publishing the intended source. Configure authentication callbacks for that address and keep preview data separate from future production data.

Release gate:

- [ ] Two-account acceptance passes for accounts, listings, photos, and messages.
- [ ] A tester can publish, find, save, edit, and archive an item on mobile without developer intervention.
- [ ] Keyboard use, validation, loading, empty, and failure states are usable.
- [ ] Automated tests, build, and production smoke checks pass on the exact candidate commit.
- [ ] Preview feedback has an owner and all blocking defects are resolved.

## Release 2 Invited transaction pilot

Audience: a proposed group of 10–20 invited buyers and sellers. Begin only after the transaction and operational readiness stages pass.

Build and verify payments in provider test mode first. Implement seller onboarding, server-calculated quotes, fixed order price snapshots, atomic item reservation, reservation expiry, verified and repeat-safe webhooks, order tracking, refunds, disputes, and controlled payout eligibility. Handle late payment events without selling an item twice.

Add private delivery addresses, shipping and tracking, dispatch deadlines, issue windows, completion rules, transactional emails, and purchase-linked reviews. Provide protected admin tools and an audit trail for reports, orders, refunds, and disputes. Resolve the policy and support work before real transactions begin.

Release gate:

- [ ] Successful, failed, abandoned, concurrent, duplicate-event, and late-event payment scenarios pass on staging.
- [ ] Refunds, non-dispatch, non-arrival, description disputes, and payout holds work; provider totals reconcile with order records.
- [ ] Unrelated accounts cannot access addresses, messages, orders, or admin actions.
- [ ] Production services, domain, email, approved provider account, policies, support mailbox, monitoring, and backups are ready.
- [ ] Restore and deployment rollback rehearsals pass, and checkout can be disabled independently of order support and payment event processing.
- [ ] Jonny authorises the invited live pilot and its transaction limits.

Run an authorised low-value live purchase through dispatch, delivery, completion, and seller payout, plus a live refund check. Track every pilot order through its final outcome. Keep invitations and transaction volume within the support owner's daily capacity; agree the cap before enabling purchases.

## Release 3 Public marketplace

Open browsing and purchases publicly once the pilot proves both the customer journey and the operating process. Start promotion gradually so support can keep up.

Release gate:

- [ ] At least five genuine pilot orders from more than one buyer and seller have completed, including reconciled seller payouts. This is a proposed minimum, not evidence of scale readiness.
- [ ] The live refund check has reconciled and no unexplained money movements remain.
- [ ] There are no unresolved defects involving privacy, account access, incorrect charges, duplicate sales, refunds, or payouts.
- [ ] All other launch-blocking defects are resolved; accepted minor issues have an owner and target date.
- [ ] Support has processed an issue exercise and can locate the order, contact participants, and record the resolution.
- [ ] Performance meets an agreed mobile test budget at the expected initial traffic level.
- [ ] The developer records readiness evidence and Jonny records the go/no-go decision.

The pilot observation period must cover actual delivery, buyer issue windows, and payouts. A quiet week without completed orders does not satisfy the gate.

## Decisions that unblock delivery

| Decision | Needed by | Owner | Required outcome |
| --- | --- | --- | --- |
| UK, GBP, individual sellers, single-item orders | Before checkout design | Jonny | Confirm launch boundaries |
| Buyer fee and operating margin | Before checkout design | Jonny | Formula, rounding, refund treatment, and worked order examples |
| Marketplace payment provider | Before payment implementation | Jonny and developer | Confirm onboarding, delayed payout flow, refunds, disputes, and costs |
| Shipping model | Before delivery implementation | Jonny | Supported parcels, label buyer, tracking, prices, and loss/damage responsibility |
| Dispatch, issue, completion, and refund rules | Before order implementation | Jonny | Explicit deadlines and escalation rules |
| Verification | Before scope freeze | Jonny | Defer, or fund and specify the complete service |
| Support, policies, domain, and operating budget | Before live pilot | Jonny | Named coverage, reviewed policies, connected services, and approved costs |

Illustrative fees in the original demo are not launch prices. Review applicable obligations and policies with a suitable reviewer before taking real transactions; this plan does not determine legal requirements.

## Release procedure

1. Freeze the candidate scope. Record the commit, migration list, configuration changes, known issues, test results, and responsible release owner in a release record. Review the existing local changes before committing; do not include secrets.
2. Run `npm ci`, `npm test`, `npm run build`, and `npm run test:smoke`. Require successful GitHub CI for the same commit and complete staging browser checks for that release's journeys.
3. Review production configuration, authentication redirects, email delivery, provider webhooks, storage permissions, monitoring, and service capacity. The supplied Render Blueprint is for development; review production capacity and costs before the pilot.
4. Confirm a usable database backup and tested recovery process. Apply reviewed migrations with a compatibility plan for the prior application version. Prefer additive changes during launch.
5. Deploy the recorded candidate with purchases disabled initially. Verify the homepage, assets, health endpoint, actual database reads, sign-in, listing operations, and restricted access. A health endpoint alone does not prove the database works.
6. Enable the appropriate cohort or public purchases only after its release gate passes. Confirm a permitted transaction and monitor order and provider events.
7. Record the deployment time, version, gate evidence, owner decision, and any follow-up issues. Tag the approved release and retain the previous deployable version.

Cohort restrictions and a server-enforced checkout switch are implementation tasks before the pilot; they are not available in the current app.

## Stop and recovery rules

Immediately suspend new purchases for duplicate sales, incorrect charges or payouts, private-data exposure, or a failure to reconcile paid orders. Also pause rollout if checkout or webhook processing repeatedly fails, or support cannot handle incoming issues.

The developer disables new checkout and investigates; the support owner tracks affected orders and informs affected users. Keep order access, verified payment events, refunds, and support operating wherever safe. For a privacy incident, restrict the affected access path immediately.

Redeploy the previous known-good application only if it is compatible with the current schema. Otherwise keep purchases disabled and apply a forward fix. Do not blindly restore a pre-release database over new orders: preserve financial events and reconcile them with the provider before reopening. Rehearse exact hosting and recovery commands before the pilot.

## Monitoring after launch

For the first 48 hours, review errors and payment events frequently during staffed coverage and after each initial transaction. Review orders, provider reconciliation, and support at least daily for the first two weeks. Assign explicit out-of-hours alert coverage before enabling unrestricted purchases.

| Measure | Initial action rule |
| --- | --- |
| Charges, refunds, and payouts versus order records | Investigate every unexplained difference; pause purchases for money integrity failures |
| Duplicate sales or unauthorised access | Zero tolerance; suspend the affected flow immediately |
| Failed checkout and delayed payment events | Alert on repeated failures; set numeric thresholds from staging and pilot results |
| Paid orders awaiting dispatch or resolution | Review daily against agreed deadlines; contact the responsible party |
| Support backlog | Proposed target: first response within one working day; reduce invitations or promotion if coverage falls behind |
| Listing publication and purchase completion | Review weekly to find where users abandon the journey |
| Revenue less payment, shipping subsidy, refund, and support costs | Review weekly against the approved margin assumptions |

At two weeks, prioritise defects and operational friction. At four weeks, review conversion, completed orders, support demand, repeat use, and margins before increasing promotion or adding deferred features.

## Immediate next actions

1. Finish the remaining email checks: inbox/spam placement, detailed rendering and elapsed-time expiry. Actual confirmation/reset delivery and password replacement/sign-in passed; see SETUP.md.
2. Harden flagged function permissions and prepare hourly photo cleanup on the eventual host.
3. Assign report review for the completed favourites/messaging preview; confirm commercial assumptions before checkout work.
4. Review and publish the intended source, run CI, and deploy the private development preview.
5. Recruit preview testers and re-estimate the transaction work using their feedback and the selected provider's requirements.
