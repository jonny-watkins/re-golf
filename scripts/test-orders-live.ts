// Hosted acceptance for orders and held payments. Runs against the Render preview with
// Stripe TEST keys and disposable accounts, and removes everything it created.
// Stripe's hosted payment page cannot be driven from a script, so "the buyer paid" is
// delivered as a correctly signed webhook built from the real checkout session plus a
// real test-card payment. A manual browser purchase covers the genuine Stripe event.
//   npx tsx scripts/test-orders-live.ts
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../server/config.js';
import { settleOrders } from '../server/orders.js';
import { stripePayments } from '../server/payments.js';
import { createApp } from '../server/app.js';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const env = dotenv.parse(readFileSync('.env'));
const config = readConfig(env as NodeJS.ProcessEnv);
assert.ok(config.stripeSecretKey.startsWith('sk_test_'), 'Stripe test keys only');
const base = 'https://re-golf-development.onrender.com';
const previewPassword = dotenv.parse(readFileSync('.env.render-preview')).PREVIEW_ACCESS_PASSWORD;
const cookie = { Cookie: 'relofted_preview=' + createHash('sha256').update(previewPassword).digest('hex') };
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.storageSecret, options);
const stripe = new Stripe(config.stripeSecretKey);
const payments = stripePayments(config.stripeSecretKey, config.stripeWebhookSecret, config.stripeConnectWebhookSecret);

type User = { id: string; token: string; email: string };
let local: Server | undefined;
const users: User[] = [];
const listings: string[] = [];
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log('PASS', name); }
  catch (error) { console.log('FAIL', name, '\n    ', error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n     ') : error); throw error; }
}
async function api(user: User | null, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: { ...cookie, ...(user ? { Authorization: 'Bearer ' + user.token } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function newListing(seller: User, price = 1000) {
  const made = await api(seller, '/api/listings', { name: 'TEST ORDER do not buy', brand: 'Automated', category: 'Putters', condition: 'Good', price_pence: price, location: 'Test' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  listings.push(made.data.listing.id);
  return made.data.listing.id as string;
}
const dbOrder = async (id: string) => (await admin.from('orders').select('*').eq('id', id).single()).data!;
const listingStatus = async (id: string) => (await admin.from('listings').select('status').eq('id', id).single()).data!.status;
/** Takes a real test-card payment and tells the preview about it the way Stripe would. */
async function pay(order: { id: string; total_pence: number }, eventId = 'evt_test_' + randomUUID()) {
  const row = await dbOrder(order.id);
  const session = await stripe.checkout.sessions.retrieve(row.checkout_ref);
  const intent = await stripe.paymentIntents.create({ amount: order.total_pence, currency: 'gbp', payment_method: 'pm_card_visa', confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, transfer_group: order.id, metadata: { order_id: order.id } });
  const payload = JSON.stringify({ id: eventId, object: 'event', type: 'checkout.session.completed', data: { object: { ...session, status: 'complete', payment_status: 'paid', payment_intent: intent.id,
    collected_information: { shipping_details: { name: 'Test Buyer', address: { line1: '1 Test Fairway', line2: null, city: 'Leeds', state: null, postal_code: 'LS1 1AA', country: 'GB' } } } } } });
  const send = () => fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json',
    'Stripe-Signature': stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripeWebhookSecret }) }, body: payload });
  const response = await send();
  assert.equal(response.status, 200);
  return { intent: intent.id, resend: send };
}
async function until(done: () => Promise<boolean>, tries = 20) {
  for (let i = 0; i < tries; i++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 2000)); }
  throw new Error('Timed out waiting');
}
async function reserve(buyer: User, listing: string) {
  const made = await api(buyer, '/api/orders', { listing_id: listing, request_id: randomUUID() });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.order as { id: string; total_pence: number };
}

try {
  for (let i = 0; i < 4; i++) {
    const email = `orders-test-${randomUUID()}@example.com`, password = randomUUID() + 'Aa1!';
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Order test ' + i } });
    assert.ok(!made.error, made.error?.message);
    const login = await createClient(config.supabaseUrl, config.publishableKey, options).auth.signInWithPassword({ email, password });
    assert.ok(!login.error, login.error?.message);
    users.push({ id: made.data.user!.id, token: login.data.session!.access_token, email });
  }
  const [seller, alice, bob, boss] = users;
  let listing = await newListing(seller);
  let order: { id: string; total_pence: number };

  await check('quote shows item + £0.70 + 5% fee + delivery; seller and anonymous cannot buy', async () => {
    const quote = await api(alice, '/api/orders/quote', { listing_id: listing });
    assert.deepEqual([quote.status, quote.data.quote?.item_pence, quote.data.quote?.fee_pence, quote.data.quote?.delivery_pence, quote.data.quote?.total_pence], [200, 1000, 120, 595, 1715], JSON.stringify(quote.data));
    assert.equal((await api(seller, '/api/orders/quote', { listing_id: listing })).status, 403);
    assert.equal((await api(null, '/api/orders/quote', { listing_id: listing })).status, 401);
  });

  await check('two simultaneous buyers: exactly one gets the item and a Stripe checkout', async () => {
    const [a, b] = await Promise.all([alice, bob].map(buyer => api(buyer, '/api/orders', { listing_id: listing, request_id: randomUUID() })));
    assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.data, b.data]));
    const winner = a.status === 201 ? a : b;
    assert.match(winner.data.checkout_url, /^https:\/\/checkout\.stripe\.com\//);
    order = winner.data.order;
    assert.equal(await listingStatus(listing), 'reserved');
    const visible = await api(null, '/api/listings?q=TEST%20ORDER');
    assert.ok(!visible.data.listings.some((item: any) => item.id === listing), 'reserved listing must leave public browsing');
    const session = await stripe.checkout.sessions.retrieve((await dbOrder(order.id)).checkout_ref);
    assert.deepEqual([session.amount_total, session.currency, session.status], [1715, 'gbp', 'open']);
  });

  await check('orders are private to their buyer and seller; seller cannot change a reserved listing', async () => {
    const buyer = (await dbOrder(order.id)).buyer_id === alice.id ? alice : bob, loser = buyer === alice ? bob : alice;
    assert.equal((await api(buyer, '/api/orders')).data.orders.length, 1);
    assert.equal((await api(seller, '/api/orders')).data.orders.length, 1);
    assert.equal((await api(loser, '/api/orders')).data.orders.length, 0);
    assert.equal((await api(loser, `/api/orders/${order.id}/cancel`, {})).status, 404);
    assert.equal((await api(seller, `/api/listings/${listing}`, { name: 'Changed', brand: 'Automated', category: 'Putters', condition: 'Good', price_pence: 100, location: 'Test' }, 'PUT')).status, 404);
    assert.notEqual((await api(seller, `/api/listings/${listing}/archive`, {})).status, 200);
    assert.equal(await listingStatus(listing), 'reserved');
  });

  await check('cancelling before payment frees the item and closes the Stripe checkout', async () => {
    const row = await dbOrder(order.id);
    const buyer = row.buyer_id === alice.id ? alice : bob;
    const cancelled = await api(buyer, `/api/orders/${order.id}/cancel`, {});
    assert.deepEqual([cancelled.status, cancelled.data.order?.status], [200, 'cancelled'], JSON.stringify(cancelled.data));
    assert.equal(await listingStatus(listing), 'active');
    assert.equal((await stripe.checkout.sessions.retrieve(row.checkout_ref)).status, 'expired');
  });

  await check('signed payment holds the funds; duplicates and forgeries change nothing', async () => {
    order = await reserve(alice, listing);
    const forged = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=00' }, body: '{}' });
    assert.equal(forged.status, 400);
    assert.equal((await dbOrder(order.id)).status, 'awaiting_payment');
    const payment = await pay(order);
    assert.equal((await payment.resend()).status, 200);
    const row = await dbOrder(order.id);
    assert.deepEqual([row.status, row.funds, row.payment_ref], ['paid', 'held', payment.intent]);
    assert.equal(await listingStatus(listing), 'sold');
    const events = await admin.from('order_events').select('action').eq('order_id', order.id).order('id');
    assert.deepEqual(events.data!.map(event => event.action), ['reserve', 'payment_succeeded']);
  });

  await check('seller sees the address only while posting; tracked postage is required', async () => {
    const before = await api(seller, '/api/orders');
    assert.equal(before.data.addresses[0]?.postcode, 'LS1 1AA', JSON.stringify(before.data.addresses));
    assert.equal((await api(bob, '/api/orders')).data.addresses.length, 0);
    assert.equal((await api(seller, `/api/orders/${order.id}/dispatch`, {})).status, 400);
    assert.equal((await api(alice, `/api/orders/${order.id}/dispatch`, { text: 'Royal Mail AB123456789GB' })).status, 403);
    const posted = await api(seller, `/api/orders/${order.id}/dispatch`, { text: 'Royal Mail AB123456789GB' });
    assert.deepEqual([posted.status, posted.data.order?.status, posted.data.order?.funds], [200, 'dispatched', 'held'], JSON.stringify(posted.data));
  });

  await check('delivery starts the 48-hour hold; funds stay held; buyer can release early', async () => {
    assert.equal((await api(seller, `/api/orders/${order.id}/confirm_delivery`, {})).status, 403);
    const delivered = await api(alice, `/api/orders/${order.id}/confirm_delivery`, {});
    const hours = (Date.parse(delivered.data.order.release_at) - Date.now()) / 3_600_000;
    assert.ok(delivered.data.order.status === 'delivered' && delivered.data.order.funds === 'held' && hours > 47.9 && hours <= 48, JSON.stringify(delivered.data));
    const settled = await settleOrders(admin, payments);
    assert.equal(settled.released, 0);
    assert.equal((await dbOrder(order.id)).funds, 'held');
    const accepted = await api(alice, `/api/orders/${order.id}/accept`, {});
    assert.deepEqual([accepted.data.order?.status, accepted.data.order?.funds], ['completed', 'release_due']);
    assert.equal((await api(seller, '/api/orders')).data.addresses.length, 0, 'address hidden from seller after completion');
  });

  await check('reviews: each side once, only after completion; seller rating is public', async () => {
    assert.equal((await api(bob, `/api/orders/${order.id}/review`, { rating: 5 })).status, 404);
    assert.equal((await api(alice, `/api/orders/${order.id}/review`, { rating: 9 })).status, 400);
    const made = await api(alice, `/api/orders/${order.id}/review`, { rating: 5, comment: 'Automated test: exactly as described' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal((await api(alice, `/api/orders/${order.id}/review`, { rating: 1 })).status, 409);
    assert.equal((await api(seller, `/api/orders/${order.id}/review`, { rating: 4 })).status, 201);
    const rating = await api(null, `/api/sellers/${seller.id}/rating`);
    assert.deepEqual([rating.data.count, rating.data.average, rating.data.recent[0]?.comment], [1, 5, 'Automated test: exactly as described']);
    const mine = await api(alice, '/api/orders');
    assert.ok(mine.data.reviewsEnabled && mine.data.reviewed.includes(order.id));
  });

  await check('payout waits for the seller to set up payouts; onboarding link is issued', async () => {
    const settled = await settleOrders(admin, payments);
    assert.ok(settled.awaiting_payout_setup >= 1 && settled.released === 0, JSON.stringify(settled));
    assert.equal((await dbOrder(order.id)).funds, 'release_due');
    const link = await api(seller, '/api/payouts/onboard', {});
    assert.equal(link.status, 200, JSON.stringify(link.data));
    assert.equal(new URL(link.data.url).host, 'connect.stripe.com');
    const state = await api(seller, '/api/orders');
    assert.deepEqual(state.data.payouts, { started: true, enabled: false });
  });

  await check('reported problem freezes the money; support refund returns it in full via Stripe', async () => {
    listing = await newListing(seller, 2000);
    order = await reserve(bob, listing);
    const payment = await pay(order);
    await api(seller, `/api/orders/${order.id}/dispatch`, { text: 'DPD 15501234567890' });
    const reported = await api(bob, `/api/orders/${order.id}/report_issue`, { text: 'Automated test: item not as described' });
    assert.deepEqual([reported.data.order?.status, reported.data.order?.funds, reported.data.order?.release_at], ['disputed', 'held', null]);
    assert.equal((await api(bob, `/api/orders/${order.id}/accept`, {})).status, 409);
    const resolved = await admin.rpc('order_system', { p_action: 'resolve_refund', p_order: order.id });
    assert.ok(!resolved.error, resolved.error?.message);
    const settled = await settleOrders(admin, payments);
    assert.ok(settled.refunded >= 1, JSON.stringify(settled));
    const row = await dbOrder(order.id);
    assert.deepEqual([row.status, row.funds], ['cancelled', 'refunded']);
    const refunds = await stripe.refunds.list({ payment_intent: payment.intent });
    assert.deepEqual(refunds.data.map(refund => [refund.amount, refund.status]), [[order.total_pence, 'succeeded']]);
    assert.deepEqual((await settleOrders(admin, payments)).refunded, 0, 'a second run must not refund again');
  });

  await check('seller who never posts: buyer is refunded and the item goes back on sale', async () => {
    listing = await newListing(seller, 1500);
    order = await reserve(alice, listing);
    const payment = await pay(order);
    await admin.from('orders').update({ dispatch_by: new Date(Date.now() - 60_000).toISOString() }).eq('id', order.id);
    const settled = await settleOrders(admin, payments);
    assert.ok(settled.not_dispatched >= 1 && settled.refunded >= 1, JSON.stringify(settled));
    assert.equal((await dbOrder(order.id)).funds, 'refunded');
    assert.equal(await listingStatus(listing), 'active');
    assert.equal((await stripe.refunds.list({ payment_intent: payment.intent })).data[0]?.amount, order.total_pence);
  });

  await check('payment arriving after the item went to someone else is refunded, not sold twice', async () => {
    const late = await reserve(alice, listing);
    await admin.from('orders').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', late.id);
    const winner = await reserve(bob, listing);
    await pay(winner);
    await pay(late);
    const row = await dbOrder(late.id);
    assert.deepEqual([row.status, row.funds], ['expired', 'refund_due']);
    assert.ok((await settleOrders(admin, payments)).refunded >= 1);
    const paid = await admin.from('orders').select('id').eq('listing_id', listing).eq('status', 'paid');
    assert.deepEqual(paid.data!.map(found => found.id), [winner.id]);
  });
  await check('support screen: only named administrators; a refund decision moves the money and is recorded', async () => {
    // The preview has no administrators configured, so run this build locally against the same database and Stripe sandbox.
    local = createApp({ ...config, adminEmails: [boss.email], previewPassword: '' }).listen(0, '127.0.0.1');
    await once(local, 'listening');
    const origin = 'http://127.0.0.1:' + (local.address() as AddressInfo).port;
    const support = async (user: User, path: string, body?: unknown) => {
      const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as any };
    };
    listing = await newListing(seller, 1200);
    order = await reserve(alice, listing);
    const payment = await pay(order);
    await api(seller, `/api/orders/${order.id}/dispatch`, { text: 'Evri H0123456789012345' });
    await api(alice, `/api/orders/${order.id}/report_issue`, { text: 'Automated test: wrong club in the box' });
    assert.deepEqual((await support(alice, '/api/me/role')).data, { admin: false });
    assert.equal((await support(alice, '/api/admin/overview')).status, 404);
    assert.equal((await support(seller, `/api/admin/orders/${order.id}/resolve`, { decision: 'release', note: 'I am the seller' })).status, 404);
    assert.deepEqual((await support(boss, '/api/me/role')).data, { admin: true });
    const overview = await support(boss, '/api/admin/overview');
    const listed = overview.data.orders.find((found: any) => found.id === order.id);
    assert.deepEqual([overview.status, listed?.status, listed?.funds, listed?.issue], [200, 'disputed', 'held', 'Automated test: wrong club in the box'], JSON.stringify(overview.data).slice(0, 300));
    const detail = await support(boss, `/api/admin/orders/${order.id}`);
    assert.deepEqual([detail.data.address?.postcode, detail.data.events.map((event: any) => event.action)], ['LS1 1AA', ['reserve', 'payment_succeeded', 'dispatch', 'report_issue']]);
    assert.equal((await support(boss, `/api/admin/orders/${order.id}/resolve`, { decision: 'refund', note: 'x' })).status, 400);
    const decided = await support(boss, `/api/admin/orders/${order.id}/resolve`, { decision: 'refund', note: 'Automated test: buyer evidence accepted' });
    assert.deepEqual([decided.status, decided.data.order?.status, decided.data.order?.funds], [200, 'cancelled', 'refunded'], JSON.stringify(decided.data));
    assert.deepEqual((await stripe.refunds.list({ payment_intent: payment.intent })).data.map(refund => refund.amount), [order.total_pence]);
    assert.equal((await support(boss, `/api/admin/orders/${order.id}/resolve`, { decision: 'refund', note: 'second attempt' })).status, 409);
    const history = (await admin.from('order_events').select('action,note').eq('order_id', order.id).order('id')).data!;
    assert.deepEqual(history.slice(-2).map(event => event.action), ['resolve_refund', 'refunded']);
    assert.equal(history.at(-2)!.note, 'support:' + boss.id);
    // Listing takedown.
    const bad = await newListing(seller, 900);
    assert.equal((await support(alice, `/api/admin/listings/${bad}/takedown`, { note: 'not allowed' })).status, 404);
    assert.equal((await support(boss, `/api/admin/listings/${bad}/takedown`, { note: 'Automated test: prohibited item' })).status, 200);
    assert.equal(await listingStatus(bad), 'archived');
    // Checkout switch: off blocks new purchases only; back on restores them.
    const off = await support(boss, '/api/admin/checkout', { enabled: false, note: 'Automated test: pause' });
    assert.deepEqual([off.status, off.data.settings?.checkout_enabled], [200, false], JSON.stringify(off.data));
    try { assert.equal((await api(alice, '/api/orders/quote', { listing_id: listing })).status, 503); }
    finally { assert.equal((await support(boss, '/api/admin/checkout', { enabled: true, note: 'Automated test: resume' })).data.settings?.checkout_enabled, true); }

    // Refund after the seller has been paid: the payout is taken back from the seller, then the buyer is refunded.
    const sellerAccount = await stripe.v2.core.accounts.create({ contact_email: seller.email, display_name: 'API test seller', dashboard: 'none',
      identity: { country: 'gb', entity_type: 'individual', individual: { given_name: 'Test', surname: 'Seller', email: seller.email, phone: '+447400123456', date_of_birth: { day: 1, month: 1, year: 1901 },
        address: { line1: 'address_full_match', city: 'London', postal_code: 'SW1A 2AA', country: 'gb' } },
        attestations: { terms_of_service: { account: { date: new Date().toISOString(), ip: '8.8.8.8' } } } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      defaults: { currency: 'gbp', responsibilities: { fees_collector: 'application', losses_collector: 'application' } } });
    const previous = (await admin.from('seller_accounts').select('provider_account').eq('seller_id', seller.id).single()).data!.provider_account;
    await stripe.v2.core.accounts.close(previous, { applied_configurations: ['recipient'] }).catch(() => {});
    await admin.from('seller_accounts').update({ provider_account: sellerAccount.id, payouts_enabled: true }).eq('seller_id', seller.id);
    const sold = await newListing(seller, 3000);
    order = await reserve(bob, sold);
    const paidOut = await pay(order);
    await api(seller, `/api/orders/${order.id}/dispatch`, { text: 'Parcelforce PF123456789GB' });
    await api(bob, `/api/orders/${order.id}/accept`, {});
    await until(async () => (await settleOrders(admin, payments), (await dbOrder(order.id)).funds === 'released'));
    const transferRef = (await dbOrder(order.id)).transfer_ref;
    assert.equal((await stripe.transfers.retrieve(transferRef)).amount, 3595);
    const clawed = await support(boss, `/api/admin/orders/${order.id}/resolve`, { decision: 'refund', note: 'Automated test: refund after payout' });
    assert.deepEqual([clawed.status, clawed.data.order?.status, clawed.data.order?.funds], [200, 'cancelled', 'refunded'], JSON.stringify(clawed.data));
    const transfer = await stripe.transfers.retrieve(transferRef);
    assert.deepEqual([transfer.amount_reversed, transfer.reversed], [3595, true]);
    assert.deepEqual((await stripe.refunds.list({ payment_intent: paidOut.intent })).data.map(refund => refund.amount), [order.total_pence]);
    const trail = (await admin.from('order_events').select('action').eq('order_id', order.id).order('id')).data!.map(event => event.action);
    assert.deepEqual(trail.slice(-4), ['released', 'clawback_started', 'payout_reversed', 'refunded']);
    const audit = (await admin.from('admin_actions').select('action').eq('admin_id', boss.id).order('id')).data!.map(row => row.action);
    assert.deepEqual(audit, ['order_refund', 'listing_takedown', 'checkout_off', 'checkout_on', 'order_refund']);
    const pricing = (await api(null, '/api/config')).data.pricing;
    assert.deepEqual(pricing && [pricing.feeFixedPence, pricing.feeBps, pricing.deliveryPence, pricing.checkoutOpen], [70, 500, 595, true], 'fee settings reach the browser: ' + JSON.stringify(pricing));
  });
  console.log(`\nAll ${passed} hosted order checks passed.`);
} finally {
  local?.close();
  // Refund anything still held by test orders, then remove every fixture.
  const ids = users.map(user => user.id);
  if (ids.length) {
    const orders = (await admin.from('orders').select('id,payment_ref,funds').in('seller_id', ids)).data || [];
    for (const order of orders) if (order.payment_ref && ['held', 'release_due', 'refund_due'].includes(order.funds)) {
      try { await stripe.refunds.create({ payment_intent: order.payment_ref }); } catch { /* already refunded */ }
    }
    const orderIds = orders.map(order => order.id);
    if (orderIds.length) {
      for (const table of ['reviews', 'order_events', 'payment_events', 'order_addresses']) await admin.from(table).delete().in('order_id', orderIds);
      await admin.from('orders').delete().in('id', orderIds);
    }
    const accounts = (await admin.from('seller_accounts').select('provider_account').in('seller_id', ids)).data || [];
    for (const account of accounts) { try { await stripe.v2.core.accounts.close(account.provider_account, { applied_configurations: ['recipient'] }); } catch { /* left in sandbox */ } }
    await admin.from('seller_accounts').delete().in('seller_id', ids);
    if (listings.length) await admin.from('listings').delete().in('id', listings);
    await admin.from('admin_actions').delete().in('admin_id', ids).then(() => {}, () => {});
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    const left = await admin.from('listings').select('id', { count: 'exact', head: true }).in('seller_id', ids);
    console.log(`Cleanup: removed ${orderIds.length} test orders, ${listings.length} test listings, ${ids.length} test accounts${left.count ? ` (WARNING: ${left.count} listings remain)` : ''}.`);
  }
}
