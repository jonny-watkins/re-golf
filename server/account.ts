import type { Express, Request } from 'express';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SocialError } from './social.js';
import type { Payments } from './payments.js';

type Authenticate = (req: Request) => Promise<{ db: SupabaseClient; user: User }>;
const openStatuses = ['awaiting_payment', 'paid', 'dispatched', 'delivered', 'disputed'];
const movingFunds = ['release_due', 'refund_due', 'reversal_due'];

/**
 * Closes an account at the member's request. Personal details are removed and sign-in is
 * blocked, but order records stay (they are financial records the business must keep) and
 * messages stay visible to the other person in each conversation, shown as from a
 * deleted member. Refused while an order is in progress or money is still moving.
 */
export async function closeAccount(admin: SupabaseClient, userId: string, payments: Payments | null) {
  const busy = await admin.from('orders').select('id,status,funds').or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
    .or(`status.in.(${openStatuses.join(',')}),funds.in.(${movingFunds.join(',')})`).limit(1);
  if (busy.error) throw new Error('Order check failed');
  if (busy.data.length) throw new SocialError(409, 'You have an order in progress. Your account can be deleted once it is complete and any payment has been settled.');
  const marked = await admin.from('profiles').update({ display_name: 'Deleted member', deleted_at: new Date().toISOString() }).eq('id', userId);
  if (marked.error) {
    if (['PGRST204', '42703'].includes(marked.error.code || '')) throw new SocialError(503, 'Account deletion is not available yet. Please contact support.');
    throw new Error('Profile update failed');
  }
  // Everything below is tidy-up; the account is already unable to act.
  const listings = await admin.from('listings').select('id').eq('seller_id', userId);
  const listingIds = (listings.data || []).map(row => row.id as string);
  await admin.from('listings').update({ status: 'archived' }).eq('seller_id', userId).eq('status', 'active');
  // Removing photo rows queues the stored files for the existing cleanup job.
  if (listingIds.length) await admin.from('listing_photos').delete().in('listing_id', listingIds);
  await admin.from('favourites').delete().eq('user_id', userId);
  await admin.from('user_blocks').delete().eq('blocker_id', userId);
  const orders = await admin.from('orders').select('id').eq('buyer_id', userId);
  if (orders.data?.length) await admin.from('order_addresses').delete().in('order_id', orders.data.map(row => row.id));
  const account = await admin.from('seller_accounts').select('provider_account').eq('seller_id', userId).maybeSingle();
  if (account.data && payments) await payments.closeSellerAccount(account.data.provider_account).catch(() => { /* Stripe keeps it if a balance remains; support can close it later */ });
  // Replace the sign-in identity so the email address is no longer held, and block sign-in for good.
  const scrubbed = await admin.auth.admin.updateUserById(userId, { email: `deleted-${userId}@deleted.invalid`, password: randomUUID() + randomUUID(),
    email_confirm: true, user_metadata: { display_name: 'Deleted member' }, ban_duration: '876000h' });
  if (scrubbed.error) throw new Error('Sign-in details could not be removed');
}

export function accountRoutes(app: Express, authenticate: Authenticate, admin: SupabaseClient, payments: Payments | null) {
  app.post('/api/me/delete', async (req, res) => {
    const { user } = await authenticate(req);
    // Typed confirmation, so a stray click or a forged request cannot close an account.
    z.object({ confirm: z.literal('DELETE') }).strict().parse(req.body);
    await closeAccount(admin, user.id, payments);
    console.log('Account closed at member request:', user.id);
    res.json({ ok: true });
  });
}
