import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('favourites and messaging database authorization and abuse controls', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111',
    buyer = '22222222-2222-4222-8222-222222222222',
    outsider = '33333333-3333-4333-8333-333333333333',
    unverified = '44444444-4444-4444-8444-444444444444';
  let listing = '',
    thread = '';
  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  async function as(user: string, role = 'authenticated') {
    await db.exec('reset role');
    await run("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec(`set role ${role}`);
  }
  async function send(user: string, body = 'Hello') {
    return run(
      'insert into public.messages(conversation_id,sender_id,body,client_id) values($1,$2,$3,gen_random_uuid()) returning id',
      [thread, user, body],
    );
  }
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
    for (const file of ['202611140001_foundations.sql', '20261117110226_favourites_messaging.sql'])
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    for (const id of [seller, buyer, outsider, unverified])
      await run("insert into auth.users values($1,'{}',$2)", [id, id === unverified ? null : new Date().toISOString()]);
    await as(seller);
    listing = (
      await db.query<{ id: string }>(
        "insert into public.listings(seller_id,name,brand,category,condition,price_pence,location) values($1,'Driver','Ping','Drivers','Good',10000,'Leeds') returning id",
        [seller],
      )
    ).rows[0].id;
    await t.test('favourites persist per account and cannot be forged or read by others', async () => {
      await as(buyer);
      await run('insert into public.favourites(user_id,listing_id) values($1,$2)', [buyer, listing]);
      await assert.rejects(
        run('insert into public.favourites(user_id,listing_id) values($1,$2)', [seller, listing]),
        /row-level security/,
      );
      await as(outsider);
      assert.equal((await run('select * from public.favourites')).rows.length, 0);
      await run('delete from public.favourites');
      await as(buyer);
      assert.equal((await run('select * from public.favourites')).rows.length, 1);
      await as('', 'anon');
      await assert.rejects(run('select * from public.favourites'), /permission denied/);
    });
    await t.test('conversation parties and listing title are authoritative', async () => {
      await as(buyer);
      await assert.rejects(
        run('insert into public.conversations(listing_id,buyer_id,seller_id) values($1,$2,$3)', [
          listing,
          buyer,
          outsider,
        ]),
        /privilege|security/,
      );
      const result = await db.query<{ id: string; listing_title: string }>(
        'insert into public.conversations(listing_id,buyer_id,seller_id) values($1,$2,$3) returning id,listing_title',
        [listing, buyer, seller],
      );
      thread = result.rows[0].id;
      assert.equal(result.rows[0].listing_title, 'Ping Driver');
      await assert.rejects(run('update public.conversations set seller_id=$1', [outsider]), /permission denied/);
      await as(outsider);
      assert.equal((await run('select * from public.conversations')).rows.length, 0);
      await as(unverified);
      await assert.rejects(
        run('insert into public.conversations(listing_id,buyer_id,seller_id) values($1,$2,$3)', [
          listing,
          unverified,
          seller,
        ]),
        /privilege|security/,
      );
    });
    await t.test('only participants send and read; messages cannot be edited, forged or deleted', async () => {
      await as(buyer);
      await send(buyer, '<script>plain text</script>');
      await assert.rejects(send(seller), /privilege|security/);
      await assert.rejects(send(buyer, ' '), /check constraint/);
      await assert.rejects(send(buyer, 'x'.repeat(2001)), /check constraint/);
      await as(seller);
      assert.equal((await run('select * from public.messages')).rows.length, 1);
      await send(seller, 'Reply');
      await assert.rejects(run("update public.messages set body='tampered'"), /permission denied/);
      await assert.rejects(run('delete from public.messages'), /permission denied/);
      await as(outsider);
      assert.equal((await run('select * from public.messages')).rows.length, 0);
      await assert.rejects(send(outsider), /privilege|security/);
    });
    await t.test('blocking is bilateral, cannot be removed by the blocked party and preserves history', async () => {
      await as(buyer);
      await run('insert into public.user_blocks(blocker_id,blocked_id) values($1,$2)', [buyer, seller]);
      await assert.rejects(send(buyer), /privilege/);
      await as(seller);
      await assert.rejects(send(seller), /privilege/);
      assert.equal((await run('select * from public.messages')).rows.length, 2);
      await run('delete from public.user_blocks');
      assert.equal((await run('select * from public.user_blocks')).rows.length, 1);
      await as(outsider);
      assert.equal((await run('select * from public.user_blocks')).rows.length, 0);
      await as(buyer);
      await run('delete from public.user_blocks');
      await send(buyer, 'Unblocked');
    });
    await t.test('reports are participant-only and hidden from the reported user', async () => {
      await as(outsider);
      await assert.rejects(
        run(
          "insert into public.conversation_reports(conversation_id,reporter_id,reason,details) values($1,$2,'spam','Test')",
          [thread, outsider],
        ),
        /row-level security/,
      );
      await as(buyer);
      await run(
        "insert into public.conversation_reports(conversation_id,reporter_id,reason,details) values($1,$2,'spam','Test')",
        [thread, buyer],
      );
      await assert.rejects(run("update public.conversation_reports set status='resolved'"), /permission denied/);
      await as(seller);
      assert.equal((await run('select * from public.conversation_reports')).rows.length, 0);
    });
    await t.test('direct database sending has a per-account rate limit', async () => {
      await as(seller);
      for (let i = 0; i < 19; i++) await send(seller);
      await assert.rejects(send(seller), /Rate limit/);
    });
    await t.test(
      'archived clubs disappear from saved browsing but existing conversations remain accessible',
      async () => {
        await as(seller);
        await run("update public.listings set status='archived' where id=$1", [listing]);
        await as(buyer);
        assert.equal(
          (await run('select l.id from public.favourites f join public.listings l on l.id=f.listing_id')).rows.length,
          0,
        );
        assert.equal((await run('select * from public.conversations')).rows.length, 1);
        await send(buyer, 'Existing history still works');
        await as(outsider);
        await assert.rejects(
          run('insert into public.conversations(listing_id,buyer_id,seller_id) values($1,$2,$3)', [
            listing,
            outsider,
            seller,
          ]),
          /privilege/,
        );
      },
    );
  } finally {
    await db.close();
  }
});
