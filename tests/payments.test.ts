import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { handlePaymentEvent, settleOrders } from '../server/orders';
import { stripePayments, sellerAmount, type OrderRow, type PaymentEvent, type Payments } from '../server/payments';

type Row = Record<string, any>;
/** Just enough of the Supabase client for the payment code paths. */
function fakeAdmin(tables: Record<string, Row[]>, rpcError?: (name: string, args: Row) => { code: string } | null) {
  const calls: Row[] = [];
  const from = (table: string) => {
    let rows = tables[table] || [];
    let update: Row | undefined;
    const query: Row = {
      select: () => query, order: () => query, limit: () => query,
      eq: (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return query; },
      in: (key: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[key])); return query; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      update: (values: Row) => { update = values; return query; },
      upsert: async (values: Row) => { calls.push({ table, upsert: values }); return { error: null }; },
      then: (resolve: (value: unknown) => void) => {
        if (update) { rows.forEach(row => Object.assign(row, update)); calls.push({ table, update, matched: rows.length }); }
        resolve({ data: rows, error: null });
      },
    };
    return query;
  };
  const rpc = async (name: string, args: Row = {}) => { calls.push({ rpc: name, ...args }); return { data: { swept: 0 }, error: rpcError?.(name, args) ?? null }; };
  return { client: { from, rpc } as unknown as SupabaseClient, calls };
}
const order = (id: string, extra: Partial<OrderRow> = {}): OrderRow => ({ id, listing_id: 'l', buyer_id: 'b', seller_id: 's1', title: 'Ping G430',
  item_pence: 10000, fee_pence: 570, delivery_pence: 595, total_pence: 11165, status: 'completed', funds: 'release_due',
  created_at: new Date().toISOString(), expires_at: new Date().toISOString(), checkout_ref: 'cs_1', payment_ref: 'pi_' + id, ...extra });

test('payment configuration is all-or-nothing and live keys need a second switch', () => {
  const base = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_STORAGE_SECRET: 'sb_secret_test' };
  assert.equal(readConfig(base).stripeSecretKey, '');
  assert.throws(() => readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc' }), /both STRIPE/);
  assert.throws(() => readConfig({ ...base, STRIPE_SECRET_KEY: 'pk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' }), /secret or restricted key/);
  assert.throws(() => readConfig({ SUPABASE_URL: base.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: base.SUPABASE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' }), /SUPABASE_STORAGE_SECRET/);
  assert.throws(() => readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' }), /ALLOW_LIVE_PAYMENTS/);
  assert.equal(readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' }).stripeSecretKey, 'sk_test_abc');
  assert.equal(readConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc', ALLOW_LIVE_PAYMENTS: 'true' }).stripeSecretKey, 'sk_live_abc');
});

test('Stripe webhooks are accepted only with a valid signature and map to order events', () => {
  const secret = 'whsec_testsecret';
  const payments = stripePayments('sk_test_abc', secret);
  const sign = (body: object) => {
    const payload = JSON.stringify(body);
    return [Buffer.from(payload), new Stripe('sk_test_abc').webhooks.generateTestHeaderString({ payload, secret })] as const;
  };
  const session = { id: 'cs_1', object: 'checkout.session', metadata: { order_id: 'order-1' }, payment_intent: 'pi_1', payment_status: 'paid',
    amount_total: 11165, currency: 'gbp', collected_information: { shipping_details: { name: 'A Buyer', address: { line1: '1 Fairway', line2: null, city: 'Leeds', state: null, postal_code: 'LS1 1AA', country: 'GB' } } } };
  const completed = { id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: session } };
  assert.deepEqual(payments.parseEvent(...sign(completed)), { id: 'evt_1', type: 'paid', orderId: 'order-1', paymentRef: 'pi_1', amount: 11165, currency: 'gbp',
    address: { name: 'A Buyer', line1: '1 Fairway', line2: null, city: 'Leeds', postcode: 'LS1 1AA' } });
  const [body, signature] = sign(completed);
  assert.throws(() => payments.parseEvent(Buffer.from(body.toString().replace('11165', '1')), signature));
  assert.throws(() => payments.parseEvent(body, ''));
  assert.throws(() => stripePayments('sk_test_abc', 'whsec_other').parseEvent(body, signature));
  // The second (connected accounts) secret is accepted too; an empty one is ignored.
  assert.equal(stripePayments('sk_test_abc', 'whsec_other', secret).parseEvent(body, signature).type, 'paid');
  assert.throws(() => stripePayments('sk_test_abc', 'whsec_other', '').parseEvent(body, signature));
  // A completed session that is not yet paid (delayed payment methods) must not confirm the order.
  assert.equal(payments.parseEvent(...sign({ ...completed, data: { object: { ...session, payment_status: 'unpaid' } } })).type, 'ignored');
  assert.deepEqual(payments.parseEvent(...sign({ id: 'evt_2', object: 'event', type: 'checkout.session.expired', data: { object: session } })), { id: 'evt_2', type: 'failed', orderId: 'order-1' });
  assert.deepEqual(payments.parseEvent(...sign({ id: 'evt_3', object: 'event', type: 'account.updated', data: { object: { id: 'acct_1', capabilities: { transfers: 'active' } } } })),
    { id: 'evt_3', type: 'account', account: 'acct_1', payoutsEnabled: true });
  assert.deepEqual(payments.parseEvent(...sign({ id: 'evt_4', object: 'event', type: 'charge.dispute.created', data: { object: { id: 'dp_1', payment_intent: 'pi_1' } } })),
    { id: 'evt_4', type: 'chargeback', paymentRef: 'pi_1', disputeRef: 'dp_1' });
  assert.equal(payments.parseEvent(...sign({ id: 'evt_5', object: 'event', type: 'customer.created', data: { object: {} } })).type, 'ignored');
});

test('a paid event must match the order total before the order is confirmed', async () => {
  const paid: PaymentEvent = { id: 'evt_1', type: 'paid', orderId: 'o1', paymentRef: 'pi_1', amount: 11165, currency: 'gbp',
    address: { name: 'A Buyer', line1: '1 Fairway', line2: null, city: 'Leeds', postcode: 'LS1 1AA' } };
  const admin = fakeAdmin({ orders: [{ id: 'o1', total_pence: 11165 }] });
  await assert.rejects(handlePaymentEvent(admin.client, { ...paid, amount: 100 }), /amount mismatch/);
  await assert.rejects(handlePaymentEvent(admin.client, { ...paid, currency: 'usd' }), /amount mismatch/);
  assert.equal(admin.calls.length, 0);
  await handlePaymentEvent(admin.client, paid);
  assert.deepEqual(admin.calls, [
    { table: 'order_addresses', upsert: { order_id: 'o1', name: 'A Buyer', line1: '1 Fairway', line2: null, city: 'Leeds', postcode: 'LS1 1AA' } },
    { rpc: 'order_system', p_action: 'payment_succeeded', p_order: 'o1', p_ref: 'pi_1', p_event: 'evt_1' }]);
  // Unknown orders are logged, not retried forever; database failures are retried.
  await handlePaymentEvent(fakeAdmin({ orders: [] }).client, paid);
  await assert.rejects(handlePaymentEvent(fakeAdmin({ orders: [{ id: 'o1', total_pence: 11165 }] }, () => ({ code: 'XX000' })).client, paid), /Payment confirmation failed/);

  const accounts = fakeAdmin({ seller_accounts: [{ provider_account: 'acct_1', payouts_enabled: false }, { provider_account: 'acct_2', payouts_enabled: false }] });
  await handlePaymentEvent(accounts.client, { id: 'evt_2', type: 'account', account: 'acct_1', payoutsEnabled: true });
  assert.deepEqual(accounts.calls, [{ table: 'seller_accounts', update: { payouts_enabled: true }, matched: 1 }]);
  const dispute = fakeAdmin({ orders: [{ id: 'o1', payment_ref: 'pi_1' }] });
  await handlePaymentEvent(dispute.client, { id: 'evt_3', type: 'chargeback', paymentRef: 'pi_1', disputeRef: 'dp_1' });
  assert.deepEqual(dispute.calls, [{ rpc: 'order_system', p_action: 'chargeback', p_order: 'o1', p_ref: 'dp_1', p_event: 'evt_3' }]);
});

test('settlement refunds and releases what the database has decided, and nothing else', async () => {
  const moved: string[] = [];
  const payments = {
    refund: async (o: OrderRow) => { moved.push(`refund ${o.id} ${o.total_pence}`); return 're_' + o.id; },
    transfer: async (o: OrderRow, account: string) => {
      if (o.id === 'broken') throw new Error('provider unavailable');
      moved.push(`transfer ${o.id} ${sellerAmount(o)} ${account}`); return 'tr_' + o.id;
    },
  } as unknown as Payments;
  const admin = fakeAdmin({
    orders: [order('held', { funds: 'held', status: 'delivered' }), order('refund', { funds: 'refund_due', status: 'cancelled' }),
      order('broken'), order('ready'), order('no-account', { seller_id: 's2' }), order('pending-account', { seller_id: 's3' })],
    seller_accounts: [{ seller_id: 's1', provider_account: 'acct_1', payouts_enabled: true }, { seller_id: 's3', provider_account: 'acct_3', payouts_enabled: false }],
  });
  const result = await settleOrders(admin.client, payments);
  // The seller receives the item price plus delivery; the buyer fee stays with the platform.
  assert.deepEqual(moved, ['refund refund 11165', 'transfer ready 10595 acct_1']);
  assert.deepEqual([result.refunded, result.released, result.awaiting_payout_setup, result.failed], [1, 1, 2, 1]);
  assert.deepEqual(admin.calls, [{ rpc: 'order_sweep' },
    { rpc: 'order_system', p_action: 'refunded', p_order: 'refund', p_ref: 're_refund', p_event: null },
    { rpc: 'order_system', p_action: 'released', p_order: 'ready', p_ref: 'tr_ready', p_event: null }]);
});

test('webhook endpoint bypasses the preview password but not signature checks', async () => {
  const admin = fakeAdmin({ orders: [{ id: 'o1', total_pence: 500 }] });
  const payments = { parseEvent: (body: Buffer, signature: string): PaymentEvent => {
    if (signature !== 'good') throw new Error('bad signature');
    return { id: 'evt_1', type: 'paid', orderId: JSON.parse(body.toString()).order, paymentRef: 'pi_1', amount: 500, currency: 'gbp', address: null };
  } } as unknown as Payments;
  const config = { ...readConfig({}), previewPassword: 'test-only-preview-password-not-real' };
  const server = createApp(config, undefined, admin.client, payments).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (signature: string) => fetch(url + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: '{"order":"o1"}' });
  try {
    assert.equal((await fetch(url + '/api/config')).status, 401);
    assert.equal((await fetch(url + '/api/orders')).status, 401);
    assert.equal((await post('bad')).status, 400);
    assert.equal(admin.calls.length, 0);
    const accepted = await post('good');
    assert.equal(accepted.status, 200);
    assert.deepEqual(admin.calls, [{ rpc: 'order_system', p_action: 'payment_succeeded', p_order: 'o1', p_ref: 'pi_1', p_event: 'evt_1' }]);
  } finally { server.close(); }
});
