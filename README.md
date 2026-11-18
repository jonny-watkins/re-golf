# Relofted

A UK marketplace for second-hand golf equipment. Buyers pay through the site; the payment is held until the item has been delivered and checked, then released to the seller.

## Where things stand

- A private preview runs at https://re-golf-development.onrender.com (username `preview`; ask the project owner for the password). It uses the development database and Stripe's test mode, so no real money moves.
- Nothing is live yet. [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) is the working list of what is done and what is left. [GO_LIVE.md](GO_LIVE.md) is the step-by-step runbook for launch day.
- Earlier planning documents are kept for history in [docs/archive](docs/archive). They are out of date; where they disagree with the checklist, the checklist is right.

## How it is built

| Part | What it does | Where |
|---|---|---|
| Browser app | The site people use. Plain TypeScript, no framework. | `index.html`, `src/` |
| Server | API, payment webhooks, support tools, background jobs. Express on Node 22. | `server/` |
| Shared | Types and validation used by both. | `shared/` |
| Database | Tables, access rules and the order/money rules, as SQL migrations. Supabase (PostgreSQL). | `supabase/migrations/` |
| Payments | Stripe Connect: the buyer pays the platform, funds are held, then transferred to the seller. | `server/payments.ts`, `server/orders.ts` |

The rules about money live in the database, not the browser: who may buy what, when a payment is held, released or refunded. The server carries out what the database has decided with Stripe, and every step is safe to repeat.

## Running it

```
npm ci
npm run dev        # http://localhost:3000
```

Copy `.env.example` to `.env` and fill it in. Without it the app runs with example listings only. Never commit `.env`.

## Checks

| Command | What it proves |
|---|---|
| `npm test` | Unit tests and the database rules, run against an in-memory PostgreSQL |
| `npm run check` | TypeScript types |
| `npm run format:check` | Code formatting (`npm run format` fixes it) |
| `npm run build` then `npm run test:smoke` | The production build starts and serves the site |
| `npm run test:orders:live` | The whole order flow against the preview and Stripe's sandbox |
| `npm run test:orders:browser` | A real purchase in a headless browser, including Stripe's payment page |
| `npm run orders:reconcile` | Stripe's records match the orders table |

The two hosted commands create and delete test data. They refuse to run against anything except the development database and Stripe test keys.

## Database changes

Each change is a file in `supabase/migrations/`, applied in filename order. They are currently applied by pasting into the Supabase SQL Editor; moving to the Supabase command-line tool, which records what has been applied, is on the checklist. `supabase/production-setup.sql` is all of them in one file for a brand-new project; regenerate it with `npm run db:production-sql`.

## Configuration

See `.env.example` for every setting. The important ones:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`: the database project and its public key.
- `SUPABASE_SECRET_KEY`: the server-only key. It bypasses all access rules, so it must never reach the browser or the repository.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`: payments. Live keys are refused unless `ALLOW_LIVE_PAYMENTS=true`.
- `ADMIN_EMAILS`: who may open the Support screen.
- `EMAIL_API_KEY`, `EMAIL_FROM`: order and message emails. Nothing is sent until both are set.
