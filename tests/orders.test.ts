import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('orders hold funds until delivery checks pass', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111';
  const buyer = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const unverified = '44444444-4444-4444-8444-444444444444';
  type Order = {
    id: string;
    status: string;
    funds: string;
    total_pence: number;
    fee_pence: number;
    item_pence: number;
    release_at: string | null;
    tracking: string | null;
  };
  const admin = async (sql: string, params: unknown[] = []) => {
    await db.exec('reset role');
    return db.query<any>(sql, params);
  };
  async function as(id: string, role = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec(`set role ${role}`);
  }
  async function act(
    user: string,
    action: string,
    args: { listing?: string; request?: string; order?: string; text?: string } = {},
  ) {
    await as(user);
    return (
      await db.query<{ r: Order }>('select public.order_action($1,$2,$3,$4,$5) as r', [
        action,
        args.listing ?? null,
        args.request ?? null,
        args.order ?? null,
        args.text ?? null,
      ])
    ).rows[0].r;
  }
  async function system(action: string, order: string, ref: string | null = null, event: string | null = null) {
    await db.exec('reset role; set role service_role');
    return (await db.query<{ r: Order }>('select public.order_system($1,$2,$3,$4) as r', [action, order, ref, event]))
      .rows[0].r;
  }
  async function sweep() {
    await db.exec('reset role; set role service_role');
    return (await db.query<{ r: Record<string, number> }>('select public.order_sweep() as r')).rows[0].r;
  }
  async function newListing(price = 10000) {
    // Age earlier fixtures so the per-buyer hourly checkout limit does not interfere.
    await admin("update public.orders set created_at=now()-interval '2 hours'");
    await as(seller);
    return (
      await db.query<{ id: string }>(
        "insert into public.listings(seller_id,name,brand,category,condition,price_pence,location) values($1,'G430 Driver','Ping','Drivers','Good',$2,'Leeds') returning id",
        [seller, price],
      )
    ).rows[0].id;
  }
  const listingStatus = async (id: string) =>
    (await admin('select status from public.listings where id=$1', [id])).rows[0].status;
  const fetchOrder = async (id: string) =>
    (await admin('select * from public.orders where id=$1', [id])).rows[0] as Order;
  /** Reserve and pay, returning the paid order. */
  async function paidOrder(listing: string, who = buyer) {
    const order = await act(who, 'reserve', { listing, request: randomUUID() });
    return system('payment_succeeded', order.id, 'pi_' + order.id, 'evt_' + order.id);
  }

  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    // Same order as the hosted database, including the retired simulation that the last migration removes.
    for (const file of [
      '202611140001_foundations.sql',
      '20261117110226_favourites_messaging.sql',
      '20261117123645_test_checkout_orders.sql',
      '20261117150000_orders_escrow.sql',
      '20261117180000_support_and_clawback.sql',
    ])
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    for (const id of [seller, buyer, other, unverified])
      await db.query("insert into auth.users values($1,'{}',$2)", [
        id,
        id === unverified ? null : new Date().toISOString(),
      ]);

    let listing = await newListing();

    await t.test('checkout is closed until the server switch is enabled', async () => {
      await assert.rejects(act(buyer, 'quote', { listing }), /not open yet/);
      await assert.rejects(act(buyer, 'reserve', { listing, request: randomUUID() }), /not open yet/);
      await admin('update private.marketplace_settings set checkout_enabled=true');
    });

    await t.test('quote uses the stored price and a fixed-plus-percentage fee', async () => {
      const quote = (await act(buyer, 'quote', { listing })) as unknown as Record<string, number>;
      assert.deepEqual(
        [quote.item_pence, quote.fee_pence, quote.delivery_pence, quote.total_pence],
        [10000, 570, 595, 11165],
      );
      await assert.rejects(act(seller, 'quote', { listing }), /own listing/);
      await assert.rejects(act(unverified, 'quote', { listing }), /Confirm your email/);
      await db.exec('reset role; set role anon');
      await assert.rejects(db.query("select public.order_action('quote',$1)", [listing]), /permission denied/);
    });

    let order: Order, swept: Order;
    await t.test('reservation is atomic, idempotent and locks the listing', async () => {
      const request = randomUUID();
      order = await act(buyer, 'reserve', { listing, request });
      assert.deepEqual([order.status, order.funds, order.total_pence], ['awaiting_payment', 'none', 11165]);
      assert.equal((await act(buyer, 'reserve', { listing, request })).id, order.id);
      await assert.rejects(act(other, 'reserve', { listing, request: randomUUID() }), /already reserved or sold/);
      assert.equal(await listingStatus(listing), 'reserved');
    });

    await t.test('seller cannot edit, archive or re-activate a listing held by an order', async () => {
      await as(seller);
      await assert.rejects(
        db.query("update public.listings set status='active' where id=$1", [listing]),
        /part of an order/,
      );
      await assert.rejects(
        db.query('update public.listings set price_pence=100 where id=$1', [listing]),
        /part of an order/,
      );
      await assert.rejects(
        db.query("update public.listings set status='archived' where id=$1", [listing]),
        /part of an order/,
      );
      const free = await newListing();
      await assert.rejects(
        db.query("update public.listings set status='sold' where id=$1", [free]),
        /part of an order/,
      );
      await db.query("update public.listings set status='archived' where id=$1", [free]);
    });

    await t.test('clients cannot write orders, confirm payment or run system actions', async () => {
      await as(buyer);
      await assert.rejects(db.query("update public.orders set status='paid',funds='held'"), /permission denied/);
      await assert.rejects(
        db.query("select public.order_system('payment_succeeded',$1)", [order.id]),
        /permission denied/,
      );
      await assert.rejects(db.query('select public.order_sweep()'), /permission denied/);
      await assert.rejects(db.query('select * from public.payment_events'), /permission denied/);
      await assert.rejects(db.query('select * from private.marketplace_settings'), /permission denied/);
      await as(other);
      assert.equal((await db.query('select * from public.orders')).rows.length, 0);
      await assert.rejects(act(other, 'cancel', { order: order.id }), /Order unavailable/);
    });

    await t.test('verified payment holds funds; duplicate events change nothing', async () => {
      order = await system('payment_succeeded', order.id, 'pi_1', 'evt_1');
      assert.deepEqual([order.status, order.funds], ['paid', 'held']);
      assert.equal(await listingStatus(listing), 'sold');
      await system('payment_succeeded', order.id, 'pi_other', 'evt_1');
      await system('payment_failed', order.id, null, 'evt_2');
      const after = await fetchOrder(order.id);
      assert.deepEqual([after.status, after.funds, (after as any).payment_ref], ['paid', 'held', 'pi_1']);
      await assert.rejects(act(buyer, 'cancel', { order: order.id }), /no longer be cancelled/);
    });

    await t.test('funds stay held through dispatch and delivery, then release after the hold window', async () => {
      await assert.rejects(act(buyer, 'dispatch', { order: order.id }), /Seller action/);
      await assert.rejects(act(buyer, 'confirm_delivery', { order: order.id }), /not in transit/);
      await assert.rejects(act(seller, 'dispatch', { order: order.id }), /tracking number/);
      order = await act(seller, 'dispatch', { order: order.id, text: 'RM123456789GB' });
      assert.deepEqual([order.status, order.funds, order.tracking], ['dispatched', 'held', 'RM123456789GB']);
      await assert.rejects(act(seller, 'confirm_delivery', { order: order.id }), /Buyer action/);
      await assert.rejects(act(seller, 'accept', { order: order.id }), /Buyer action/);
      order = await act(buyer, 'confirm_delivery', { order: order.id });
      assert.deepEqual([order.status, order.funds], ['delivered', 'held']);
      const holdHours = (Date.parse(order.release_at!) - Date.now()) / 3_600_000;
      assert.ok(holdHours > 47 && holdHours <= 48);
      assert.equal((await sweep()).release_due, 0);
      assert.equal((await fetchOrder(order.id)).funds, 'held');
      await assert.rejects(system('released', order.id, 'tr_early'), /not due for release/);
      await admin("update public.orders set release_at=now()-interval '1 minute' where id=$1", [order.id]);
      assert.equal((await sweep()).release_due, 1);
      assert.deepEqual(
        [(await fetchOrder(order.id)).status, (await fetchOrder(order.id)).funds],
        ['completed', 'release_due'],
      );
      order = await system('released', order.id, 'tr_1');
      assert.equal(order.funds, 'released');
      assert.equal(((await system('released', order.id, 'tr_2')) as any).transfer_ref, 'tr_1');
      await assert.rejects(
        act(buyer, 'report_issue', { order: order.id, text: 'Too late' }),
        /window for this order is closed/,
      );
      assert.equal(await listingStatus(listing), 'sold');
    });

    await t.test('buyer can release early by accepting', async () => {
      listing = await newListing();
      order = await paidOrder(listing);
      await assert.rejects(act(buyer, 'accept', { order: order.id }), /cannot be completed yet/);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      order = await act(buyer, 'accept', { order: order.id });
      assert.deepEqual([order.status, order.funds], ['completed', 'release_due']);
    });

    await t.test('a reported issue freezes release until support resolves it', async () => {
      listing = await newListing();
      order = await paidOrder(listing);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'confirm_delivery', { order: order.id });
      await assert.rejects(act(seller, 'report_issue', { order: order.id, text: 'x' }), /Buyer action/);
      await assert.rejects(act(buyer, 'report_issue', { order: order.id, text: '  ' }), /Describe the issue/);
      order = await act(buyer, 'report_issue', { order: order.id, text: 'Shaft is cracked' });
      assert.deepEqual([order.status, order.funds, order.release_at], ['disputed', 'held', null]);
      await admin("update public.orders set updated_at=now()-interval '90 days' where id=$1", [order.id]);
      assert.equal((await sweep()).release_due, 0);
      await assert.rejects(act(buyer, 'accept', { order: order.id }), /cannot be completed yet/);
      order = await system('resolve_refund', order.id);
      assert.deepEqual([order.status, order.funds], ['cancelled', 'refund_due']);
      assert.equal(await listingStatus(listing), 'archived');
      await assert.rejects(system('released', order.id, 'tr_x'), /not due for release/);
      assert.equal((await system('refunded', order.id, 're_1')).funds, 'refunded');

      listing = await newListing();
      order = await paidOrder(listing);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'report_issue', { order: order.id, text: 'Not arrived' });
      order = await system('resolve_release', order.id);
      assert.deepEqual([order.status, order.funds], ['completed', 'release_due']);
    });

    await t.test('abandoned and failed checkouts free the item', async () => {
      listing = await newListing();
      order = await act(buyer, 'reserve', { listing, request: randomUUID() });
      order = await act(buyer, 'cancel', { order: order.id });
      assert.equal(order.status, 'cancelled');
      assert.equal(await listingStatus(listing), 'active');
      order = await act(other, 'reserve', { listing, request: randomUUID() });
      assert.equal((await system('payment_failed', order.id, null, 'evt_fail')).status, 'cancelled');
      assert.equal(await listingStatus(listing), 'active');
      order = await act(buyer, 'reserve', { listing, request: randomUUID() });
      await admin("update public.orders set expires_at=now()-interval '1 second' where id=$1", [order.id]);
      // The next buyer does not need to wait for the sweep.
      const next = await act(other, 'reserve', { listing, request: randomUUID() });
      assert.equal((await fetchOrder(order.id)).status, 'expired');
      assert.equal(next.status, 'awaiting_payment');
      await admin("update public.orders set expires_at=now()-interval '1 second' where id=$1", [next.id]);
      assert.equal((await sweep()).expired, 1);
      assert.equal(await listingStatus(listing), 'active');
    });

    await t.test('late payment never sells an item twice', async () => {
      listing = await newListing();
      const late = await act(buyer, 'reserve', { listing, request: randomUUID() });
      await admin("update public.orders set expires_at=now()-interval '1 second' where id=$1", [late.id]);
      const winner = await paidOrder(listing, other);
      assert.equal(winner.status, 'paid');
      const refunded = await system('payment_succeeded', late.id, 'pi_late', 'evt_late');
      assert.deepEqual([refunded.status, refunded.funds], ['expired', 'refund_due']);
      assert.equal(
        (await admin("select count(*)::int as n from public.orders where listing_id=$1 and status='paid'", [listing]))
          .rows[0].n,
        1,
      );

      // Late success with the item still free is honoured.
      listing = await newListing();
      const revived = await act(buyer, 'reserve', { listing, request: randomUUID() });
      await admin("update public.orders set expires_at=now()-interval '1 second' where id=$1", [revived.id]);
      await sweep();
      assert.equal(await listingStatus(listing), 'active');
      const paid = await system('payment_succeeded', revived.id, 'pi_revived', 'evt_revived');
      assert.deepEqual([paid.status, paid.funds], ['paid', 'held']);
      assert.equal(await listingStatus(listing), 'sold');
    });

    await t.test('sweep refunds undispatched orders and assumes delivery after the timeout', async () => {
      listing = await newListing();
      order = await paidOrder(listing);
      await admin("update public.orders set dispatch_by=now()-interval '1 minute' where id=$1", [order.id]);
      assert.equal((await sweep()).not_dispatched, 1);
      order = await fetchOrder(order.id);
      assert.deepEqual([order.status, order.funds], ['cancelled', 'refund_due']);
      assert.equal(await listingStatus(listing), 'active');

      order = await paidOrder(listing, other);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await admin("update public.orders set dispatched_at=now()-interval '11 days' where id=$1", [order.id]);
      assert.equal((await sweep()).assumed_delivered, 1);
      order = await fetchOrder(order.id);
      assert.deepEqual([order.status, order.funds], ['delivered', 'held']);
      assert.ok(order.release_at);
      swept = order;
    });

    await t.test('delivery address is private to the buyer, and to the seller only while posting', async () => {
      listing = await newListing();
      order = await paidOrder(listing);
      await db.exec('reset role; set role service_role');
      await db.query(
        "insert into public.order_addresses(order_id,name,line1,city,postcode) values($1,'A Buyer','1 Fairway','Leeds','LS1 1AA')",
        [order.id],
      );
      const visible = async (who: string) => {
        await as(who);
        return (await db.query('select * from public.order_addresses where order_id=$1', [order.id])).rows.length;
      };
      assert.deepEqual([await visible(buyer), await visible(seller), await visible(other)], [1, 1, 0]);
      await as(seller);
      await assert.rejects(db.query("update public.order_addresses set city='x'"), /permission denied/);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'accept', { order: order.id });
      assert.deepEqual([await visible(buyer), await visible(seller)], [1, 0]);
    });

    await t.test('a card dispute freezes held funds; payout accounts are private', async () => {
      listing = await newListing();
      order = await paidOrder(listing);
      order = await system('chargeback', order.id, 'dp_1', 'evt_dp_1');
      assert.deepEqual([order.status, order.funds], ['disputed', 'held']);
      await db.exec('reset role; set role service_role');
      await db.query("insert into public.seller_accounts(seller_id,provider_account) values($1,'acct_1')", [seller]);
      await as(seller);
      assert.deepEqual((await db.query('select seller_id,payouts_enabled from public.seller_accounts')).rows, [
        { seller_id: seller, payouts_enabled: false },
      ]);
      await assert.rejects(db.query('select provider_account from public.seller_accounts'), /permission denied/);
      await assert.rejects(db.query('update public.seller_accounts set payouts_enabled=true'), /permission denied/);
      await as(buyer);
      assert.equal((await db.query('select seller_id from public.seller_accounts')).rows.length, 0);
    });

    await t.test('support can read settings and switch checkout off; clients cannot', async () => {
      await db.exec('reset role; set role service_role');
      const settings = (await db.query<{ r: any }>('select public.marketplace_settings() as r')).rows[0].r;
      assert.deepEqual(
        [
          settings.checkout_enabled,
          settings.fee_fixed_pence,
          settings.fee_bps,
          settings.delivery_pence,
          settings.hold_hours,
        ],
        [true, 70, 500, 595, 48],
      );
      assert.equal(
        (await db.query<{ r: any }>('select public.set_checkout_enabled(false) as r')).rows[0].r.checkout_enabled,
        false,
      );
      listing = await newListing();
      await assert.rejects(act(buyer, 'reserve', { listing, request: randomUUID() }), /not open yet/);
      await assert.rejects(db.query('select public.set_checkout_enabled(true)'), /permission denied/);
      await assert.rejects(db.query('select public.marketplace_settings()'), /permission denied/);
      await assert.rejects(db.query('select * from public.admin_actions'), /permission denied/);
      await db.exec('reset role; set role service_role');
      await db.query('select public.set_checkout_enabled(true)');
      await db.query("insert into public.admin_actions(admin_id,action,target) values($1,'checkout_on','settings')", [
        seller,
      ]);
      // Orders already paid keep working while checkout is closed to new buyers.
    });

    await t.test('a payout can be stopped or taken back, then refunded', async () => {
      const clawback = async (action: string, id: string, ref: string | null = null, refund = false) => {
        await db.exec('reset role; set role service_role');
        return (
          await db.query<{ r: Order }>('select public.order_clawback($1,$2,$3,$4) as r', [action, id, ref, refund])
        ).rows[0].r;
      };
      // Queued but not yet paid out: stop it and hand the decision to support.
      order = await paidOrder(listing);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'accept', { order: order.id });
      order = await clawback('start', order.id, 'dp_2');
      assert.deepEqual([order.status, order.funds], ['disputed', 'held']);
      await assert.rejects(system('released', order.id, 'tr_no'), /not due for release/);
      order = await system('resolve_release', order.id);
      assert.deepEqual([order.status, order.funds], ['completed', 'release_due']);
      // Already paid out: take the transfer back, then refund the buyer.
      await system('released', order.id, 'tr_paid');
      order = await clawback('start', order.id, 'support', true);
      assert.deepEqual([order.status, order.funds], ['disputed', 'reversal_due']);
      await assert.rejects(system('refunded', order.id, 're_early'), /No refund is due/);
      order = await clawback('reversed', order.id, 'trr_1');
      assert.deepEqual([order.status, order.funds, (order as any).reversal_ref], ['cancelled', 'refund_due', 'trr_1']);
      assert.equal(((await clawback('reversed', order.id, 'trr_again')) as any).reversal_ref, 'trr_1');
      assert.equal((await system('refunded', order.id, 're_2')).funds, 'refunded');
      // Bank dispute after payout: money comes back from the seller and waits for the outcome.
      listing = await newListing();
      order = await paidOrder(listing);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'accept', { order: order.id });
      await system('released', order.id, 'tr_3');
      await clawback('start', order.id, 'dp_3');
      assert.equal((await clawback('reversed', order.id, 'trr_3')).funds, 'reversed');
      await assert.rejects(
        clawback('reversed', (await paidOrder(await newListing())).id, 'x'),
        /No payout is being taken back/,
      );
      await as(buyer);
      await assert.rejects(db.query("select public.order_clawback('start',$1)", [order.id]), /permission denied/);
    });

    await t.test('reviews: one each way, only after completion, readable by everyone', async () => {
      const review = async (who: string, id: string, rating: number, comment = '') => {
        await as(who);
        return (await db.query<{ r: any }>('select public.leave_review($1,$2,$3) as r', [id, rating, comment])).rows[0]
          .r;
      };
      listing = await newListing();
      order = await paidOrder(listing);
      await assert.rejects(review(buyer, order.id, 5), /once the order is complete/);
      await act(seller, 'dispatch', { order: order.id, text: 'Royal Mail RM123456789GB' });
      await act(buyer, 'accept', { order: order.id });
      await assert.rejects(review(other, order.id, 5), /Order unavailable/);
      await assert.rejects(review(buyer, order.id, 6), /rating from 1 to 5/);
      const made = await review(buyer, order.id, 5, '  Exactly as described  ');
      assert.deepEqual(
        [made.reviewer_id, made.reviewee_id, made.rating, made.comment],
        [buyer, seller, 5, 'Exactly as described'],
      );
      await assert.rejects(review(buyer, order.id, 1), /already reviewed/);
      assert.equal((await review(seller, order.id, 4)).reviewee_id, buyer);
      await as(buyer);
      await assert.rejects(
        db.query('insert into public.reviews(order_id,reviewer_id,reviewee_id,rating) values($1,$2,$3,5)', [
          order.id,
          other,
          seller,
        ]),
        /permission denied/,
      );
      await assert.rejects(db.query('update public.reviews set rating=1'), /permission denied/);
      await db.exec('reset role; set role anon');
      const seen = await db.query<{ rating: number; comment: string }>(
        'select rating,comment from public.reviews where reviewee_id=$1',
        [seller],
      );
      assert.deepEqual(seen.rows, [{ rating: 5, comment: 'Exactly as described' }]);
      await assert.rejects(db.query('select reviewer_id from public.reviews'), /permission denied/);
    });

    await t.test('the retired simulation is gone and the private schema is closed to clients', async () => {
      const left = await admin(
        "select to_regclass('public.test_orders') as a, to_regclass('public.test_listings') as b, to_regclass('private.test_checkout_settings') as c, to_regproc('public.test_checkout') as d",
      );
      assert.deepEqual(left.rows[0], { a: null, b: null, c: null, d: null });
      assert.equal(
        (await admin("select has_schema_privilege('authenticated','private','usage') as ok")).rows[0].ok,
        false,
      );
    });

    await t.test('snapshots survive fee changes; blocked pairs cannot trade; history is recorded', async () => {
      await admin('update private.marketplace_settings set fee_fixed_pence=999, fee_bps=0');
      assert.equal((await fetchOrder(swept.id)).fee_pence, 570);
      listing = await newListing(20000);
      const quote = (await act(buyer, 'quote', { listing })) as unknown as Record<string, number>;
      assert.equal(quote.fee_pence, 999);
      // Fixture only: skip the messaging guard, which requires a signed-in blocker with a conversation.
      await db.exec(`reset role; set session_replication_role=replica;
        insert into public.user_blocks(blocker_id,blocked_id) values('${seller}','${buyer}');
        set session_replication_role=origin;`);
      await assert.rejects(act(buyer, 'reserve', { listing, request: randomUUID() }), /unavailable to you/);
      await as(other);
      const events = await db.query<{ action: string; actor_id: string | null }>(
        'select action,actor_id from public.order_events where order_id=$1 order by id',
        [swept.id],
      );
      assert.deepEqual(
        events.rows.map(e => e.action),
        ['reserve', 'payment_succeeded', 'dispatch', 'assume_delivered'],
      );
      assert.equal(events.rows[1].actor_id, null);
      await as(buyer);
      assert.equal((await db.query('select * from public.order_events where order_id=$1', [swept.id])).rows.length, 0);
    });
  } finally {
    await db.close();
  }
});
