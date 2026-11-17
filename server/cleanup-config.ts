// Scheduled cleanup needs only Storage credentials, not web/preview settings.
export function readCleanupConfig(env: NodeJS.ProcessEnv) {
  const supabaseUrl = env.SUPABASE_URL?.trim() || '';
  const storageSecret = env.SUPABASE_STORAGE_SECRET?.trim() || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
    throw new Error('Set SUPABASE_URL to the hosted Supabase project HTTPS URL.');
  }
  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(storageSecret)) {
    throw new Error('Set the server-only SUPABASE_STORAGE_SECRET before running cleanup.');
  }
  return { supabaseUrl, storageSecret };
}
