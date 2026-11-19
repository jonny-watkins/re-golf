import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('problem photos and unread messages: database rules', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111',
    buyer = '22222222-2222-4222-8222-222222222222',
    other = '33333333-3333-4333-8333-333333333333';
  const admin = async (sql: string, params: unknown[] = []) => {
    await db.exec('reset role');
    return db.query<any>(sql, params);
  };
  const service = async (sql: string, params: unknown[] = []) => {
    await db.exec('reset role; set role service_role');
    return db.query<any>(sql, params);
  };
  const as = async (id: string, sql: string, params: unknown[] = []) => {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec('set role authenticated');
    return db.query<any>(sql, params);
  };
  const act = async (user: string, action: string, args: { listing?: string; order?: string; text?: string } = {}) =>
    (
      await as(user, 'select public.order_action($1,$2,$3,$4,$5) as r', [
        action,
        args.listing ?? null,
        action === 'reserve' ? randomUUID() : null,
        args.order ?? null,
        args.text ?? null,
      ])
    ).rows[0].r;
  const addPhoto = async (order: string, user: string) =>
    (await service('select public.add_issue_photo($1,$2) as id', [order, user])).rows[0].id as string;
  const unread = async (user: string) =>
    (await as(user, 'select public.unread_conversations() as id')).rows.map((row: any) => row.id);

  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    const folder = new URL('../supabase/migrations/', import.meta.url);
    const files = (await readdir(folder)).filter(name => !/listing_photos|harden_function/.test(name)).sort();
    const last = files.pop()!;
    assert.match(last, /issue_photos_and_unread/);
    for (const file of files) await db.exec(await readFile(new URL(file, folder), 'utf8'));
    for (const id of [seller, buyer, other]) await db.query("insert into auth.users values($1,'{}',now())", [id]);
    await admin('select public.set_checkout_enabled(true)');
    await admin('select public.set_require_payouts(false)');
    const listing = (
      await as(
        seller,
        "insert into public.listings(seller_id,name,brand,category,condition,price_pence,location) values($1,'G430','Ping','Drivers','Good',10000,'Leeds') returning id",
        [seller],
      )
    ).rows[0].id as string;
    // A conversation with one message each way, from before the change.
    const thread = (
      await as(buyer, 'insert into public.conversations(listing_id,buyer_id,seller_id) values($1,$2,$3) returning id', [
        listing,
        buyer,
        seller,
      ])
    ).rows[0].id as string;
    const send = async (user: string, body: string) =>
      Number(
        (
          await as(
            user,
            'insert into public.messages(conversation_id,sender_id,body,client_id) values($1,$2,$3,gen_random_uuid()) returning id',
            [thread, user, body],
          )
        ).rows[0].id,
      );
    await send(buyer, 'Is it still available?');
    const old = await send(seller, 'Yes');
    await db.exec('reset role');
    await db.exec(await readFile(new URL(last, folder), 'utf8'));

    await t.test(
      'messages sent before the change count as read; new ones are unread for the other person only',
      async () => {
        assert.deepEqual([await unread(buyer), await unread(seller)], [[], []]);
        const latest = await send(seller, 'I can post tomorrow');
        assert.ok(latest > old);
        assert.deepEqual([await unread(buyer), await unread(seller), await unread(other)], [[thread], [], []]);
        // Opening the conversation records the buyer's place.
        await as(
          buyer,
          'insert into public.conversation_reads(conversation_id,user_id,last_read_id) values($1,$2,$3) on conflict (conversation_id,user_id) do update set last_read_id=excluded.last_read_id',
          [thread, buyer, latest],
        );
        assert.deepEqual(await unread(buyer), []);
        await send(buyer, 'Great');
        assert.deepEqual([await unread(buyer), await unread(seller)], [[], [thread]]);
      },
    );

    await t.test('nobody can record a place for someone else or in a conversation they are not in', async () => {
      await assert.rejects(
        as(buyer, 'insert into public.conversation_reads(conversation_id,user_id,last_read_id) values($1,$2,1)', [
          thread,
          other,
        ]),
        /row-level security/,
      );
      await assert.rejects(
        as(other, 'insert into public.conversation_reads(conversation_id,user_id,last_read_id) values($1,$2,1)', [
          thread,
          other,
        ]),
        /row-level security/,
      );
      assert.equal((await as(seller, 'select * from public.conversation_reads')).rows.length, 1);
    });

    const order = await act(buyer, 'reserve', { listing });
    await service('select public.order_system($1,$2,$3,null)', ['payment_succeeded', order.id, 'pi_test']);
    await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });

    await t.test('photos can be added only while a problem is open, by the buyer or seller, four each', async () => {
      await assert.rejects(addPhoto(order.id, buyer), /while a problem is open/);
      await act(buyer, 'report_issue', { order: order.id, text: 'Shaft is cracked' });
      await assert.rejects(addPhoto(order.id, other), /Order unavailable/);
      const first = await addPhoto(order.id, buyer);
      for (let i = 0; i < 3; i++) await addPhoto(order.id, buyer);
      await assert.rejects(addPhoto(order.id, buyer), /up to four photos/);
      // The seller has their own allowance.
      await addPhoto(order.id, seller);
      // An upload that never finished stops counting after ten minutes.
      await admin("update public.order_issue_photos set created_at=now()-interval '11 minutes' where id=$1", [first]);
      await addPhoto(order.id, buyer);
      assert.equal((await admin('select 1 from public.order_issue_photos where id=$1', [first])).rows.length, 0);
    });

    await t.test(
      'only finished photos are visible, and only to the buyer and seller; the browser cannot add them',
      async () => {
        assert.equal((await as(buyer, 'select * from public.order_issue_photos')).rows.length, 0);
        await admin('update public.order_issue_photos set ready=true where uploader_id=$1', [buyer]);
        assert.equal((await as(buyer, 'select * from public.order_issue_photos')).rows.length, 4);
        assert.equal((await as(seller, 'select * from public.order_issue_photos')).rows.length, 4);
        assert.equal((await as(other, 'select * from public.order_issue_photos')).rows.length, 0);
        await assert.rejects(
          as(buyer, 'insert into public.order_issue_photos(order_id,uploader_id) values($1,$2)', [order.id, buyer]),
          /permission denied/,
        );
        await assert.rejects(as(buyer, 'select public.add_issue_photo($1,$2)', [order.id, buyer]), /permission denied/);
      },
    );
  } finally {
    await db.close();
  }
});
