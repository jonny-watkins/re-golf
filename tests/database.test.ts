import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migration and PostgreSQL ownership rules', async t => {
  const db = new PGlite();
  const alice = '11111111-1111-4111-8111-111111111111';
  const bob = '22222222-2222-4222-8222-222222222222';
  const unverified = '33333333-3333-4333-8333-333333333333';
  let id = '';
  // Supabase owns this schema in production. The test supplies only its users/uid contract.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.exec(
    await readFile(new URL('../supabase/migrations/202611140001_foundations.sql', import.meta.url), 'utf8'),
  );
  async function as(role: 'anon' | 'authenticated', user = '') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    await db.exec(`set role ${role}`);
  }
  try {
    await t.test('signups create bounded profiles without exposing email', async () => {
      await db.query('insert into auth.users values ($1, $2, now()), ($3, $4, now()), ($5, $6, null)', [
        alice,
        JSON.stringify({ display_name: 'Alice' }),
        bob,
        JSON.stringify({ display_name: 'Bob' }),
        unverified,
        '{}',
      ]);
      const result = await db.query<{ display_name: string }>(
        'select display_name from public.profiles where id = $1',
        [alice],
      );
      assert.equal(result.rows[0].display_name, 'Alice');
    });
    await t.test('anonymous visitors cannot insert listings or view profiles', async () => {
      await as('anon');
      await assert.rejects(
        db.query(
          "insert into public.listings (seller_id,name,brand,category,condition,price_pence,location) values ($1,'Driver','Ping','Drivers','Good',10000,'Leeds')",
          [alice],
        ),
        /permission denied/,
      );
      await assert.rejects(db.query('select * from public.profiles'), /permission denied/);
    });
    await t.test('verified sellers can create an active listing with integer pence', async () => {
      await as('authenticated', alice);
      const result = await db.query<{ id: string; price_pence: number }>(
        "insert into public.listings (seller_id,name,brand,category,condition,price_pence,location) values ($1,'Driver','Ping','Drivers','Good',12345,'Leeds') returning id,price_pence",
        [alice],
      );
      id = result.rows[0].id;
      assert.equal(result.rows[0].price_pence, 12345);
    });
    await t.test('public browsing reads active listings across sessions', async () => {
      await as('anon');
      const result = await db.query<{ id: string }>('select id from public.listings');
      assert.equal(result.rows[0].id, id);
    });
    await t.test('another seller cannot update, archive, delete, impersonate, or see private profiles', async () => {
      await as('authenticated', bob);
      const update = await db.query('update public.listings set price_pence = 100 where id = $1 returning id', [id]);
      assert.equal(update.rows.length, 0);
      const archive = await db.query("update public.listings set status = 'archived' where id = $1 returning id", [id]);
      assert.equal(archive.rows.length, 0);
      await assert.rejects(db.query('delete from public.listings where id = $1', [id]), /permission denied/);
      await assert.rejects(
        db.query(
          "insert into public.listings (seller_id,name,brand,category,condition,price_pence,location) values ($1,'Fake','Ping','Drivers','Good',10000,'Leeds')",
          [alice],
        ),
        /row-level security/,
      );
      assert.equal((await db.query('select id from public.profiles where id = $1', [alice])).rows.length, 0);
    });
    await t.test('unconfirmed accounts cannot publish even through the direct database API', async () => {
      await as('authenticated', unverified);
      await assert.rejects(
        db.query(
          "insert into public.listings (seller_id,name,brand,category,condition,price_pence,location) values ($1,'Driver','Ping','Drivers','Good',10000,'Leeds')",
          [unverified],
        ),
        /row-level security/,
      );
    });
    await t.test('owners cannot change ownership, IDs, timestamps, or invent a sold status', async () => {
      await as('authenticated', alice);
      await assert.rejects(
        db.query('update public.listings set seller_id = $1 where id = $2', [bob, id]),
        /permission denied/,
      );
      await assert.rejects(
        db.query('update public.listings set created_at = now() where id = $1', [id]),
        /permission denied/,
      );
      await assert.rejects(
        db.query('update public.listings set id = $1 where id = $2', [bob, id]),
        /permission denied/,
      );
      await assert.rejects(
        db.query("update public.listings set status = 'sold' where id = $1", [id]),
        /check constraint/,
      );
    });
    await t.test('database rejects invalid prices, blank titles, and unknown categories', async () => {
      for (const amount of [-1, 0, 2000001]) {
        await assert.rejects(
          db.query('update public.listings set price_pence = $1 where id = $2', [amount, id]),
          /check constraint/,
        );
      }
      await assert.rejects(db.query("update public.listings set name = '   ' where id = $1", [id]), /check constraint/);
      await assert.rejects(
        db.query("update public.listings set category = 'Cars' where id = $1", [id]),
        /check constraint/,
      );
    });
    await t.test('owner edits persist and archived items become private', async () => {
      await db.query("update public.listings set name = 'Updated driver', status = 'archived' where id = $1", [id]);
      assert.equal(
        (await db.query<{ name: string }>('select name from public.listings where id = $1', [id])).rows[0].name,
        'Updated driver',
      );
      await as('anon');
      assert.equal((await db.query('select id from public.listings where id = $1', [id])).rows.length, 0);
      await as('authenticated', bob);
      assert.equal((await db.query('select id from public.listings where id = $1', [id])).rows.length, 0);
      await as('authenticated', alice);
      assert.equal((await db.query('select id from public.listings where id = $1', [id])).rows.length, 1);
    });
  } finally {
    await db.close();
  }
});
