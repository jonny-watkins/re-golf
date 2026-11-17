# re-golf

A golf equipment marketplace with direct buying and selling and buyer-paid platform fees.

The app now has a TypeScript/Express API, Supabase account integration, and a PostgreSQL migration for seller-owned listings. Connect a development Supabase project before using real accounts and saved listings.

Start with [the setup guide](SETUP.md). Run `npm ci` and `npm run dev`, then open `http://localhost:3000`. Without configuration, the app shows separate read-only examples. Purchases are not available.

Validation: `npm test`, `npm run build`, then `npm run test:smoke`.

Listing photos, golf details, persistent favourites and private messaging with blocking/reporting are implemented and verified against the development database. Read the latest [setup record](SETUP.md) before applying migrations; the connected project already has them. Run `npm run photos:cleanup` regularly once uploads are enabled. Reports currently need manual review in Supabase.

Hosting: Render with Supabase accounts/database. The development Blueprint is in [render.yaml](render.yaml); follow [the deployment steps](SETUP.md#deploy-the-development-preview-on-render). The preview requires username `preview` and the password generated in Render's private environment settings. Deployment is pending the Render connection; Supabase is connected. No payments are available.

See [the development and launch plan](DEVELOPMENT_PLAN.md) for agreed scope, implementation milestones, setup responsibilities, and launch checks.

See [the release plan](RELEASE_PLAN.md) for the proposed schedule, private preview, transaction pilot, public launch gates, and rollout and recovery procedures.
