import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readCleanupConfig } from '../server/cleanup-config.js';
import { cleanupPhotos } from '../server/photo-cleanup.js';

const config = readCleanupConfig(process.env);
const db = createClient(config.supabaseUrl, config.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const count = await cleanupPhotos(db);
console.log(`Photo cleanup complete: ${count} objects removed.`);
