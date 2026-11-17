import type { Express, Request } from 'express';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { searchFilters } from './search.js';

export class SocialError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function check(error: { code?: string } | null) {
  if (!error) return;
  if (error.code === 'P0001') throw new SocialError(429, 'Please wait before sending more messages or reports.');
  if (error.code === '42501')
    throw new SocialError(
      403,
      'This action is unavailable. The conversation may be blocked or the listing unavailable.',
    );
  if (error.code === '23505')
    throw new SocialError(409, 'This item has already been saved or reported. Refresh to see it.');
  throw new SocialError(503, 'Favourites or messages could not be loaded or saved. Please try again.');
}
const pageInput = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict();
const conversationColumns = 'id,listing_id,buyer_id,seller_id,listing_title,created_at';
export function socialRoutes(
  app: Express,
  authenticate: (req: Request) => Promise<{ db: SupabaseClient; user: User }>,
  listingColumns: () => Promise<string>,
) {
  app.get('/api/me/favourites', async (req, res) => {
    const { db, user } = await authenticate(req);
    const input = z
      .object({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        q: z.string().trim().max(100).default(''),
        category: z.string().max(40).optional(),
        condition: z.string().max(40).optional(),
        max_price: z.coerce.number().int().min(1).max(20000).optional(),
      })
      .strict()
      .parse(req.query);
    let query = db
      .from('favourites')
      .select(`listing_id,created_at,listings!inner(${await listingColumns()})`, { count: 'exact' })
      .eq('user_id', user.id)
      .eq('listings.status', 'active');
    for (const filter of searchFilters(input.q)) query = query.or(filter, { referencedTable: 'listings' });
    if (input.category) query = query.eq('listings.category', input.category);
    if (input.condition) query = query.eq('listings.condition', input.condition);
    if (input.max_price) query = query.lte('listings.price_pence', input.max_price * 100);
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .order('listing_id')
      .range((input.page - 1) * 24, input.page * 24 - 1);
    check(error);
    res.json({
      listings: (data as unknown as { listings: unknown }[] | null)?.map(row => row.listings),
      total: count,
      page: input.page,
    });
  });
  app.post('/api/me/favourites/status', async (req, res) => {
    const { db, user } = await authenticate(req);
    const { ids } = z
      .object({ ids: z.array(z.uuid()).max(24) })
      .strict()
      .parse(req.body);
    const { data, error } = await db
      .from('favourites')
      .select('listing_id')
      .eq('user_id', user.id)
      .in('listing_id', ids);
    check(error);
    res.json({ ids: data?.map(row => row.listing_id) });
  });
  app.put('/api/me/favourites/:id', async (req, res) => {
    const { db, user } = await authenticate(req);
    const id = z.uuid().parse(req.params.id);
    z.object({}).strict().parse(req.body);
    const { error } = await db
      .from('favourites')
      .upsert({ user_id: user.id, listing_id: id }, { onConflict: 'user_id,listing_id', ignoreDuplicates: true });
    check(error);
    res.json({ ok: true });
  });
  app.delete('/api/me/favourites/:id', async (req, res) => {
    const { db, user } = await authenticate(req);
    const id = z.uuid().parse(req.params.id);
    const { error } = await db.from('favourites').delete().eq('user_id', user.id).eq('listing_id', id);
    check(error);
    res.json({ ok: true });
  });
  app.get('/api/conversations', async (req, res) => {
    const { db } = await authenticate(req);
    const { page } = pageInput.parse(req.query);
    const { data, error, count } = await db
      .from('conversations')
      .select(conversationColumns, { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id')
      .range((page - 1) * 20, page * 20 - 1);
    check(error);
    res.json({ conversations: data, total: count });
  });
  app.post('/api/conversations', async (req, res) => {
    const { db, user } = await authenticate(req);
    const { listing_id } = z.object({ listing_id: z.uuid() }).strict().parse(req.body);
    const existing = await db
      .from('conversations')
      .select(conversationColumns)
      .eq('listing_id', listing_id)
      .eq('buyer_id', user.id)
      .maybeSingle();
    check(existing.error);
    if (existing.data) {
      res.json({ conversation: existing.data });
      return;
    }
    const listing = await db
      .from('listings')
      .select('seller_id')
      .eq('id', listing_id)
      .eq('status', 'active')
      .maybeSingle();
    check(listing.error);
    if (!listing.data || listing.data.seller_id === user.id)
      throw new SocialError(404, 'Choose an active listing from another seller.');
    const result = await db
      .from('conversations')
      .insert({ listing_id, buyer_id: user.id, seller_id: listing.data.seller_id })
      .select(conversationColumns)
      .single();
    if (result.error?.code === '23505') {
      const retry = await db
        .from('conversations')
        .select(conversationColumns)
        .eq('listing_id', listing_id)
        .eq('buyer_id', user.id)
        .single();
      check(retry.error);
      res.json({ conversation: retry.data });
      return;
    }
    check(result.error);
    res.status(201).json({ conversation: result.data });
  });
  async function conversation(req: Request) {
    const { db, user } = await authenticate(req);
    const id = z.uuid().parse(req.params.id);
    const { data, error } = await db.from('conversations').select(conversationColumns).eq('id', id).maybeSingle();
    check(error);
    if (!data) throw new SocialError(404, 'Conversation not found.');
    return { db, user, data, other: data.buyer_id === user.id ? data.seller_id : data.buyer_id };
  }
  app.get('/api/conversations/:id/messages', async (req, res) => {
    const { db, user, data: thread, other } = await conversation(req);
    const { before } = z
      .object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() })
      .strict()
      .parse(req.query);
    let query = db
      .from('messages')
      .select('id,sender_id,body,created_at')
      .eq('conversation_id', thread.id)
      .order('id', { ascending: false })
      .limit(51);
    if (before) query = query.lt('id', before);
    const messages = await query;
    check(messages.error);
    const blocks = await db
      .from('user_blocks')
      .select('blocker_id')
      .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${other}),and(blocker_id.eq.${other},blocked_id.eq.${user.id})`);
    check(blocks.error);
    res.json({
      conversation: thread,
      messages: messages.data?.slice(0, 50).reverse(),
      hasMore: (messages.data?.length || 0) > 50,
      blocked: !!blocks.data?.length,
      blockedByMe: blocks.data?.some(b => b.blocker_id === user.id),
    });
  });
  app.post('/api/conversations/:id/messages', async (req, res) => {
    const { db, user, data } = await conversation(req);
    const { body, client_id } = z
      .object({ body: z.string().trim().min(1).max(2000), client_id: z.uuid() })
      .strict()
      .parse(req.body);
    const prior = await db
      .from('messages')
      .select('id')
      .eq('sender_id', user.id)
      .eq('client_id', client_id)
      .maybeSingle();
    check(prior.error);
    if (prior.data) {
      res.json({ ok: true });
      return;
    }
    const { error } = await db
      .from('messages')
      .insert({ conversation_id: data.id, sender_id: user.id, body, client_id });
    if (error?.code !== '23505') check(error);
    res.status(201).json({ ok: true });
  });
  app.put('/api/conversations/:id/block', async (req, res) => {
    const { db, user, other } = await conversation(req);
    z.object({}).strict().parse(req.body);
    const { error } = await db
      .from('user_blocks')
      .upsert(
        { blocker_id: user.id, blocked_id: other },
        { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true },
      );
    check(error);
    res.json({ ok: true });
  });
  app.delete('/api/conversations/:id/block', async (req, res) => {
    const { db, user, other } = await conversation(req);
    const { error } = await db.from('user_blocks').delete().eq('blocker_id', user.id).eq('blocked_id', other);
    check(error);
    res.json({ ok: true });
  });
  app.post('/api/conversations/:id/report', async (req, res) => {
    const { db, user, data } = await conversation(req);
    const { reason, details } = z
      .object({ reason: z.enum(['spam', 'harassment', 'scam', 'other']), details: z.string().trim().min(1).max(2000) })
      .strict()
      .parse(req.body);
    const { error } = await db
      .from('conversation_reports')
      .insert({ conversation_id: data.id, reporter_id: user.id, reason, details });
    check(error);
    res.status(201).json({ ok: true });
  });
}
