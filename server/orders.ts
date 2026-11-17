import express, { type Express, type Request } from 'express';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { SocialError } from './social.js';
import type { OrderRow, PaymentEvent, Payments } from './payments.js';

type Authenticate = (req: Request) => Promise<{ db: SupabaseClient; user: User }>;
const orderColumns = 'id,listing_id,buyer_id,seller_id,title,item_pence,fee_pence,delivery_pence,total_pence,status,funds,expires_at,paid_at,dispatch_by,dispatched_at,tracking,delivered_at,release_at,completed_at,issue,created_at';

// The database functions raise short, user-safe messages with these codes.
const statusByCode: Record<string, number> = { '55000': 503, '42501': 403, 'P0002': 404, '23505': 409, '23514': 409, '22023': 400, 'P0001': 429 };
function check<T>(result: { data: T; error: { code?: string; message?: string } | null }): T {
  const { error } = result;
  if (!error) return result.data;
  const status = statusByCode[error.code || ''];
  if (status) throw new SocialError(status, error.message || 'This order action is unavailable.');
  throw new SocialError(503, 'Orders could not be loaded or updated. Please try again.');
}
function must<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) throw new Error(`${what} failed`);
  return result.data;
}

/** Registered before the JSON parser: signature checks need the exact bytes Stripe sent. */
export function paymentWebhook(app: Express, admin: SupabaseClient, payments: Payments) {
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let event: PaymentEvent;
    try { event = payments.parseEvent(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('stripe-signature') || ''); }
    catch { res.status(400).json({ error: 'Invalid webhook signature.' }); return; }
    // Any failure below returns 500, so the provider retries; handlers are repeat-safe.
    await handlePaymentEvent(admin, event);
    res.json({ received: true });
  });
}

export async function handlePaymentEvent(admin: SupabaseClient, event: PaymentEvent) {
  if (event.type === 'paid') {
    const order = must(await admin.from('orders').select('id,total_pence').eq('id', event.orderId).maybeSingle(), 'Order lookup');
    if (!order) { console.error('Payment event for unknown order', event.id); return; }
    if (event.amount !== order.total_pence || event.currency !== 'gbp') throw new Error(`Payment amount mismatch for order ${order.id}`);
    if (event.address) {
      const a = event.address;
      const saved = await admin.from('order_addresses').upsert({ order_id: order.id, name: a.name.slice(0, 120), line1: a.line1.slice(0, 120),
        line2: a.line2?.slice(0, 120) || null, city: (a.city || '-').slice(0, 80), postcode: a.postcode.slice(0, 12) }, { onConflict: 'order_id' });
      // A missing address must not block recording the payment; support can recover it from the provider.
      if (saved.error) console.error('Delivery address could not be saved for order', order.id);
    }
    must(await admin.rpc('order_system', { p_action: 'payment_succeeded', p_order: order.id, p_ref: event.paymentRef, p_event: event.id }), 'Payment confirmation');
  } else if (event.type === 'failed') {
    const result = await admin.rpc('order_system', { p_action: 'payment_failed', p_order: event.orderId, p_ref: null, p_event: event.id });
    if (result.error && result.error.code !== 'P0002') throw new Error('Payment failure handling failed');
  } else if (event.type === 'account') {
    must(await admin.from('seller_accounts').update({ payouts_enabled: event.payoutsEnabled }).eq('provider_account', event.account), 'Payout account update');
  } else if (event.type === 'chargeback') {
    const order = must(await admin.from('orders').select('id').eq('payment_ref', event.paymentRef).maybeSingle(), 'Order lookup');
    if (!order) { console.error('Card dispute for unknown payment', event.id); return; }
    must(await admin.rpc('order_system', { p_action: 'chargeback', p_order: order.id, p_ref: event.disputeRef, p_event: event.id }), 'Card dispute handling');
    // If the seller has been, or is about to be, paid, stop or take back the payout. Repeat-safe.
    const clawback = await admin.rpc('order_clawback', { p_action: 'start', p_order: order.id, p_ref: event.disputeRef, p_refund: false });
    if (clawback.error && !['PGRST202', '42883'].includes(clawback.error.code || '')) throw new Error('Payout clawback failed');
  }
}

/**
 * Applies the time rules, then performs the money movements the database has
 * decided on. Safe to run repeatedly and concurrently: the provider calls are
 * idempotent per order, and the database only accepts each outcome once.
 */
export async function settleOrders(admin: SupabaseClient, payments: Payments) {
  const swept = must(await admin.rpc('order_sweep'), 'Order sweep') as Record<string, number>;
  const columns = 'id,listing_id,buyer_id,seller_id,title,item_pence,fee_pence,delivery_pence,total_pence,status,funds,created_at,expires_at,checkout_ref,payment_ref';
  const result = { ...swept, reversed: 0, refunded: 0, released: 0, awaiting_payout_setup: 0, failed: 0 };
  // Payouts being taken back come first: a refund may be waiting on the money returning.
  const reversals = must(await admin.from('orders').select(columns + ',transfer_ref').eq('funds', 'reversal_due').order('updated_at').limit(50), 'Reversal queue') as unknown as OrderRow[];
  for (const order of reversals) {
    try {
      const ref = await payments.reverseTransfer(order);
      must(await admin.rpc('order_clawback', { p_action: 'reversed', p_order: order.id, p_ref: ref, p_refund: false }), 'Reversal record');
      result.reversed++;
    } catch (error) { result.failed++; console.error('Payout reversal failed for order', order.id, error instanceof Error ? error.message : ''); }
  }
  const refunds = must(await admin.from('orders').select(columns).eq('funds', 'refund_due').order('updated_at').limit(50), 'Refund queue') as OrderRow[];
  for (const order of refunds) {
    try {
      const ref = await payments.refund(order);
      must(await admin.rpc('order_system', { p_action: 'refunded', p_order: order.id, p_ref: ref, p_event: null }), 'Refund record');
      result.refunded++;
    } catch (error) { result.failed++; console.error('Refund failed for order', order.id, error instanceof Error ? error.message : ''); }
  }
  const releases = must(await admin.from('orders').select(columns).eq('funds', 'release_due').order('updated_at').limit(50), 'Release queue') as OrderRow[];
  if (releases.length) {
    const accounts = must(await admin.from('seller_accounts').select('seller_id,provider_account,payouts_enabled')
      .in('seller_id', [...new Set(releases.map(order => order.seller_id))]), 'Payout accounts') as { seller_id: string; provider_account: string; payouts_enabled: boolean }[];
    const accountBySeller = new Map<string, string>();
    for (const row of accounts) {
      // Money is waiting for this seller: ask the provider directly in case the status webhook was missed.
      if (!row.payouts_enabled) {
        try {
          if (!await payments.accountReady(row.provider_account)) continue;
          must(await admin.from('seller_accounts').update({ payouts_enabled: true }).eq('provider_account', row.provider_account), 'Payout account update');
        } catch { continue; }
      }
      accountBySeller.set(row.seller_id, row.provider_account);
    }
    for (const order of releases) {
      const account = accountBySeller.get(order.seller_id);
      if (!account) { result.awaiting_payout_setup++; continue; }
      try {
        const ref = await payments.transfer(order, account);
        must(await admin.rpc('order_system', { p_action: 'released', p_order: order.id, p_ref: ref, p_event: null }), 'Release record');
        result.released++;
      } catch (error) { result.failed++; console.error('Release failed for order', order.id, error instanceof Error ? error.message : ''); }
    }
  }
  return result;
}

export function orderRoutes(app: Express, authenticate: Authenticate, admin: SupabaseClient, payments: Payments, origin: string) {
  const empty = z.object({}).strict();
  async function startPayment(order: OrderRow, buyerEmail?: string) {
    const checkout = await payments.createCheckout(order, origin, buyerEmail);
    if (order.checkout_ref !== checkout.id) must(await admin.from('orders').update({ checkout_ref: checkout.id }).eq('id', order.id), 'Checkout reference');
    return checkout.url;
  }
  app.get('/api/orders', async (req, res) => {
    const { db, user } = await authenticate(req);
    const orders = check(await db.from('orders').select(orderColumns).order('created_at', { ascending: false }).limit(50)) as { id: string }[];
    // Row-level security returns an address only to the buyer, or to the seller while they need to post.
    const addresses = orders.length ? check(await db.from('order_addresses').select('order_id,name,line1,line2,city,postcode').in('order_id', orders.map(order => order.id))) : [];
    const account = check(await db.from('seller_accounts').select('payouts_enabled').eq('seller_id', user.id).maybeSingle()) as { payouts_enabled: boolean } | null;
    res.json({ orders, addresses, payouts: { started: Boolean(account), enabled: Boolean(account?.payouts_enabled) } });
  });
  app.post('/api/orders/quote', async (req, res) => {
    const { db } = await authenticate(req);
    const { listing_id } = z.object({ listing_id: z.uuid() }).strict().parse(req.body);
    res.json({ quote: check(await db.rpc('order_action', { p_action: 'quote', p_listing: listing_id })) });
  });
  app.post('/api/orders', async (req, res) => {
    const { db, user } = await authenticate(req);
    const { listing_id, request_id } = z.object({ listing_id: z.uuid(), request_id: z.uuid() }).strict().parse(req.body);
    const order = check(await db.rpc('order_action', { p_action: 'reserve', p_listing: listing_id, p_request: request_id })) as OrderRow;
    // A repeated request for an order that has moved on returns it without a new payment page.
    if (order.status !== 'awaiting_payment') { res.json({ order }); return; }
    let url: string;
    try { url = await startPayment(order, user.email); }
    catch (error) {
      console.error('Checkout could not be started for order', order.id, error instanceof Error ? error.message : '');
      await db.rpc('order_action', { p_action: 'cancel', p_order: order.id });
      throw new SocialError(503, 'Payment could not be started. You have not been charged; please try again.');
    }
    res.status(201).json({ order, checkout_url: url });
  });
  app.post('/api/orders/:id/pay', async (req, res) => {
    const { db, user } = await authenticate(req);
    const id = z.uuid().parse(req.params.id); empty.parse(req.body);
    const order = check(await db.from('orders').select('*').eq('id', id).eq('buyer_id', user.id).maybeSingle()) as OrderRow | null;
    if (!order) throw new SocialError(404, 'Order not found.');
    if (order.status !== 'awaiting_payment' || Date.parse(order.expires_at) <= Date.now()) throw new SocialError(409, 'This checkout has expired. Start again from the listing.');
    res.json({ checkout_url: await startPayment(order, user.email) });
  });
  app.post('/api/orders/:id/:action', async (req, res) => {
    const { db } = await authenticate(req);
    const id = z.uuid().parse(req.params.id);
    const action = z.enum(['cancel', 'dispatch', 'confirm_delivery', 'accept', 'report_issue']).parse(req.params.action);
    const { text } = z.object({ text: z.string().trim().max(2000).optional() }).strict().parse(req.body);
    const order = check(await db.rpc('order_action', { p_action: action, p_order: id, p_text: text ?? null })) as OrderRow;
    if (action === 'cancel' && order.checkout_ref) {
      // Best effort. If the buyer still pays, the late-payment rules revive or refund the order.
      try { await payments.expireCheckout(order.checkout_ref); } catch { /* already closed */ }
    }
    res.json({ order });
  });
  app.post('/api/payouts/onboard', async (req, res) => {
    const { user } = await authenticate(req); empty.parse(req.body);
    const find = async () => must(await admin.from('seller_accounts').select('provider_account').eq('seller_id', user.id).maybeSingle(), 'Payout account lookup') as { provider_account: string } | null;
    let account = (await find())?.provider_account;
    if (!account) {
      account = await payments.createSellerAccount(user.id, user.email);
      const saved = await admin.from('seller_accounts').insert({ seller_id: user.id, provider_account: account });
      if (saved.error && saved.error.code !== '23505') throw new Error('Payout account could not be saved');
    }
    res.json({ url: await payments.onboardingLink(account, origin) });
  });
}
