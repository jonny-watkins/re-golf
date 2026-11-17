import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

// Explicit opt-in: creates disposable hosted users/listings, then removes them.
assert.equal(process.env.PHOTO_TEST_PROJECT, new URL(process.env.SUPABASE_URL!).hostname.split('.')[0], 'Set PHOTO_TEST_PROJECT to the development project ref');
const config = readConfig(process.env);
assert.ok(config.storageSecret, 'Storage secret must be configured');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.storageSecret, options);
const users: string[] = [];
const clients: ReturnType<typeof createClient>[] = [];
const tokens: string[] = [];
let listing = '';
let stage = 'initialisation';
const check = (result: { error: unknown }, label: string) => { if (result.error) throw new Error(label); };
const server = createApp(config).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;
const request = (path: string, token = '', body?: unknown, binary = false) => fetch(base + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }) },
  body: body === undefined ? undefined : binary ? body as BodyInit : JSON.stringify(body),
});
try {
  stage = 'capabilities';
  const exposed = await (await request('/api/config')).text();
  assert.ok(!exposed.includes(config.storageSecret));
  assert.equal(JSON.parse(exposed).photosEnabled, true);
  for (let i = 0; i < 2; i++) {
    stage = 'temporary account creation';
    const email = `photo-test-${randomUUID()}@example.com`;
    const password = randomUUID() + 'aA1!';
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Disposable photo test' } });
    check(created, stage); users.push(created.data.user!.id);
    const client = createClient(config.supabaseUrl, config.publishableKey, options); clients.push(client);
    const signed = await client.auth.signInWithPassword({ email, password }); check(signed, 'Temporary sign-in failed');
    tokens.push(signed.data.session!.access_token);
  }
  stage = 'listing creation';
  const created = await request('/api/listings', tokens[0], { name: 'Disposable photo acceptance test', brand: 'Test', category: 'Drivers', condition: 'Good', price_pence: 10000, location: 'Test', handedness: 'Left', shaft_flex: 'Stiff', loft: 10.5 });
  assert.equal(created.status, 201); listing = (await created.json()).listing.id;
  const path = `/api/listings/${listing}/photos`;
  const jpeg = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: 'green' } }).jpeg().withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: 'Private test' } }).toBuffer();
  stage = 'upload validation and ownership';
  assert.equal((await request(path, '', jpeg, true)).status, 401);
  assert.equal((await request(path, tokens[1], jpeg, true)).status, 404);
  assert.equal((await request(path, tokens[0], Buffer.from('invalid'), true)).status, 400);
  assert.equal((await request(path, tokens[0], Buffer.alloc(8388609), true)).status, 413);
  stage = 'real concurrent storage uploads';
  const uploads = await Promise.all(Array.from({ length: 7 }, () => request(path, tokens[0], jpeg, true)));
  assert.equal(uploads.filter(r => r.status === 201).length, 6);
  assert.equal(uploads.filter(r => r.status === 409).length, 1);
  const ids = await Promise.all(uploads.filter(r => r.status === 201).map(async r => (await r.json()).photo.id as string));
  stage = 'download and metadata';
  const downloaded = await request(`/api/photos/${ids[0]}`); assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('cache-control'), 'private, max-age=86400');
  const metadata = await sharp(Buffer.from(await downloaded.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 800); assert.equal(metadata.height, 1600); assert.equal(metadata.exif, undefined);
  stage = 'direct client access denied';
  assert.ok((await clients[0].storage.from('listing-photos').upload(`${listing}/forbidden.webp`, Buffer.from('invalid'), { contentType: 'image/webp' })).error);
  assert.ok((await clients[0].from('listing_photos').insert({ listing_id: listing, position: 0 })).error);
  assert.ok((await clients[0].rpc('manage_listing_photo', { p_listing: listing, p_seller: users[0], p_photo: null, p_action: 'reserve' })).error);
  stage = 'main photo and removal';
  for (const action of ['main', 'remove']) assert.equal((await request(`${path}/${ids[1]}/${action}`, tokens[1], {})).status, 404);
  assert.equal((await request(`${path}/${ids[1]}/main`, tokens[0], {})).status, 200);
  const rows = await clients[0].from('listing_photos').select('id').eq('listing_id', listing).order('position'); check(rows, stage); assert.equal(rows.data![0].id, ids[1]);
  assert.equal((await request(`${path}/${ids[0]}/remove`, tokens[0], {})).status, 200);
  assert.equal((await request(`/api/photos/${ids[0]}`)).status, 404);
  assert.equal((await request(path, tokens[0], jpeg, true)).status, 201);
  stage = 'archive visibility';
  assert.equal((await request(`/api/listings/${listing}/archive`, tokens[0], {})).status, 200);
  assert.equal((await request(`/api/photos/${ids[1]}`)).status, 404);
  assert.equal((await request(`/api/photos/${ids[1]}`, tokens[1])).status, 404);
  assert.equal((await request(`/api/photos/${ids[1]}`, tokens[0])).status, 200);
  console.log('PASS: hosted uploads, concurrent six-photo limit, metadata stripping, access restrictions, main selection, removal/replacement, archive visibility, secret isolation.');
} catch {
  console.error(`FAIL at stage: ${stage} (credentials and response bodies suppressed)`); process.exitCode = 1;
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  try {
    for (const client of clients) check(await client.auth.signOut(), 'Test session revocation failed');
    if (listing) {
      check(await admin.from('listings').delete().eq('id', listing), 'Test listing cleanup failed');
      const objects = await admin.storage.from('listing-photos').list(listing); check(objects, 'Test object listing failed');
      const paths = (objects.data || []).map(o => `${listing}/${o.name}`);
      if (paths.length) check(await admin.storage.from('listing-photos').remove(paths), 'Test object cleanup failed');
      check(await admin.from('photo_cleanup').delete().like('path', `${listing}/%`), 'Test queue cleanup failed');
    }
    for (const id of users) check(await admin.auth.admin.deleteUser(id), 'Test account cleanup failed');
    console.log('PASS: disposable accounts, listing, objects and cleanup entries removed.');
  } catch { console.error('FAIL: disposable fixture cleanup requires investigation'); process.exitCode = 1; }
}
