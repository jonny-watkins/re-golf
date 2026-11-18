// Scheduled cleanup needs only Storage credentials, not web/preview settings.
export function readCleanupConfig(env: NodeJS.ProcessEnv) {
  const supabaseUrl = env.SUPABASE_URL?.trim() || '';
  const secretKey = (env.SUPABASE_SECRET_KEY || env.SUPABASE_STORAGE_SECRET)?.trim() || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
    throw new Error('Set SUPABASE_URL to the hosted Supabase project HTTPS URL.');
  }
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey)) {
    throw new Error('Set the server-only SUPABASE_SECRET_KEY before running cleanup.');
  }
  return { supabaseUrl, secretKey };
}
