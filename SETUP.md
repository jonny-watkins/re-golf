# Connect Re Golf accounts and listings

## GitHub publication — 17 November 2026

Reviewed source was published to `main` as commit `43d8356` (marketplace backend and protected development preview). The candidate passed 43 automated tests, TypeScript, the production build, smoke checks and a redacted staged-secret scan. GitHub [App checks](https://github.com/jonny-watkins/re-golf/actions/runs/44073489549) passed on that exact commit, including clean dependency installation. `.env`, build output and test screenshots were excluded. The Render Blueprint now includes the server-only photo-storage setting and generates a preview password; the app requires preview access on Render. Render deployment is not complete: the Render plugin still needs connecting. The repository's pre-existing GitHub Pages workflow also ran, but static Pages cannot serve the Express API and does not constitute the application deployment. Existing Supabase accounts and data are unchanged. This record supersedes earlier statements that the source has not been pushed.

## Favourites and messaging verified — 17 November 2026

Persistent account favourites and private listing conversations are implemented and applied to the development Supabase project. The new local migration is `supabase/migrations/20261117110226_favourites_messaging.sql`, recorded on the host as `20261117110623_favourites_messaging`; do not rerun it or either earlier migration. This section supersedes historical statements that favourites are session-only or messaging is not implemented.

Use a listing's heart to save/remove it. The header heart opens all saved active clubs, with search, category filters and pagination. Sign-in is required; favourites persist across reloads and devices. Archived listings disappear from saved browsing.

Use **Message seller** on an active listing, or **Messages** in the header. Conversations are restricted to their buyer and seller. Messages are plain text, limited to 2,000 characters, with paged history and a Refresh button (no live push or unread notifications yet). Existing conversations remain accessible after archival. Block/unblock applies to both directions across all conversations between the pair; history remains readable and reportable. Only the blocker can remove their block. Reports are private to the reporter and project operators.

Database permissions, RLS and invoker triggers enforce ownership, immutable participants/senders/timestamps, active-listing conversation creation, bilateral blocking and per-account limits even through direct Supabase access. Limits: 20 messages/minute, 10 new conversations/hour, five reports/hour, one report per person per conversation. Requests carry a client message ID to avoid duplicate sends on retry. The private trigger cannot be invoked directly by client roles. No new SECURITY DEFINER function was added.

Validation: all 42 automated tests, TypeScript, production build and production smoke checks passed. Hosted checks verified favourites persistence/isolation, duplicate handling, private messages, direct write rejection, bilateral blocks, report privacy and archived visibility. Headless Edge checks verified reload persistence, inbox/sending, escaped text, block/unblock, report submission, sign-out clearing and a 390px viewport. Screenshots were reviewed in `artifacts/social-flow/`. Only the test run's three disposable users and their records were removed; existing accounts and listing were preserved. No desktop control or secret output was used. Repeat after building with `$env:TEST_PROJECT='ihndsjxwnogyxcixujwv'; npx tsx scripts/test-social-live.ts` and the temporary Playwright dependency described below.

### Reviewing reports during the private preview

Reports are stored, not emailed. The project owner must check `public.conversation_reports` in the restricted Supabase dashboard during preview operation. Filter `status = 'open'`, inspect the referenced conversation and its messages, and record handling by changing status to `reviewed` or `resolved`. Do not grant ordinary users report-administration privileges. Blocking is user-controlled; an admin moderation interface, automated alerts, account suspension and audit records are separate future work. Assign a review owner and cadence before inviting testers. Retain conversations and reports as evidence; deletion/retention workflows require explicit design before public launch.

Security advisor review: new tables have RLS and narrowly scoped client grants. Their schema names are discoverable to signed-in users, while rows remain access-controlled and tested; see [schema visibility guidance](https://supabase.com/docs/guides/database/database-linter?lint=0027_pg_graphql_authenticated_table_exposed). The previously recorded legacy function EXECUTE warnings, storage-cleanup policy notice and disabled leaked-password protection remain separate follow-up work; see [function permissions](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

The performance advisor reported the existing two SELECT policies on listings and the newly created, not-yet-used `reports_open` index. The latter supports the manual open-report queue and is intentionally retained; see [unused-index guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index). Post-test verification found the original two accounts and one listing intact, and no remaining test conversations, messages, favourites, blocks or reports.

## Email delivery verified — 17 November 2026

The Supabase plugin first verified that the user-controlled test address did not exist. A real signup request using the app's Supabase SDK call was accepted at 10:45:48 UTC, returning an unconfirmed account. The headless UI attempt could not open the account form and did not submit; the direct SDK request required approved network access. No generated/admin confirmation link was used. Existing accounts were preserved; no passwords, tokens or authentication links were displayed or saved.

The inbox owner reported completion, and the Supabase plugin verified email confirmation at 10:46:43 UTC. A real recovery request using the app's SDK call was accepted and recorded sent at 10:47:15 UTC with callback `http://localhost:3000/?auth=recovery`. The owner confirmed the received link opened the password form, then confirmed password replacement and subsequent sign-in worked. Actual confirmation and recovery delivery, confirmation, password replacement and sign-in passed. Inbox/spam placement and rendering details were not separately reported; elapsed-time expiry remains untested. No passwords or links were collected. All accounts, including this new account, were retained in accordance with the user's preservation instruction. This record supersedes delivery-pending statements in the historical notes below.

## Photo setup verified on 17 November 2026

Confirmation and recovery link acceptance passed with `scripts/test-auth-links.ts`: a real Supabase-generated signup link confirmed a disposable account and signed in through the browser callback; a recovery link opened the password form, the UI changed the password, the old password was rejected and the replacement accepted. Both links rejected reuse, and the returned invalid/expired-link message displayed with the callback fragment cleared. The account/profile were removed. Links were generated without sending email, and callback parameters were routed to an isolated test server after validating the configured redirect origin. This does not verify inbox delivery, email rendering, or expiration by elapsed time. Actual confirmation/reset email delivery remains pending a user-controlled test inbox. Repeat after building and installing the temporary Playwright dependency: `$env:TEST_PROJECT='ihndsjxwnogyxcixujwv'; npx tsx scripts/test-auth-links.ts`.

Hosted multi-user acceptance passed using `scripts/test-multi-user.ts`: three confirmed sellers plus one unconfirmed account. Confirmed sign-in, unconfirmed sign-in denial, automatic private profiles, separate My listings, public active listings, cross-account API/database edit/archive/delete denial, seller-ID forgery rejection, photo ownership, owner editing, archived listing/photo privacy and sign-out passed. All four disposable accounts and associated data were removed; the original account and listing remain. Email delivery and password-reset links are not covered by these admin-created test accounts. Repeat with `$env:TEST_PROJECT='ihndsjxwnogyxcixujwv'; npx tsx scripts/test-multi-user.ts` using the development `.env` and network access.

Hidden-browser photo acceptance also passed on 17 November using an isolated headless Edge session and the built frontend: UI sign-in, two-photo previews/uploads, refresh persistence, gallery selection, golf details, main-photo changes, removal/replacement, and 390px mobile layout without horizontal overflow or JavaScript errors. Desktop and mobile screenshots were inspected and saved under `artifacts/photo-flow/`. All disposable hosted data was removed. No desktop windows were controlled. TypeScript and the production build passed.

To repeat this browser check, install the temporary test dependency with `npm install --no-save --package-lock=false playwright@1.58.2`, run `npm run build`, then `$env:PHOTO_TEST_PROJECT='ihndsjxwnogyxcixujwv'; npx tsx scripts/test-photos-browser.ts`. It requires installed Microsoft Edge, network access, and the existing server-only configuration. A real phone/device check remains separate from this mobile viewport check.

The Supabase plugin inspected the project configured in `.env` (`ihndsjxwnogyxcixujwv`) and applied `202611160001_listing_photos.sql` as the hosted `listing_photos` migration. The foundation already existed and was not rerun. The storage secret is configured locally and was not displayed.

All 34 local tests and the TypeScript check passed. Background acceptance through the real app API and hosted Auth, database and Storage passed: six concurrent uploads accepted and a seventh rejected, orientation/resize/EXIF removal, invalid/oversized upload rejection, ownership enforcement, direct client write denial, main-photo selection, removal/replacement, archived-photo visibility and secret isolation. Temporary test accounts, listing, objects and cleanup entries were removed. No desktop control was used.

Repeat the hosted checks with `$env:PHOTO_TEST_PROJECT='ihndsjxwnogyxcixujwv'; npx tsx scripts/test-photos-live.ts`. This explicitly opts into temporary hosted test writes; it requires network access and the existing `.env` credentials. Test credentials and error response bodies are suppressed.

The security advisor reported expected schema visibility for readable tables and no client policy on the server-only cleanup queue. It also reported inherited client EXECUTE grants on `create_user_profile`, `queue_photo_cleanup` (trigger functions), and anonymous EXECUTE on `is_verified_seller`; these remain for permission hardening. The privileged photo management/pruning functions deny client execution. Leaked-password protection is disabled. See [function permissions](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable) and [password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Hourly cleanup scheduling, actual email delivery/elapsed-time expiry and hosting deployment remain pending. Browser visual acceptance passed as described above. Earlier setup notes below describe the state before this verification and are superseded by this record. Do not rerun the foundation or photo migration: the photo migration is recorded on the host as `20261117092358_listing_photos`.

### Actual email delivery acceptance (pending)

Use a user-controlled test address separate from the original account. Never request an inbox password or copy authentication links into chat, logs or screenshots. Submit real signup through the app, record the send time, and have the inbox owner confirm receipt, inbox/spam placement, readable content and the confirmation outcome. Then request a real recovery email for that disposable account and confirm receipt and the password-change outcome. Record receipt separately from successful API submission. Generated/admin links do not satisfy either delivery check. Test elapsed-time expiry separately; link reuse rejection is not expiry evidence. Remove only the disposable account created for this check after acceptance, and preserve the original account/listing.

## Enable listing photos and golf details

The 16 November photo update is implemented locally. Apply this **new** migration once in the existing development project's SQL Editor: [202611160001_listing_photos.sql](supabase/migrations/202611160001_listing_photos.sql). Do not rerun the foundation migration. The update adds optional handedness, shaft flex and loft, a six-photo limit, a private storage bucket, access rules and a durable cleanup queue. Until it is applied, the app detects the old schema and continues to support basic listings with the new controls disabled.

For uploads, put the project's server-only `sb_secret_...` key into the ignored local `.env` as `SUPABASE_STORAGE_SECRET`. Enter it directly in your editor or hosting secret settings, not in chat. Keep `SUPABASE_PUBLISHABLE_KEY` unchanged. Never give the secret a `VITE_` prefix or put it in frontend code. Restart `npm run dev` after changing configuration, then refresh the browser. The `/api/config` response exposes only capability flags and public configuration, never this secret. A new migration is detected within ten seconds, followed by a browser refresh.

Only the server writes photos. It authenticates the seller, checks listing ownership, decodes JPEG/PNG/WebP files, rejects animation and files over 8 MB or 40 megapixels, applies orientation, strips metadata, and stores a WebP image no larger than 1600 pixels on either side. The bucket stays private: image requests pass through `/api/photos/:id`, which applies listing visibility rules and sends `Cache-Control: no-store`. Archived photos remain available to their owner. Do not add public/client upload policies to this bucket.

The design follows [Supabase storage access control](https://supabase.com/docs/guides/storage/security/access-control) and [Sharp output behaviour](https://sharp.pixelplumbing.com/api-output/). The storage secret has privileged access, so keep it on the server and rotate it if exposed.

Run `npm run photos:cleanup` with the server configuration to remove failed/abandoned uploads and queued deleted images. Pending uploads older than one hour are queued; failed storage deletions remain queued for retry. Schedule this command hourly on the eventual host and monitor failures. A scheduler is not provisioned by this repository. Photos selected but never saved stay in the browser and do not create storage objects. Do not delete object rows through SQL; the cleanup command uses the Storage API to remove the actual files.

Acceptance checks after setup:

1. Create a listing with two real photos and golf details. Refresh; confirm its main photo appears on the card, both images open in the gallery, and details persist.
2. Edit it, choose another main photo, remove a photo, and add a replacement. Changes to existing photos save immediately; new files upload on Save listing. Confirm another refresh preserves the result.
3. Try a seventh photo, a file over 8 MB, a disguised non-image, and an animated file. All must be rejected. Test a phone photo with rotation/location metadata; orientation must be correct and the served WebP must have no EXIF metadata.
4. With a different verified account, try upload, main-photo and removal endpoints against the first seller's listing. They must fail. Direct client writes to the photo table, management function and storage bucket must also fail.
5. Archive the listing; anonymous visitors and the second account must no longer fetch its images, while its owner can view them in My listings.
6. Interrupt an upload, retry, then run cleanup after the one-hour grace period. Confirm the listing is not duplicated, successfully saved photos remain, and unused storage objects are removed.

The new hosted migration, secret configuration, hourly cleanup schedule, and full browser upload acceptance are pending. Automated image, API and local database checks cover these controls but do not replace a real Supabase Storage check.

Validation on 16 November: 31 automated checks passed, TypeScript/production build passed, and production smoke checks passed. The connected local preview returned HTTP 200 for health, configuration and listing reads with both new capability flags disabled, confirming basic browsing still works before migration. Visual verification of the new controls could not be completed: browser integration was unavailable and the two selected Chrome windows were minimized.

The first backend and Render deployment configuration are implemented locally. To use real accounts and persistent listings, connect a development Supabase project using the steps below. No payment provider or domain is needed yet.

## Simplest way to continue together

Create your Supabase and Render accounts, then add and connect their integrations in ChatGPT. Both integrations were found in the plugin directory but are not yet connected in this session. Once access is available, the next steps are to inspect the intended development project, apply the migration, configure the app, and deploy. Complete account creation/sign-in yourself; no passwords or private service keys need to be pasted into chat.

The repository already points to `https://github.com/jonny-watkins/re-golf.git`. The current backend and deployment changes are local and have not been pushed. Render cannot deploy these changes until the source is committed and pushed. Account connections and source publication are still outstanding.

## What you need to do now

Connection progress: the supplied project URL and publishable key are saved in the ignored local `.env` file. Supabase Auth returned HTTP 200 with email confirmation enabled. After the user ran the migration, the listings query returned HTTP 200 with zero listings. An anonymous profiles query was denied, as intended. No private access tokens were used. The Supabase integration is not connected in this session.

The immediate next step is to create and confirm the first app account through the local preview, then run the listing acceptance checks below. The Supabase project connection and initial database migration are complete; do not run the initial migration again.

1. Open [Supabase](https://supabase.com/dashboard) and create your account.
2. Create a new project called `re-golf-development`. Choose a suitable UK region if available. Save the database password in your password manager; this application does not need that password.
3. Find the project's URL and **publishable** API key in the project connection/API settings. The URL looks like `https://your-project.supabase.co`; the key begins `sb_publishable_`. These are the two values needed by this app. Do not use a secret or service-role key. Supabase explains the distinction in its [API key documentation](https://supabase.com/docs/guides/getting-started/api-keys).
4. In this project folder, copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Keep the other values as supplied for local development. `.env` is ignored by Git.
5. In the Supabase SQL Editor, run the contents of [the foundation migration](supabase/migrations/202611140001_foundations.sql) once. It creates profiles, listings, and ownership rules. Use a new development project, not a database containing unrelated tables with the same names. If an error appears, stop and share the error text without credentials; do not remove security policies to get past it.
6. In Authentication settings, enable email/password accounts and keep email confirmation enabled. Set the minimum password length to 12. Under URL Configuration, use `http://localhost:3000` as the Site URL and allow these exact redirect URLs:
   - `http://localhost:3000/`
   - `http://localhost:3000/?auth=recovery`
7. Restart the local app with `npm run dev`, then open `http://localhost:3000`.

If you want assistance with the connection, tell me when the project is created. You can put the two public connection values in `.env` yourself. Never send the database password, secret API key, or identity documents in chat.

Supabase documents [email/password flows](https://supabase.com/docs/guides/auth/passwords) and [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls). Its default email service has testing restrictions; configure a supported custom SMTP sender before inviting general users. Do not disable email confirmation as a workaround.

## Local development commands

Requires Node.js 22.12 or later supported by the installed dependencies; this implementation was checked on Node.js 22.22.0.

```powershell
npm ci
npm run dev
```

The server runs on localhost port 3000 and serves both the browser app and API. Open it through that address rather than opening `index.html` directly. Without Supabase configuration it displays labelled examples and prevents account/listing writes. It does not silently save real listings in browser storage.

```powershell
npm test
npm run build
npm start
```

Stop a server with Ctrl+C before starting another on the same port. The production build can be checked with `npm run test:smoke` after a successful build. Render configuration is now provided below, but no hosted deployment has been created.

## Deploy the development preview on Render

The tracked [render.yaml](render.yaml) defines one Node web service in Frankfurt using the Free plan for initial testing. It creates no paid database or other paid resources. Automatic redeployment is off during setup. Review the plan shown in Render before applying it; a public launch should use an appropriately sized paid service after the pilot.

1. Finish the Supabase setup above, including the SQL migration, before deploying.
2. Commit and push the reviewed project files to the Re-Golf GitHub repository. Do not include `.env`, `node_modules`, or `dist`.
3. In Render, connect the repository and create a Blueprint from its `render.yaml` file. Render will ask for `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and server-only `SUPABASE_STORAGE_SECRET`. Supply the development project's configuration directly in Render's environment settings; never commit or share private values in chat. The Blueprint generates `PREVIEW_ACCESS_PASSWORD`. Retrieve it privately in Render and use username `preview` to open the app. All application pages and APIs require preview access; only the health probe remains public. The app fails closed on Render if the preview password is missing or shorter than 24 characters. Rotate the password to revoke shared access. This gate restricts the web app; Supabase's separate RLS remains authoritative for database access.
4. The Blueprint installs dependencies, builds the app, and runs `npm start`. The app binds to Render's network interface and assigned port, and uses its assigned HTTPS address automatically. Do not copy the local `APP_ORIGIN=http://localhost:3000` into Render.
5. Copy the actual `https://…onrender.com` address from the successful deployment. In Supabase Authentication URL Configuration, set that address as the development project's Site URL and allow the exact deployed `/` and `/?auth=recovery` redirect URLs. Retain localhost redirect entries if local testing is still needed.
6. Run every hosted acceptance check below. A successful Render health check proves that the server is running; it does not prove database migrations, email delivery, or the account flow work.

For a future custom domain, set `APP_ORIGIN` in Render to that exact HTTPS origin and update Supabase's Site URL and redirect allowlist at the same time. Use the configured domain consistently for account flows and writes.

Render's proxy setting defaults to one trusted hop. Verify client-IP separation on the deployed service before inviting users; do not set Express to trust every forwarded address. Rate limits are currently in-memory and intended for one instance. Multi-instance scaling requires a shared limiter.

Production and development should eventually use separate Supabase projects and Render services. This Blueprint is a development preview, not the finished public marketplace. Do not use it for live payments or real transactions.

Official deployment references: [Render Blueprints](https://render.com/docs/blueprint-spec), [web-service network requirements](https://render.com/docs/web-services), and [Render environment variables](https://render.com/docs/environment-variables).

## Checks after connecting Supabase

- [x] Sign in to the connected app (confirmed by the user).
- [ ] Create seller A's first listing and verify it is saved to the database.
- [ ] Refresh the page and restart the server; the listing remains.
- [ ] In another browser/session, browse without signing in and see the active listing.
- [ ] Create seller B. Seller B cannot see A's listing under My listings or edit/archive it through the API.
- [ ] Seller A can edit the listing and then archive it. The archived listing disappears from public browsing but remains under A's My listings.
- [ ] Sign out and confirm seller controls are unavailable.
- [ ] Request a password reset, follow the email link, set a new password, and sign in again.
- [ ] Check an expired/invalid email link produces a helpful error.
- [ ] Check layouts and dialogs in desktop and mobile browsers.

These hosted account/email checks are still pending. Automated tests execute the actual migration in embedded PostgreSQL with a minimal Supabase auth-schema fixture; they test database policies but do not replace testing Supabase's hosted Auth and REST services.

## Current implementation

| Area | Choice |
| --- | --- |
| Browser interface | Existing HTML/CSS design with TypeScript and Vite |
| Server | Node.js, Express, TypeScript, validated JSON API |
| Accounts | Supabase Auth with verified email/password accounts |
| Database | Supabase PostgreSQL with row-level security and restricted column permissions |
| Photos | Reserved for phase 2; Supabase Storage is the intended next integration |
| Hosting | Render selected; development Blueprint written, account not connected, not deployed |
| Payments | Not connected; provider selection remains a later milestone |

The server validates sessions through Supabase Auth and passes each user's token to database requests. PostgreSQL separately restricts access using [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security). No privileged service key is used. The API sets ownership; clients cannot supply a seller ID, status, or timestamps when creating a listing.

API routes: `GET /api/config`, `GET /api/health`, `GET /api/listings`, `GET /api/me/listings`, `POST /api/listings`, `PUT /api/listings/:id`, and `POST /api/listings/:id/archive`. Writes require an authenticated, email-confirmed user. Listing reads support page, category, and club-name search. Prices are integer pence.

Favourites currently last only for the browser session and filter the displayed page. Photos, messaging, orders, payments, and professional verification are not implemented. No checkout is available.

## Verification recorded on 14 November 2026

- TypeScript check passed.
- All 19 automated API/validation/database/deployment-configuration checks passed.
- Production browser and server build passed.
- Built app returned HTTP 200 at the local preview address.
- Browser interaction/visual verification could not be completed: the browser host was unavailable and the native Chrome fallback stopped because it could not reliably identify the current URL.
- Hosted database read access is verified and anonymous profile access is denied. Email/account flows and end-to-end listing persistence still await account testing.
- Render deployment configuration, explicit Node version, and GitHub checks added. Production smoke checks cover the homepage, JavaScript assets, recovery URL, API responses, security headers, and isolation of private files. Cloud deployment and GitHub CI have not run yet.
