import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('suspension, deletion and the email queue', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111',
    buyer = '22222222-2222-4222-8222-222222222222',
    other = '33333333-3333-4333-8333-333333333333';
  const admin = async (sql: string, params: unknown[] = []) => {
    await db.exec('reset role');
    return db.query<any>(sql, params);
  };
  async function as(id: string, role = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec(`set role ${role}`);
  }
  const act = async (user: string, action: string, args: { listing?: string; order?: string; text?: string } = {}) => {
    await as(user);
    return (
      await db.query<{ r: any }>('select public.order_action($1,$2,$3,$4,$5) as r', [
        action,
        args.listing ?? null,
        action === 'reserve' ? randomUUID() : null,
        args.order ?? null,
        args.text ?? null,
      ])
    ).rows[0].r;
  };
  const system = async (action: string, order: string, ref: string | null = null) => {
    await db.exec('reset role; set role service_role');
    return (await db.query<{ r: any }>('select public.order_system($1,$2,$3,null) as r', [action, order, ref])).rows[0]
      .r;
  };
  const newListing = async (who = seller) => {
    await as(who);
    return (
      await db.query<{ id: string }>(
        "insert into public.listings(seller_id,name,brand,category,condition,price_pence,location) values($1,'G430','Ping','Drivers','Good',10000,'Leeds') returning id",
        [who],
      )
    ).rows[0].id;
  };
  const queued = async (order?: string) =>
    (
      await admin(
        `select user_id, template from public.email_outbox ${order ? "where data->>'order_id'=$1" : ''} order by id`,
        order ? [order] : [],
      )
    ).rows.map(
      (row: any) => `${row.user_id === buyer ? 'buyer' : row.user_id === seller ? 'seller' : 'other'}:${row.template}`,
    );
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    for (const file of [
      '202611140001_foundations.sql',
      '20261117110226_favourites_messaging.sql',
      '20261117123645_test_checkout_orders.sql',
      '20261117150000_orders_escrow.sql',
      '20261117180000_support_and_clawback.sql',
      '20261117210000_accounts_and_emails.sql',
    ])
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    for (const id of [seller, buyer, other]) await db.query("insert into auth.users values($1,'{}',now())", [id]);
    await admin('select public.set_checkout_enabled(true)');
    let listing = await newListing();

    await t.test('every order step queues the right emails for the right person', async () => {
      let order = await act(buyer, 'reserve', { listing });
      assert.deepEqual(await queued(order.id), []);
      await system('payment_succeeded', order.id, 'pi_1');
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'confirm_delivery', { order: order.id });
      await act(buyer, 'accept', { order: order.id });
      await system('released', order.id, 'tr_1');
      assert.deepEqual(await queued(order.id), [
        'buyer:order_paid',
        'seller:order_sold',
        'buyer:order_posted',
        'seller:order_delivered',
        'seller:order_completed',
        'seller:order_paid_out',
      ]);
      const data = (await admin("select data from public.email_outbox where template='order_posted'")).rows[0].data;
      assert.deepEqual(
        [data.title, data.tracking, data.total_pence, data.seller_pence],
        ['Ping G430', 'Royal Mail RM123456789GB', 11165, 10595],
      );
      // Problem reported, then refunded by support.
      listing = await newListing();
      order = await act(buyer, 'reserve', { listing });
      await system('payment_succeeded', order.id, 'pi_2');
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'report_issue', { order: order.id, text: 'Cracked' });
      await system('resolve_refund', order.id);
      await system('refunded', order.id, 're_2');
      assert.deepEqual((await queued(order.id)).slice(3), [
        'seller:order_issue',
        'buyer:order_refunding',
        'seller:order_cancelled',
        'buyer:order_refunded',
      ]);
    });

    await t.test('a new message emails the other person at most once an hour per conversation', async () => {
      listing = await newListing();
      await as(buyer);
      const thread = (
        await db.query<{ id: string }>(
          'insert into public.conversations(listing_id,buyer_id,seller_id) values($1,$2,$3) returning id',
          [listing, buyer, seller],
        )
      ).rows[0].id;
      const send = async (who: string) => {
        await as(who);
        await db.query(
          'insert into public.messages(conversation_id,sender_id,body,client_id) values($1,$2,$3,gen_random_uuid())',
          [thread, who, 'Hello'],
        );
      };
      await send(buyer);
      await send(buyer);
      await send(seller);
      const sent = (
        await admin("select user_id from public.email_outbox where template='new_message' order by id")
      ).rows.map((row: any) => row.user_id);
      assert.deepEqual(sent, [seller, buyer]);
      await admin("update public.email_outbox set created_at=now()-interval '2 hours' where template='new_message'");
      await send(buyer);
      assert.equal(
        (await admin("select count(*)::int as n from public.email_outbox where template='new_message'")).rows[0].n,
        3,
      );
      await as(buyer);
      await assert.rejects(db.query('select * from public.email_outbox'), /permission denied/);
    });

    await t.test('a suspended member cannot list, message or trade; restoring them undoes it', async () => {
      await admin('update public.profiles set suspended_at=now() where id=$1', [seller]);
      await assert.rejects(newListing(seller), /row-level security/);
      await as(seller);
      await assert.rejects(
        db.query(
          'insert into public.messages(conversation_id,sender_id,body,client_id) select id,$1,$2,gen_random_uuid() from public.conversations limit 1',
          [seller, 'Hi'],
        ),
        /insufficient_privilege|permission|privilege/,
      );
      await assert.rejects(act(buyer, 'reserve', { listing }), /cannot be bought at the moment/);
      await as(seller);
      await assert.rejects(
        db.query('update public.profiles set suspended_at=null where id=$1', [seller]),
        /permission denied/,
      );
      // A suspended buyer is refused too.
      await admin('update public.profiles set suspended_at=null where id=$1', [seller]);
      await admin('update public.profiles set deleted_at=now() where id=$1', [other]);
      await assert.rejects(act(other, 'reserve', { listing }), /cannot be bought at the moment/);
      assert.equal((await act(buyer, 'reserve', { listing })).status, 'awaiting_payment');
    });

    await t.test('orders already under way continue for a suspended seller', async () => {
      const order = (await admin("select id from public.orders where status='awaiting_payment' limit 1")).rows[0].id;
      await system('payment_succeeded', order, 'pi_3');
      await admin('update public.profiles set suspended_at=now() where id=$1', [seller]);
      assert.equal((await act(seller, 'dispatch', { order, text: 'Royal Mail RM123456789GB' })).status, 'dispatched');
      assert.equal((await act(buyer, 'accept', { order })).funds, 'release_due');
    });
  } finally {
    await db.close();
  }
});
