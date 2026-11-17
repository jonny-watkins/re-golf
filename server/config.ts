export type AppConfig = {
  supabaseUrl: string;
  publishableKey: string;
  storageSecret: string;
  origin: string;
  port: number;
  host: string;
  trustProxyHops: number;
  previewPassword: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripeConnectWebhookSecret: string;
  adminEmails: string[];
};

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const onRender = env.RENDER === 'true';
  const previewPassword = env.PREVIEW_ACCESS_PASSWORD || '';
  if (onRender && previewPassword.length < 24) throw new Error('Set PREVIEW_ACCESS_PASSWORD to at least 24 characters for the private development preview.');
  const supabaseUrl = env.SUPABASE_URL?.trim() || '';
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim() || '';
  const storageSecret = env.SUPABASE_STORAGE_SECRET?.trim() || '';
  if (storageSecret && (!supabaseUrl || !/^sb_secret_[A-Za-z0-9_-]+$/.test(storageSecret))) {
    throw new Error('SUPABASE_STORAGE_SECRET requires a configured project and an sb_secret_ key. Keep it server-only.');
  }
  if (Boolean(supabaseUrl) !== Boolean(publishableKey)) {
    throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.');
  }
  if (onRender && !supabaseUrl) {
    throw new Error('Render requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY before deployment.');
  }
  if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
    throw new Error('SUPABASE_URL must be your hosted Supabase project HTTPS URL.');
  }
  // Only modern public keys are accepted: this value is sent to the browser.
  if (publishableKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error('Use the sb_publishable_ key, never a secret or service_role key.');
  }
  const port = Number(env.PORT || (onRender ? 10000 : 3000));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const originValue = env.APP_ORIGIN?.trim() || (onRender ? env.RENDER_EXTERNAL_URL : '') || `http://localhost:${port}`;
  const url = new URL(originValue);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path, query, or credentials.');
  }
  if (onRender && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Render requires a public HTTPS APP_ORIGIN or RENDER_EXTERNAL_URL.');
  }
  const host = onRender ? '0.0.0.0' : '127.0.0.1';
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS || (onRender ? 1 : 0));
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  }
  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim() || '';
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || '';
  if (Boolean(stripeSecretKey) !== Boolean(stripeWebhookSecret)) throw new Error('Set both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither.');
  // Stripe signs connected-account events (seller payout status) with a second destination's secret.
  const stripeConnectWebhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim() || '';
  if (stripeConnectWebhookSecret && (!stripeSecretKey || !/^whsec_[A-Za-z0-9]+$/.test(stripeConnectWebhookSecret))) throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET must be a whsec_ signing secret and requires the other Stripe settings.');
  if (stripeSecretKey) {
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(stripeSecretKey)) throw new Error('STRIPE_SECRET_KEY must be a Stripe secret or restricted key. Keep it server-only.');
    if (!/^whsec_[A-Za-z0-9]+$/.test(stripeWebhookSecret)) throw new Error('STRIPE_WEBHOOK_SECRET must be the whsec_ signing secret of the webhook endpoint.');
    // Orders are confirmed and settled with the server-only database key.
    if (!storageSecret) throw new Error('Payments require SUPABASE_STORAGE_SECRET (the server-only sb_secret_ key).');
    // Real money needs a deliberate second switch, so a pasted live key cannot take payments by accident.
    if (/^(sk|rk)_live_/.test(stripeSecretKey) && env.ALLOW_LIVE_PAYMENTS !== 'true') throw new Error('Live Stripe keys require ALLOW_LIVE_PAYMENTS=true. Use test keys until the launch checks pass.');
  }
  // Accounts allowed to use the support screen. Compared case-insensitively against confirmed sign-in emails.
  const adminEmails = (env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.some(value => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))) throw new Error('ADMIN_EMAILS must be a comma-separated list of email addresses.');
  if (adminEmails.length && !storageSecret) throw new Error('ADMIN_EMAILS requires SUPABASE_STORAGE_SECRET (the server-only sb_secret_ key).');
  return { supabaseUrl, publishableKey, storageSecret, origin: url.origin, port, host, trustProxyHops, previewPassword, stripeSecretKey, stripeWebhookSecret, stripeConnectWebhookSecret, adminEmails };
}
