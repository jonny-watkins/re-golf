# Relofted go-live runbook

How to take Relofted from the private preview to a live site that takes real money. Work top to bottom. Each step says who does it: **[J]** Jonny, **[D]** developer (Claude).

Nothing here has been done yet. The current preview, database and Stripe sandbox stay as the test environment throughout and afterwards.

## Before you start

- [ ] [J] Trading entity (company) and a business bank account exist.
- [ ] [J] Domain bought (suggested: `relofted.co.uk`, with `relofted.com` redirected to it).
- [ ] [J] Terms, privacy notice and buyer-protection page reviewed by a legal adviser, and the [bracketed] gaps filled in. Drafts are in `public/terms.html`, `public/privacy.html`, `public/buyer-protection.html`.
- [ ] [J] Decisions settled: delivery price(s), support email address, who the Support administrators are.
- [ ] [D] `npm test`, `npm run build`, `npm run test:smoke`, `npm run test:orders:live` and `npm run test:orders:browser` all pass on the commit being released.
- [ ] [J]/[D] `payments` branch merged into `main`.

## 1. Production database (Supabase)

- [ ] [J] Create a **new** Supabase project for production (paid plan, so it has daily backups and never pauses). Region: London or the nearest EU region.
- [ ] [J] SQL Editor → New query → paste the whole of `supabase/production-setup.sql` → Run. Expect "Success. No rows returned". Run it once only.
- [ ] [J] Authentication → URL Configuration: set Site URL to `https://<your domain>` and add `https://<your domain>/**` to the redirect list.
- [ ] [J] Authentication → Emails: set up custom SMTP with the email provider (step 4) and update the email templates to say Relofted.
- [ ] [J] Project Settings → API keys: copy the project URL, the `sb_publishable_…` key and a new `sb_secret_…` key for the server.

## 2. Stripe live mode

- [ ] [J] In Stripe, complete business verification ("Get your live account") and enable Connect in live mode with the same choices as the sandbox: *you collect payments and pay recipients*.
- [ ] [J] Set the public business name to Relofted (it appears on the payment page and card statements).
- [ ] [J] Live mode → Developers → Webhooks: create **two** destinations pointing at `https://<your domain>/api/stripe/webhook`, both with Snapshot payloads:
  - Scope **Your account**, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.dispute.created`
  - Scope **Connected accounts**, event: `account.updated` (not `account.external_account.updated`)
- [ ] [J] Copy the live secret key (`sk_live_…`) and both signing secrets (`whsec_…`).

## 3. Production web service (Render)

- [ ] [J] Create a new Render web service from the GitHub repository, branch `main`, on a paid always-on plan (the free plan sleeps and delays payments). Build command `npm ci --include=dev && npm run build`, start command `npm start`, health check path `/api/health`.
- [ ] [J] Environment variables:

  | Name | Value |
  |---|---|
  | `NODE_ENV` | `production` |
  | `APP_ORIGIN` | `https://<your domain>` |
  | `SUPABASE_URL` | production project URL |
  | `SUPABASE_PUBLISHABLE_KEY` | production `sb_publishable_…` |
  | `SUPABASE_STORAGE_SECRET` | production `sb_secret_…` |
  | `STRIPE_SECRET_KEY` | `sk_live_…` |
  | `STRIPE_WEBHOOK_SECRET` | signing secret of the "Your account" destination |
  | `STRIPE_CONNECT_WEBHOOK_SECRET` | signing secret of the "Connected accounts" destination |
  | `ALLOW_LIVE_PAYMENTS` | `true` (the app refuses live keys without it) |
  | `ADMIN_EMAILS` | support administrators' sign-in emails, comma-separated |
  | `EMAIL_API_KEY`, `EMAIL_FROM` | from step 4 |
  | `PREVIEW_ACCESS_PASSWORD` | a long password for now; remove it at step 6 to open the site |

- [ ] [J] Add the custom domain in Render and point the domain's DNS at it as Render instructs. Wait for the HTTPS certificate.

## 4. Email

- [ ] [J] Create an account with the email provider (Resend), add the domain, and add the DNS records it gives you. Wait until it shows as verified.
- [ ] [J] Create an API key. Set `EMAIL_API_KEY` and `EMAIL_FROM` (for example `Relofted <orders@relofted.co.uk>`) on Render.
- [ ] [J] Create the support mailbox and make sure replies to the sending address reach a person.

## 5. Checks while the site is still private

Buying is off in a new database, and the preview password is still on.

- [ ] [D] Site loads at the domain; sign-up, email confirmation and password reset emails arrive and their links work.
- [ ] [D] List an item with photos; search and filters work; messages work.
- [ ] [J] Sign in as an administrator, open **Support**, turn buying on.
- [ ] [J] One real purchase of a low-value item between two real people, using a real card: pay, post with tracking, confirm delivery, wait for or release the hold, and confirm the money reaches the seller's bank account. Check each email arrives.
- [ ] [J] One real refund: buy, then refund from the Support screen, and confirm the money returns to the card.
- [ ] [D] `npm run orders:reconcile` against production shows no mismatches.
- [ ] [D] Restore test: confirm a Supabase backup exists and can be restored to a scratch project.

## 6. Open

- [ ] [J] Go/no-go decision recorded.
- [ ] [J] Remove `PREVIEW_ACCESS_PASSWORD` from the production service and redeploy. The site is now public.
- [ ] [D] Confirm the site is reachable without a password and search engines are no longer told to ignore it.

## 7. First two weeks

- [ ] [D] Run `npm run orders:reconcile` daily. Any mismatch: pause buying from the Support screen first, investigate second.
- [ ] [J] Check the Support screen daily for orders needing a decision and for reports.
- [ ] [J] Watch for sellers who have sold but not set up payouts; their money waits until they do.

## If something goes wrong

- **Wrong charges, duplicate sales, or money that does not reconcile:** Support screen → *Pause all new purchases*. Existing orders, refunds and payouts carry on. Then investigate.
- **The site is down:** Render dashboard → the service → Logs. Roll back to the previous deploy from the Deploys tab. Do not restore an old database over new orders.
- **Private information exposed:** pause purchases, take the affected feature offline, and follow your data-breach procedure (the ICO must be told within 72 hours where required).
