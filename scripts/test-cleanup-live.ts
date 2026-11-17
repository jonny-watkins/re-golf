import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { readCleanupConfig } from '../server/cleanup-config.js';
import { cleanupPhotos } from '../server/photo-cleanup.js';

const config = readCleanupConfig(process.env);
assert.equal(process.env.TEST_PROJECT, new URL(config.supabaseUrl).hostname.split('.')[0]);
const db = createClient(config.supabaseUrl, config.storageSecret, { auth: { persistSession: false, autoRefreshToken: false } });
const check = (r: { error: unknown }) => { if (r.error) throw new Error('Hosted operation failed'); };
let user = '';
let listing = '';
let stage = 'fixtures';
const paths: string[] = [];
try {
  const before = await db.from('listing_photos').select('*').eq('ready', true).order('id'); check(before);
  const made = await db.auth.admin.createUser({ email: `cleanup-${randomUUID()}@example.com`, password: randomUUID() + 'Aa1!', email_confirm: true });
  check(made); user = made.data.user!.id;
  const created = await db.from('listings').insert({ seller_id: user, name: 'Temporary cleanup test', brand: 'Test', category: 'Drivers', condition: 'Good', price_pence: 10000, location: 'Test' }).select('id').single();
  check(created); listing = created.data!.id;
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'green' } }).webp().toBuffer();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const reserved = await db.rpc('manage_listing_photo', { p_listing: listing, p_seller: user, p_photo: null, p_action: 'reserve' });
    check(reserved); ids.push(reserved.data);
    const path = `${listing}/${reserved.data}.webp`; paths.push(path);
    check(await db.storage.from('listing-photos').upload(path, bytes, { contentType: 'image/webp' }));
  }
  // Completed photo is weeks old; unfinished photo is two hours old; third is fresh.
  check(await db.rpc('manage_listing_photo', { p_listing: listing, p_seller: user, p_photo: ids[0], p_action: 'complete' }));
  check(await db.from('listing_photos').update({ created_at: new Date(Date.now() - 21 * 86400000).toISOString() }).eq('id', ids[0]));
  check(await db.from('listing_photos').update({ created_at: new Date(Date.now() - 2 * 3600000).toISOString() }).eq('id', ids[1]));
  stage = 'cleanup and retention';
  await cleanupPhotos(db);
  const remaining = await db.from('listing_photos').select('id').eq('listing_id', listing); check(remaining);
  assert.deepEqual(remaining.data!.map(r => r.id).sort(), [ids[0], ids[2]].sort());
  check(await db.storage.from('listing-photos').download(paths[0]));
  check(await db.storage.from('listing-photos').download(paths[2]));
  assert.ok((await db.storage.from('listing-photos').download(paths[1])).error);
  const after = await db.from('listing_photos').select('*').eq('ready', true).neq('listing_id', listing).order('id'); check(after);
  assert.deepEqual(after.data, before.data);
  assert.equal(await cleanupPhotos(db), 0);
  console.log('PASS: abandoned upload removed; three-week-old completed photo and fresh upload retained; existing ready-photo records unchanged; repeat cleanup safe.');
} catch {
  console.error(`FAIL: ${stage}; sensitive diagnostics suppressed.`); process.exitCode = 1;
} finally {
  try {
    if (listing) check(await db.from('listings').delete().eq('id', listing));
    if (paths.length) check(await db.storage.from('listing-photos').remove(paths));
    if (paths.length) check(await db.from('photo_cleanup').delete().in('path', paths));
    if (user) check(await db.auth.admin.deleteUser(user));
    console.log('Temporary cleanup fixtures removed.');
  } catch { console.error('Temporary fixture cleanup needs investigation.'); process.exitCode = 1; }
}
