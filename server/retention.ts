import type { SupabaseClient } from '@supabase/supabase-js';
import { missing } from './db.js';

/** How long each kind of record is kept once it is no longer needed. Review these with the privacy notice. */
export const retentionDays = {
  /** Delivery addresses, counted from when the order finished. The order itself is kept. */
  deliveryAddress: 30,
  /** Emails that have been sent or dropped. */
  sentEmail: 30,
  /** Payment-provider event IDs, kept only to recognise repeats; providers stop retrying after a few days. */
  paymentEvent: 90,
};

/**
 * Deletes personal and operational records that have outlived their purpose. Order and
 * payment records are never touched here. Safe to run at any time and more than once.
 */
export async function runRetention(admin: SupabaseClient, now = Date.now()) {
  const before = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const result = { addresses: 0, emails: 0, paymentEvents: 0 };
  const count = (deleted: { data: unknown[] | null; error: { code?: string } | null }, what: string) => {
    if (deleted.error) {
      // Tables from a migration that has not been applied yet simply have nothing to clean.
      if (missing(deleted.error)) return 0;
      throw new Error(`${what} clean-up failed`);
    }
    return deleted.data?.length ?? 0;
  };
  const finished = await admin
    .from('orders')
    .select('id')
    .in('status', ['completed', 'cancelled', 'expired'])
    .lt('updated_at', before(retentionDays.deliveryAddress))
    .limit(500);
  if (finished.error && !missing(finished.error)) throw new Error('Finished orders could not be read');
  const ids = (finished.data || []).map(row => row.id as string);
  if (ids.length) {
    result.addresses = count(
      await admin.from('order_addresses').delete().in('order_id', ids).select('order_id'),
      'Delivery address',
    );
  }
  result.emails = count(
    await admin.from('email_outbox').delete().lt('sent_at', before(retentionDays.sentEmail)).select('id'),
    'Email queue',
  );
  result.paymentEvents = count(
    await admin
      .from('payment_events')
      .delete()
      .lt('received_at', before(retentionDays.paymentEvent))
      .select('event_id'),
    'Payment event',
  );
  return result;
}
