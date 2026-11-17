import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readCleanupConfig } from '../server/cleanup-config.js';

const config = readCleanupConfig(process.env);
const db = createClient(config.supabaseUrl, config.storageSecret, { auth: { persistSession: false, autoRefreshToken: false } });
const pruned = await db.rpc('prune_pending_photos');
if (pruned.error) throw new Error('Could not prune pending photos. Check the migration.');
let count = 0;
for (;;) {
  const { data, error } = await db.from('photo_cleanup').select('path').order('created_at').limit(100);
  if (error) throw new Error('Could not read the photo cleanup queue.');
  if (!data.length) break;
  const paths = data.map(row => row.path as string);
  const removed = await db.storage.from('listing-photos').remove(paths);
  if (removed.error) throw new Error('Storage cleanup failed; queue retained for retry.');
  const cleared = await db.from('photo_cleanup').delete().in('path', paths);
  if (cleared.error) throw new Error('Queue update failed; retry is safe.');
  count += paths.length;
}
console.log(`Photo cleanup complete: ${count} objects removed.`);
