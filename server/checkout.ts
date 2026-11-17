import type { Express, Request } from 'express';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { z } from 'zod';
import { SocialError } from './social.js';
export function checkoutRoutes(app: Express, authenticate: (req: Request) => Promise<{ db: SupabaseClient; user: User }>) {
  app.get('/api/test-checkout', async (req, res) => {
    const { db } = await authenticate(req);
    const inventory = await db.from('test_listings').select('*').order('created_at', { ascending: false }).limit(50);
    const orders = await db.from('test_orders').select('*').order('created_at', { ascending: false }).limit(50);
    if (inventory.error || orders.error) throw new SocialError(503, 'Test checkout is awaiting setup.');
    res.json({ listings: inventory.data, orders: orders.data });
  });
  app.post('/api/test-checkout', async (req, res) => {
    const { db } = await authenticate(req);
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('create'), title: z.string().trim().min(1).max(70), price_pence: z.number().int().min(100).max(2000000) }).strict(),
      z.object({ action: z.literal('quote'), listing_id: z.uuid() }).strict(),
      z.object({ action: z.literal('reserve'), listing_id: z.uuid(), request_id: z.uuid() }).strict(),
      z.object({ action: z.enum(['pay','fail','cancel','dispatch','deliver']), order_id: z.uuid() }).strict(),
    ]).parse(req.body);
    const { data, error } = await db.rpc('test_checkout', {
      p_action: input.action,
      p_listing: 'listing_id' in input ? input.listing_id : null,
      p_request: 'request_id' in input ? input.request_id : null,
      p_order: 'order_id' in input ? input.order_id : null,
      p_title: 'title' in input ? input.title : null,
      p_price: 'price_pence' in input ? input.price_pence : null,
    });
    if (error) throw new SocialError(error.code === '42501' ? 403 : error.code === '23505' ? 409 : error.code === 'P0001' ? 429 : 400,
      error.code === '23505' ? 'This test item is already reserved or sold.' : 'Test action unavailable. Check the order status and buyer or seller account.');
    res.json({ result: data });
  });
}
