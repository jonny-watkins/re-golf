import type { Express, Request } from 'express';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { SocialError } from './social.js';

type Authenticate = (req: Request) => Promise<{ db: SupabaseClient; user: User }>;
type Result<T> = { data: T; error: { code?: string; message?: string } | null };
function must<T>(result: Result<T>, what: string): T {
  if (result.error) throw new Error(`${what} failed: ${result.error.code || ''}`);
  return result.data;
}
/** True when a database function or table from a not-yet-applied migration is missing. */
const missing = (error: { code?: string } | null) => Boolean(error && ['PGRST202', 'PGRST205', '42883', '42P01'].includes(error.code || ''));

/**
 * Support tools. Administrators are named in ADMIN_EMAILS on the server; every route
 * re-checks the signed-in, email-confirmed account against that list and then acts
 * with the server-only database key. Non-administrators get the same 404 as a
 * missing route, so the screen's existence is not advertised.
 */
export function adminRoutes(app: Express, authenticate: Authenticate, admin: SupabaseClient, adminEmails: string[], settle?: () => Promise<unknown>) {
  const isAdmin = (user: User) => Boolean(user.email && adminEmails.includes(user.email.toLowerCase()));
  async function adminOnly(req: Request) {
    const { user } = await authenticate(req);
    if (!isAdmin(user)) throw new SocialError(404, 'API route not found.');
    return user;
  }
  async function record(user: User, action: string, target: string, note?: string) {
    console.log('Admin action:', JSON.stringify({ admin: user.id, action, target }));
    const saved = await admin.from('admin_actions').insert({ admin_id: user.id, action, target, note: note || null });
    if (saved.error && !missing(saved.error)) console.error('Admin action could not be recorded:', saved.error.code);
  }
  const note = z.object({ note: z.string().trim().min(3).max(1000) }).strict();

  app.get('/api/me/role', async (req, res) => {
    const { user } = await authenticate(req);
    res.json({ admin: isAdmin(user) });
  });

  app.get('/api/admin/overview', async (req, res) => {
    await adminOnly(req);
    const orders = must(await admin.from('orders').select('id,title,buyer_id,seller_id,total_pence,item_pence,delivery_pence,status,funds,issue,tracking,created_at,updated_at,release_at,dispatch_by')
      .order('updated_at', { ascending: false }).limit(100), 'Orders') as { buyer_id: string; seller_id: string }[];
    const reports = must(await admin.from('conversation_reports').select('id,conversation_id,reporter_id,reason,details,status,created_at')
      .neq('status', 'resolved').order('created_at').limit(100), 'Reports') as { reporter_id: string }[];
    const ids = [...new Set([...orders.flatMap(order => [order.buyer_id, order.seller_id]), ...reports.map(report => report.reporter_id)])];
    const profiles = ids.length ? must(await admin.from('profiles').select('id,display_name').in('id', ids), 'Profiles') : [];
    const settings = await admin.rpc('marketplace_settings');
    if (settings.error && !missing(settings.error)) throw new Error('Settings failed');
    res.json({ orders, reports, profiles, settings: settings.error ? null : settings.data });
  });

  app.get('/api/admin/orders/:id', async (req, res) => {
    await adminOnly(req);
    const id = z.uuid().parse(req.params.id);
    const order = must(await admin.from('orders').select('*').eq('id', id).maybeSingle(), 'Order') as Record<string, any> | null;
    if (!order) throw new SocialError(404, 'Order not found.');
    const events = must(await admin.from('order_events').select('action,actor_id,status,funds,note,created_at').eq('order_id', id).order('id'), 'Order history');
    const address = must(await admin.from('order_addresses').select('name,line1,line2,city,postcode').eq('order_id', id).maybeSingle(), 'Address');
    // The buyer and seller's conversation about this listing is the main evidence in a dispute.
    const thread = must(await admin.from('conversations').select('id').eq('listing_id', order.listing_id).eq('buyer_id', order.buyer_id).maybeSingle(), 'Conversation') as { id: string } | null;
    const messages = thread ? must(await admin.from('messages').select('sender_id,body,created_at').eq('conversation_id', thread.id).order('id', { ascending: false }).limit(50), 'Messages') as unknown[] : [];
    res.json({ order, events, address, messages: messages.reverse() });
  });

  app.post('/api/admin/orders/:id/resolve', async (req, res) => {
    const user = await adminOnly(req);
    const id = z.uuid().parse(req.params.id);
    const input = note.extend({ decision: z.enum(['release', 'refund']) }).strict().parse(req.body);
    const order = must(await admin.from('orders').select('id,status,funds').eq('id', id).maybeSingle(), 'Order') as { status: string; funds: string } | null;
    if (!order) throw new SocialError(404, 'Order not found.');
    const reference = `support:${user.id}`;
    let result: Result<unknown>;
    if (order.funds === 'held' && (input.decision === 'refund' || order.status === 'disputed')) {
      result = await admin.rpc('order_system', { p_action: input.decision === 'release' ? 'resolve_release' : 'resolve_refund', p_order: id, p_ref: reference, p_event: null });
    } else if (input.decision === 'refund' && ['released', 'release_due'].includes(order.funds)) {
      // The seller has been, or is about to be, paid: take the payout back first.
      result = await admin.rpc('order_clawback', { p_action: 'start', p_order: id, p_ref: reference, p_refund: true });
      if (missing(result.error)) throw new SocialError(409, 'Refunding after payout needs the latest database update. Apply the pending migration first.');
      if (!result.error && order.funds === 'release_due') result = await admin.rpc('order_system', { p_action: 'resolve_refund', p_order: id, p_ref: reference, p_event: null });
    } else {
      throw new SocialError(409, `This order cannot be ${input.decision === 'release' ? 'released' : 'refunded'} in its current state (${order.status}, ${order.funds}).`);
    }
    if (result.error) throw new SocialError(result.error.code === '23514' ? 409 : 503, result.error.code === '23514' ? 'The order changed while you were deciding. Refresh and try again.' : 'The decision could not be saved. Please try again.');
    await record(user, `order_${input.decision}`, id, input.note);
    // Move the money now rather than at the next scheduled run; failures are retried there.
    if (settle) await settle().catch(error => console.error('Settlement after support decision failed:', error instanceof Error ? error.message : ''));
    res.json({ order: must(await admin.from('orders').select('id,status,funds').eq('id', id).single(), 'Order') });
  });

  app.post('/api/admin/reports/:id', async (req, res) => {
    const user = await adminOnly(req);
    const id = z.uuid().parse(req.params.id);
    const input = note.extend({ status: z.enum(['reviewed', 'resolved']) }).strict().parse(req.body);
    const updated = must(await admin.from('conversation_reports').update({ status: input.status }).eq('id', id).select('id'), 'Report') as unknown[];
    if (!updated.length) throw new SocialError(404, 'Report not found.');
    await record(user, `report_${input.status}`, id, input.note);
    res.json({ ok: true });
  });

  app.post('/api/admin/listings/:id/takedown', async (req, res) => {
    const user = await adminOnly(req);
    const id = z.uuid().parse(req.params.id);
    const input = note.parse(req.body);
    // Only listings on sale: one that is reserved or sold belongs to an order and is handled there.
    const updated = must(await admin.from('listings').update({ status: 'archived' }).eq('id', id).eq('status', 'active').select('id'), 'Listing') as unknown[];
    if (!updated.length) throw new SocialError(404, 'No listing on sale with that ID.');
    await record(user, 'listing_takedown', id, input.note);
    res.json({ ok: true });
  });

  app.post('/api/admin/checkout', async (req, res) => {
    const user = await adminOnly(req);
    const input = note.extend({ enabled: z.boolean() }).strict().parse(req.body);
    const result = await admin.rpc('set_checkout_enabled', { p_enabled: input.enabled });
    if (missing(result.error)) throw new SocialError(409, 'The checkout switch needs the latest database update. Apply the pending migration first.');
    await record(user, input.enabled ? 'checkout_on' : 'checkout_off', 'settings', input.note);
    res.json({ settings: must(result, 'Checkout switch') });
  });
}
