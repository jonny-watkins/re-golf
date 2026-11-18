import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('a reported problem is settled by refund, tracked return, withdrawal or support', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111',
    buyer = '22222222-2222-4222-8222-222222222222',
    other = '33333333-3333-4333-8333-333333333333';
  const address = 'Sam Seller, 1 Fairway Road, Leeds, LS1 1AA';
  const tracking = 'Royal Mail RM123456789GB';
  const admin = async (sql: string, params: unknown[] = []) => {
    await db.exec('reset role');
    return db.query<any>(sql, params);
  };
  async function as(id: string) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec('set role authenticated');
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
  const settle = async (user: string, action: string, order: string, text: string | null = null) => {
    await as(user);
    return (await db.query<{ r: any }>('select public.order_return($1,$2,$3) as r', [action, order, text])).rows[0].r;
  };
  const system = async (action: string, order: string, ref: string | null = null) => {
    await db.exec('reset role; set role service_role');
    return (await db.query<{ r: any }>('select public.order_system($1,$2,$3,null) as r', [action, order, ref])).rows[0]
      .r;
  };
  const sweep = async () => {
    await db.exec('reset role; set role service_role');
    return (await db.query<{ r: Record<string, number> }>('select public.order_sweep() as r')).rows[0].r;
  };
  const fetchOrder = async (id: string) => (await admin('select * from public.orders where id=$1', [id])).rows[0];
  const listingStatus = async (order: string) =>
    (
      await admin('select l.status from public.listings l join public.orders o on o.listing_id=l.id where o.id=$1', [
        order,
      ])
    ).rows[0].status;
  const emails = async (order: string) =>
    (
      await admin("select user_id, template from public.email_outbox where data->>'order_id'=$1 order by id", [order])
    ).rows
      .map((row: any) => `${row.user_id === buyer ? 'buyer' : 'seller'}:${row.template}`)
      .slice(4); // after paid, sold, posted and the problem report
  /** A posted order on which the buyer has reported a problem. */
  async function disputed() {
    await admin("update public.orders set created_at=now()-interval '2 hours'");
    await as(seller);
    const listing = (
      await db.query<{ id: string }>(
        "insert into public.listings(seller_id,name,brand,category,condition,price_pence,location) values($1,'G430','Ping','Drivers','Good',10000,'Leeds') returning id",
        [seller],
      )
    ).rows[0].id;
    const order = await act(buyer, 'reserve', { listing });
    await system('payment_succeeded', order.id, 'pi_' + order.id);
    await act(seller, 'dispatch', { order: order.id, text: tracking });
    return (await act(buyer, 'report_issue', { order: order.id, text: 'Shaft is cracked' })).id as string;
  }

  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    const folder = new URL('../supabase/migrations/', import.meta.url);
    // Photos need Supabase Storage, which the in-memory database does not have.
    for (const file of (await readdir(folder)).filter(name => !/listing_photos|harden_function/.test(name)).sort())
      await db.exec(await readFile(new URL(file, folder), 'utf8'));
    for (const id of [seller, buyer, other]) await db.query("insert into auth.users values($1,'{}',now())", [id]);
    await admin('select public.set_checkout_enabled(true)');

    await t.test('the seller can refund straight away without asking for the item back', async () => {
      const order = await disputed();
      await assert.rejects(settle(buyer, 'refund', order), /Seller action only/);
      await assert.rejects(settle(other, 'refund', order), /Order unavailable/);
      const after = await settle(seller, 'refund', order);
      assert.deepEqual([after.status, after.funds], ['cancelled', 'refund_due']);
      assert.equal(await listingStatus(order), 'archived');
      assert.deepEqual(await emails(order), ['buyer:order_refunding', 'seller:order_cancelled']);
      await assert.rejects(settle(seller, 'refund', order), /no open problem/);
    });

    await t.test('a tracked return: address, deadline, tracking, then refund when the seller has it back', async () => {
      const order = await disputed();
      await assert.rejects(settle(buyer, 'return_posted', order, tracking), /has not asked for the item back/);
      await assert.rejects(settle(buyer, 'request_return', order, address), /Seller action only/);
      await assert.rejects(settle(seller, 'request_return', order, 'Leeds'), /Enter the address/);
      let after = await settle(seller, 'request_return', order, address);
      assert.equal(after.return_address, address);
      const days = (Date.parse(after.return_by) - Date.now()) / 86_400_000;
      assert.ok(days > 4.9 && days < 5.1, 'the buyer has five days to post it back');
      // Repeating the request changes nothing.
      assert.equal((await settle(seller, 'request_return', order, 'Somewhere else entirely')).return_address, address);
      await assert.rejects(settle(buyer, 'return_posted', order, 'RM1'), /carrier and tracking/);
      await assert.rejects(settle(seller, 'return_posted', order, tracking), /Buyer action only/);
      after = await settle(buyer, 'return_posted', order, tracking);
      assert.equal(after.return_tracking, tracking);
      assert.deepEqual([after.status, after.funds], ['disputed', 'held']);
      await assert.rejects(settle(buyer, 'withdraw', order), /already posted the item back/);
      after = await settle(seller, 'refund', order);
      assert.deepEqual([after.status, after.funds, after.return_address], ['cancelled', 'refund_due', null]);
      assert.deepEqual(await emails(order), [
        'buyer:return_requested',
        'seller:return_posted',
        'buyer:order_refunding',
        'seller:order_cancelled',
      ]);
      // The seller's address is not kept in the order history.
      const notes = (await admin('select note from public.order_events where order_id=$1', [order])).rows;
      assert.ok(!notes.some((row: any) => String(row.note).includes('Fairway')));
    });

    await t.test('the seller is paid if the buyer does not post the item back in time', async () => {
      const order = await disputed();
      await settle(seller, 'request_return', order, address);
      assert.equal((await sweep()).return_not_posted, 0);
      await admin("update public.orders set return_by=now()-interval '1 minute' where id=$1", [order]);
      assert.equal((await sweep()).return_not_posted, 1);
      const after = await fetchOrder(order);
      assert.deepEqual([after.status, after.funds, after.return_address], ['completed', 'release_due', null]);
      assert.deepEqual(await emails(order), [
        'buyer:return_requested',
        'buyer:return_expired',
        'seller:order_completed',
      ]);
    });

    await t.test('the buyer is refunded automatically if the seller never confirms the return', async () => {
      const order = await disputed();
      await settle(seller, 'request_return', order, address);
      await settle(buyer, 'return_posted', order, tracking);
      // Posting it back before the deadline stops the "not posted" rule, even once the deadline passes.
      await admin("update public.orders set return_by=now()-interval '1 minute' where id=$1", [order]);
      assert.deepEqual([(await sweep()).return_not_posted, (await fetchOrder(order)).status], [0, 'disputed']);
      await admin("update public.orders set return_posted_at=now()-interval '11 days' where id=$1", [order]);
      assert.equal((await sweep()).return_assumed, 1);
      const after = await fetchOrder(order);
      assert.deepEqual([after.status, after.funds], ['cancelled', 'refund_due']);
      assert.equal(await listingStatus(order), 'archived');
    });

    await t.test('asking support to decide stops the automatic deadlines', async () => {
      const order = await disputed();
      await settle(seller, 'request_return', order, address);
      await settle(buyer, 'return_posted', order, tracking);
      await assert.rejects(settle(seller, 'escalate', order), /Say what you need/);
      const after = await settle(seller, 'escalate', order, 'A different club came back');
      assert.ok(after.return_escalated_at);
      await admin(
        "update public.orders set return_by=now()-interval '20 days', return_posted_at=now()-interval '11 days' where id=$1",
        [order],
      );
      const swept = await sweep();
      assert.deepEqual([swept.return_not_posted, swept.return_assumed], [0, 0]);
      assert.equal((await fetchOrder(order)).status, 'disputed');
      // Support's existing decision still applies, and clears the address.
      const decided = await system('resolve_release', order, 'support');
      assert.deepEqual([decided.status, decided.funds, decided.return_address], ['completed', 'release_due', null]);
      // Once support is deciding, a return can no longer be started.
      const second = await disputed();
      await settle(buyer, 'escalate', second, 'Seller is not replying');
      await assert.rejects(settle(seller, 'request_return', second, address), /support is deciding/);
    });

    await t.test('the buyer can withdraw the problem, which pays the seller', async () => {
      const order = await disputed();
      await assert.rejects(settle(seller, 'withdraw', order), /Buyer action only/);
      const after = await settle(buyer, 'withdraw', order);
      assert.deepEqual([after.status, after.funds], ['completed', 'release_due']);
      assert.deepEqual(await emails(order), ['seller:order_completed']);
    });

    await t.test('a card dispute is for support only, and only open problems can be settled', async () => {
      const order = await disputed();
      await settle(seller, 'request_return', order, address);
      await system('chargeback', order, 'dp_1');
      await assert.rejects(settle(seller, 'refund', order), /support is handling/);
      await assert.rejects(settle(buyer, 'withdraw', order), /support is handling/);
      await admin("update public.orders set return_by=now()-interval '1 minute' where id=$1", [order]);
      assert.equal((await sweep()).return_not_posted, 0);
      // An order with no problem reported.
      const paid = await disputed();
      await settle(buyer, 'withdraw', paid);
      await assert.rejects(settle(seller, 'refund', paid), /no open problem/);
      await db.exec('reset role; set role anon');
      await assert.rejects(db.query("select public.order_return('refund',$1)", [order]), /permission denied/);
    });
  } finally {
    await db.close();
  }
});
