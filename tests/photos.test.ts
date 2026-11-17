import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';
import { normalisePhoto } from '../server/images';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { listingInput, maxPhotoBytes } from '../shared/listings';

test('photo processing decodes, orients, resizes and strips metadata', async () => {
  const input = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: 'green' } })
    .jpeg().withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: 'Private owner' } }).toBuffer();
  const result = await normalisePhoto(input);
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 800);
  assert.equal(metadata.height, 1600);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.icc, undefined);
  for (const format of ['png', 'webp'] as const) {
    const small = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).toFormat(format).toBuffer();
    assert.equal((await sharp(await normalisePhoto(small)).metadata()).width, 20);
  }
});

test('photo processing rejects disguised, oversized, empty and corrupt files', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'), Buffer.alloc(maxPhotoBytes + 1)]) {
    await assert.rejects(normalisePhoto(bytes));
  }
  const jpeg = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'red' } }).jpeg().toBuffer();
  await assert.rejects(normalisePhoto(jpeg.subarray(0, 40)));
});

test('golf details accept optional values and reject invalid enums and lofts', () => {
  const base = { name: 'Driver', brand: 'Ping', category: 'Drivers', condition: 'Good', price_pence: 10000, location: 'Leeds' };
  assert.equal(listingInput.parse(base).loft, null);
  assert.equal(listingInput.parse({ ...base, handedness: 'Left', shaft_flex: 'Stiff', loft: 10.5 }).loft, 10.5);
  for (const change of [{ handedness: 'Other' }, { shaft_flex: 'Unknown' }, { loft: 0 }, { loft: 91 }, { loft: 10.3 }, { listing_photos: [] }]) {
    assert.equal(listingInput.safeParse({ ...base, ...change }).success, false);
  }
});

test('photos over the decoded pixel limit are rejected even when the file is small', async () => {
  const image = await sharp({ create: { width: 6401, height: 6250, channels: 3, background: 'white' } }).png().toBuffer();
  assert.ok(image.length < maxPhotoBytes);
  await assert.rejects(normalisePhoto(image), /pixel limit/i);
});

test('animated WebP uploads are rejected', async () => {
  const pixels = Buffer.concat([Buffer.alloc(20 * 20 * 3, 0), Buffer.alloc(20 * 20 * 3, 255)]);
  const animated = await sharp(pixels, { raw: { width: 20, height: 40, channels: 3, pageHeight: 20 } })
    .webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(normalisePhoto(animated), /still JPEG, PNG or WebP/);
});

test('photo download checks visibility before storage and sends uncached image bytes', async () => {
  const photo = '33333333-3333-4333-8333-333333333333';
  const listing = '22222222-2222-4222-8222-222222222222';
  let archived = false;
  let downloads = 0;
  let failDownload = false;
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).webp().toBuffer();
  const client = (token?: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: token, email_confirmed_at: '2026-01-01' } }, error: null }) },
    from: () => {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: !archived || token === 'owner' ? { id: photo, listing_id: listing } : null, error: null }) };
      return query;
    },
  } as unknown as SupabaseClient);
  const admin = { storage: { from: () => ({ download: async (path: string) => {
    downloads++; assert.equal(path, `${listing}/${photo}.webp`);
    return { data: new Blob([new Uint8Array(image)]), error: failDownload ? new Error('Unavailable') : null };
  } }) } } as unknown as SupabaseClient;
  const config = readConfig({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
  const server = createApp(config, client, admin).listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/photos/${photo}`;
  try {
    const publicPhoto = await fetch(url);
    assert.equal(publicPhoto.status, 200);
    assert.match(publicPhoto.headers.get('content-type') || '', /image\/webp/);
    assert.equal(publicPhoto.headers.get('cache-control'), 'private, max-age=86400');
    assert.deepEqual(Buffer.from(await publicPhoto.arrayBuffer()), image);
    archived = true;
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer other' } })).status, 404);
    assert.equal(downloads, 1);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer owner' } })).status, 200);
    failDownload = true;
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer owner' } })).status, 503);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('photo migration protects data and serialises photo management', async t => {
  const db = new PGlite();
  const alice = '11111111-1111-4111-8111-111111111111';
  const bob = '22222222-2222-4222-8222-222222222222';
  let listing = '';
  const photos: string[] = [];
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text);
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    create policy broad_existing_policy on storage.objects for all to anon,authenticated using(true) with check(true);
  `);
  for (const migration of ['202611140001_foundations.sql', '202611160001_listing_photos.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  // Reproduce the explicit client grants inherited from Supabase defaults.
  await db.exec('grant execute on function public.create_user_profile(), public.set_updated_at(), public.queue_photo_cleanup(), public.is_verified_seller() to anon, authenticated');
  await db.exec(await readFile(new URL('../supabase/migrations/20261117120902_harden_function_permissions.sql', import.meta.url), 'utf8'));
  async function as(role: string, user = '') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec(`set role ${role}`);
  }
  async function action(name: string, photo: string | null = null, seller = alice) {
    return (await db.query<{ id: string }>('select public.manage_listing_photo($1,$2,$3,$4) as id', [listing, seller, photo, name])).rows[0].id;
  }
  try {
    await t.test('hardening removes client access while retaining the seller check', async () => {
      for (const role of ['anon', 'authenticated']) {
        await as(role);
        for (const fn of ['create_user_profile', 'set_updated_at', 'queue_photo_cleanup']) {
          await assert.rejects(db.query(`select public.${fn}()`), /permission denied/);
        }
      }
      await as('anon');
      await assert.rejects(db.query('select public.is_verified_seller()'), /permission denied/);
      await as('authenticated');
      assert.equal((await db.query<{ verified: boolean }>('select public.is_verified_seller() as verified')).rows[0].verified, false);
      await db.exec('reset role');
    });
    await db.query("insert into auth.users values($1,'{}',now()),($2,'{}',now())", [alice, bob]);
    await as('authenticated', alice);
    listing = (await db.query<{ id: string }>("insert into public.listings(seller_id,name,brand,category,condition,price_pence,location,handedness,shaft_flex,loft) values($1,'Driver','Ping','Drivers','Good',10000,'Leeds','Left','Stiff',10.5) returning id", [alice])).rows[0].id;
    await t.test('golf fields persist and database constraints reject forged values', async () => {
      assert.equal((await db.query<{ loft: string }>('select loft from public.listings where id=$1', [listing])).rows[0].loft, '10.5');
      await assert.rejects(db.query('update public.listings set loft=10.3 where id=$1', [listing]), /check constraint/);
      await assert.rejects(db.query("update public.listings set handedness='Other' where id=$1", [listing]), /check constraint/);
    });
    await t.test('direct photo writes and privileged functions cannot bypass image validation', async () => {
      await assert.rejects(action('reserve'), /permission denied/);
      await assert.rejects(db.query('insert into public.listing_photos(listing_id,position) values($1,0)', [listing]), /permission denied/);
      await assert.rejects(db.query("insert into storage.objects(bucket_id) values('listing-photos')"), /row-level security/);
      await as('anon');
      await assert.rejects(db.query("insert into storage.objects(bucket_id) values('listing-photos')"), /row-level security/);
    });
    await t.test('only verified owners can reserve and six slots are enforced', async () => {
      await as('service_role');
      await assert.rejects(action('reserve', null, bob), /Listing unavailable/);
      for (let i = 0; i < 6; i++) photos.push(await action('reserve'));
      await assert.rejects(action('reserve'), /Maximum six/);
      await as('anon');
      assert.equal((await db.query('select * from public.listing_photos')).rows.length, 0);
    });
    await t.test('completed photos are visible and main selection is atomic', async () => {
      await as('service_role');
      for (const id of photos.slice(0, 5)) await action('complete', id);
      await action('main', photos[3]);
      await as('anon');
      const result = await db.query<{ id: string }>('select id from public.listing_photos order by position');
      assert.equal(result.rows.length, 5);
      assert.equal(result.rows[0].id, photos[3]);
    });
    await t.test('removal queues storage cleanup and abandoned uploads can be pruned', async () => {
      await as('service_role'); await action('remove', photos[1]);
      assert.equal((await db.query('select * from public.photo_cleanup')).rows.length, 1);
      await db.query("update public.listing_photos set created_at=now()-interval '2 hours' where id=$1", [photos[5]]);
      await db.exec('select public.prune_pending_photos()');
      assert.equal((await db.query('select * from public.photo_cleanup')).rows.length, 2);
    });
    await t.test('archived photos are visible only to their owner', async () => {
      await as('authenticated', alice);
      await db.query("update public.listings set status='archived' where id=$1", [listing]);
      assert.equal((await db.query('select * from public.listing_photos')).rows.length, 4);
      await as('authenticated', bob);
      assert.equal((await db.query('select * from public.listing_photos')).rows.length, 0);
      await as('anon');
      assert.equal((await db.query('select * from public.listing_photos')).rows.length, 0);
      await as('service_role'); await assert.rejects(action('reserve'), /Listing unavailable/);
    });
  } finally { await db.close(); }
});

test('photo API validates ownership before storage and never exposes the secret', async () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const listing = '22222222-2222-4222-8222-222222222222';
  const photo = '33333333-3333-4333-8333-333333333333';
  let storageCalls = 0;
  let failUpload = false;
  const actions: string[] = [];
  const config = readConfig({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_STORAGE_SECRET: 'sb_secret_testing' });
  const client = (token?: string) => ({
    auth: { getUser: async () => ({ data: { user: token === 'invalid' ? null : { id: owner, email_confirmed_at: token === 'unconfirmed' ? null : '2026-01-01' } }, error: null }) },
    from: () => {
      const query = { select: () => query, eq: () => query, limit: async () => ({ error: null }), maybeSingle: async () => ({ data: token === 'owner' ? { id: listing } : null, error: null }) };
      return query;
    },
  } as unknown as SupabaseClient);
  const admin = {
    rpc: async (_name: string, input: { p_action: string }) => { storageCalls++; actions.push(input.p_action); return { data: photo, error: null }; },
    storage: { from: () => ({ upload: async (_path: string, bytes: Buffer) => { assert.equal((await sharp(bytes).metadata()).format, 'webp'); storageCalls++; return { error: failUpload ? new Error('Storage offline') : null }; } }) },
  } as unknown as SupabaseClient;
  const server = createApp(config, client, admin).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upload = (token = '', body: Uint8Array = Buffer.from('invalid'), origin?: string) => fetch(`${url}/api/listings/${listing}/photos`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) }, body: body as BodyInit });
  try {
    const exposed = await (await fetch(`${url}/api/config`)).text();
    assert.equal(exposed.includes('sb_secret'), false);
    assert.equal(JSON.parse(exposed).photosEnabled, true);
    assert.equal((await upload()).status, 401);
    assert.equal((await upload('invalid')).status, 401);
    assert.equal((await upload('unconfirmed')).status, 403);
    assert.equal((await upload('other')).status, 404);
    assert.equal((await upload('owner', undefined, 'https://attacker.test')).status, 403);
    assert.equal((await upload('owner')).status, 400);
    assert.equal((await upload('owner', Buffer.alloc(maxPhotoBytes + 1))).status, 413);
    for (const action of ['main', 'remove']) {
      assert.equal((await fetch(`${url}/api/listings/${listing}/photos/${photo}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer other' }, body: '{}' })).status, 404);
    }
    assert.equal((await fetch(`${url}/api/photos/${photo}`)).status, 404);
    assert.equal(storageCalls, 0);
    const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    assert.equal((await upload('owner', jpeg)).status, 201);
    assert.equal(storageCalls, 3);
    failUpload = true; actions.length = 0;
    assert.equal((await upload('owner', jpeg)).status, 503);
    assert.deepEqual(actions, ['reserve', 'remove']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('foundation listings keep working before the photo migration is applied', async () => {
  let selected = '';
  const config = readConfig({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
  const client = () => ({ from: () => {
    const query = { select: (value: string) => { selected = value; return query; },
      limit: async () => ({ error: { code: '42703' } }), eq: () => query, order: () => query,
      range: async () => ({ data: [], count: 0, error: null }) };
    return query;
  } } as unknown as SupabaseClient);
  const server = createApp(config, client).listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const capabilities = await (await fetch(`${url}/api/config`)).json();
    assert.equal(capabilities.listingDetailsEnabled, false);
    assert.equal(capabilities.photosEnabled, false);
    assert.equal((await fetch(`${url}/api/listings`)).status, 200);
    assert.equal(selected.includes('listing_photos'), false);
    assert.equal(selected.includes('handedness'), false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
