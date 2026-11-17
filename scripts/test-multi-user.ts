import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

const config = readConfig(process.env);
assert.equal(process.env.TEST_PROJECT, new URL(config.supabaseUrl).hostname.split('.')[0], 'Explicit development project opt-in required');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.storageSecret, options);
const actors: { id: string; token: string; client: ReturnType<typeof createClient> }[] = [];
const ids: string[] = [];
let stage = 'account creation';
const check = (r: { error: unknown }) => { if (r.error) throw new Error('Hosted operation failed'); };
const server = createApp(config).listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const request = (path: string, actor = -1, body?: unknown, method = body === undefined ? 'GET' : 'POST', binary = false) => fetch(base + path, {
  method, headers: { ...(actor >= 0 ? { Authorization: `Bearer ${actors[actor].token}` } : {}), ...(body !== undefined ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' } : {}) },
  body: body === undefined ? undefined : binary ? body as BodyInit : JSON.stringify(body),
});
const input = { name: 'Disposable multi-user test', brand: 'Test', category: 'Drivers', condition: 'Good', price_pence: 10000, location: 'Leeds' };
try {
  for (let i = 0; i < 4; i++) {
    const email = `multi-user-${randomUUID()}@example.com`; const password = randomUUID() + 'aA1!';
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: i < 3, user_metadata: { display_name: `Disposable tester ${i + 1}` } }); check(created);
    const client = createClient(config.supabaseUrl, config.publishableKey, options);
    const actor = { id: created.data.user!.id, token: '', client }; actors.push(actor);
    const signed = await client.auth.signInWithPassword({ email, password });
    if (i === 3) { assert.ok(signed.error); continue; }
    check(signed); actor.token = signed.data.session!.access_token;
    const own = await client.from('profiles').select('id'); check(own); assert.deepEqual(own.data!.map(p => p.id), [actor.id]);
  }
  console.log('PASS: three confirmed accounts sign in; unconfirmed account cannot sign in; each profile is private.');
  stage = 'listing creation and anonymous restrictions';
  assert.equal((await request('/api/listings', -1, input)).status, 401);
  assert.equal((await request('/api/me/listings')).status, 401);
  for (let i = 0; i < 3; i++) {
    const created = await request('/api/listings', i, input); assert.equal(created.status, 201);
    ids.push((await created.json()).listing.id);
  }
  for (let i = 0; i < 3; i++) {
    const mine = await request('/api/me/listings', i); assert.equal(mine.status, 200);
    assert.deepEqual((await mine.json()).listings.map((l: { id: string }) => l.id), [ids[i]]);
  }
  const browsed = await request('/api/listings?q=Disposable%20multi-user%20test'); assert.equal(browsed.status, 200);
  const visible = (await browsed.json()).listings.map((l: { id: string }) => l.id);
  for (const id of ids) assert.ok(visible.includes(id));
  console.log('PASS: each seller creates and sees only their own listing; anonymous browsing sees all active test listings.');
  stage = 'cross-account modifications through API and database';
  for (let i = 0; i < 3; i++) {
    const victim = ids[(i + 1) % 3];
    assert.equal((await request(`/api/listings/${victim}`, i, input, 'PUT')).status, 404);
    assert.equal((await request(`/api/listings/${victim}/archive`, i, {})).status, 404);
    const changed = await actors[i].client.from('listings').update({ name: 'Forbidden change' }).eq('id', victim).select('id');
    assert.ok(changed.error || changed.data?.length === 0);
    const deleted = await actors[i].client.from('listings').delete().eq('id', victim).select('id'); assert.ok(deleted.error || deleted.data?.length === 0);
    assert.equal((await request('/api/listings', i, { ...input, seller_id: actors[(i + 1) % 3].id })).status, 400);
  }
  const unchanged = await admin.from('listings').select('id,name,seller_id,status').in('id', ids); check(unchanged);
  assert.equal(unchanged.data!.length, 3);
  for (const row of unchanged.data!) { assert.equal(row.name, input.name); assert.equal(row.status, 'active'); assert.equal(row.seller_id, actors[ids.indexOf(row.id)].id); }
  console.log('PASS: all three cross-account edit/archive/delete/owner-forgery attempts denied; original records unchanged.');
  stage = 'photo ownership and archive privacy';
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: 'green' } }).jpeg().toBuffer();
  const uploaded = await request(`/api/listings/${ids[0]}/photos`, 0, bytes, 'POST', true); assert.equal(uploaded.status, 201);
  const photo = (await uploaded.json()).photo.id;
  assert.equal((await request(`/api/photos/${photo}`)).status, 200);
  for (const i of [1, 2]) {
    assert.equal((await request(`/api/listings/${ids[0]}/photos`, i, bytes, 'POST', true)).status, 404);
    for (const action of ['main', 'remove']) assert.equal((await request(`/api/listings/${ids[0]}/photos/${photo}/${action}`, i, {})).status, 404);
  }
  assert.equal((await request(`/api/listings/${ids[0]}`, 0, { ...input, name: 'Owner edited test' }, 'PUT')).status, 200);
  assert.equal((await request(`/api/listings/${ids[0]}/archive`, 0, {})).status, 200);
  assert.equal((await request(`/api/photos/${photo}`, 0)).status, 200);
  for (const i of [-1, 1, 2]) assert.equal((await request(`/api/photos/${photo}`, i)).status, 404);
  for (const i of [1, 2]) {
    const hidden = await actors[i].client.from('listings').select('id').eq('id', ids[0]); check(hidden); assert.equal(hidden.data!.length, 0);
    const profile = await actors[i].client.from('profiles').select('id').eq('id', actors[0].id); check(profile); assert.equal(profile.data!.length, 0);
  }
  console.log('PASS: owner can edit/archive; other sellers cannot change photos or read archived listing/photos or private profile.');
  stage = 'sign-out';
  for (const actor of actors.slice(0, 3)) { check(await actor.client.auth.signOut()); assert.equal((await actor.client.auth.getSession()).data.session, null); }
  console.log('PASS: all confirmed test sessions signed out.');
} catch { console.error(`FAIL: ${stage} (credentials and response bodies suppressed)`); process.exitCode = 1; }
finally {
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  let failed = false;
  for (const actor of actors) try {
    await actor.client.auth.signOut();
    const listings = await admin.from('listings').select('id').eq('seller_id', actor.id); check(listings);
    for (const row of listings.data!) {
      check(await admin.from('listings').delete().eq('id', row.id));
      const objects = await admin.storage.from('listing-photos').list(row.id); check(objects);
      if (objects.data?.length) check(await admin.storage.from('listing-photos').remove(objects.data.map(o => `${row.id}/${o.name}`)));
      check(await admin.from('photo_cleanup').delete().like('path', `${row.id}/%`));
    }
    check(await admin.auth.admin.deleteUser(actor.id));
  } catch { failed = true; }
  if (failed) { console.error('FAIL: temporary data cleanup needs investigation'); process.exitCode = 1; }
  else console.log('PASS: all four temporary users and their profiles, listings, photos and cleanup entries removed.');
}
