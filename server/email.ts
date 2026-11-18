import type { SupabaseClient } from '@supabase/supabase-js';

export type EmailSender = (message: { to: string; subject: string; text: string }) => Promise<void>;
type Row = {
  id: number;
  user_id: string;
  template: string;
  data: Record<string, unknown>;
  created_at: string;
  attempts: number;
};

const money = (pence: unknown) => '£' + (Number(pence) / 100).toFixed(2);
const day = (iso: unknown) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(new Date(String(iso)));

/** Plain-text emails. Each says what happened, what to do next, and where. Returns null for an unknown template. */
export function renderEmail(
  template: string,
  data: Record<string, unknown>,
  origin: string,
): { subject: string; text: string } | null {
  const title = String(data.title || 'your item');
  const orders = `${origin}/?order=${data.order_id}`;
  const wrap = (subject: string, lines: string[]) => ({ subject, text: [...lines, '', 'Relofted', origin].join('\n') });
  switch (template) {
    case 'order_paid':
      return wrap(`Order confirmed: ${title}`, [
        `Thanks for your order. You paid ${money(data.total_pence)} for ${title}.`,
        `Relofted is holding your payment. The seller must post it with tracking by ${day(data.dispatch_by)}, or you are refunded automatically.`,
        `Follow your order: ${orders}`,
      ]);
    case 'order_sold':
      return wrap(`You sold ${title}: post it by ${day(data.dispatch_by)}`, [
        `Good news: ${title} has sold and the buyer has paid.`,
        `Post it with a tracked service by ${day(data.dispatch_by)}, then enter the carrier and tracking number on your Orders screen. If it is not marked as posted by then, the order is cancelled and the buyer refunded.`,
        `You will receive ${money(data.seller_pence)} once the buyer has the item and the checking period has passed.`,
        `Delivery address and next steps: ${orders}`,
      ]);
    case 'order_posted':
      return wrap(`On its way: ${title}`, [
        `The seller has posted ${title}.`,
        `Tracking: ${data.tracking}`,
        `When it arrives, confirm on your Orders screen. You then have time to check it before the seller is paid.`,
        `Your order: ${orders}`,
      ]);
    case 'order_check':
      return wrap(`Has ${title} arrived?`, [
        `${title} is now recorded as delivered.`,
        `If there is a problem, report it on your Orders screen before ${day(data.release_at)}. After that the seller is paid.`,
        `Your order: ${orders}`,
      ]);
    case 'order_delivered':
      return wrap(`Delivered: ${title}`, [
        `${title} has been delivered.`,
        `Your payment of ${money(data.seller_pence)} is released on ${day(data.release_at)} unless the buyer reports a problem first.`,
        `Your sale: ${orders}`,
      ]);
    case 'order_completed':
      return wrap(`Sale complete: ${title}`, [
        `The sale of ${title} is complete and ${money(data.seller_pence)} is on its way to your payout account.`,
        `If you have not set up payouts yet, do that on your Orders screen to receive your money.`,
        `Your sale: ${orders}`,
      ]);
    case 'order_paid_out':
      return wrap(`You have been paid for ${title}`, [
        `${money(data.seller_pence)} for ${title} has been sent to your payout account.`,
        `Your sale: ${orders}`,
      ]);
    case 'order_issue':
      return wrap(`The buyer reported a problem with ${title}`, [
        `The buyer has reported a problem with ${title}. Payment is paused until it is settled.`,
        `On your Orders screen you can refund the buyer, or ask for the item back first: you are not asked to refund until it has been returned. You can talk to the buyer in Messages, and ask Relofted to decide if you cannot agree.`,
        `Your sale: ${orders}`,
      ]);
    case 'return_requested':
      return wrap(`Send ${title} back by ${day(data.return_by)}`, [
        `The seller has asked for ${title} to be returned before you are refunded.`,
        `Post it with a tracked service by ${day(data.return_by)} to the address on your Orders screen, then enter the carrier and tracking number there. Return postage is paid by you.`,
        `If it is not marked as posted by then, the problem is closed and the seller is paid.`,
        `Return address and next steps: ${orders}`,
      ]);
    case 'return_posted':
      return wrap(`${title} is on its way back to you`, [
        `The buyer has posted ${title} back to you.`,
        `Tracking: ${data.return_tracking}`,
        `When it arrives, check it and press "Item received back" on your Orders screen so the buyer is refunded. If it does not arrive, or is not what you sent, ask Relofted to decide instead. If you do neither, the buyer is refunded automatically once the parcel has had time to arrive.`,
        `Your sale: ${orders}`,
      ]);
    case 'return_expired':
      return wrap(`Problem closed: ${title}`, [
        `${title} was not marked as posted back by ${day(data.return_by)}, so the problem has been closed and the seller has been paid.`,
        `Your order: ${orders}`,
      ]);
    case 'order_refunding':
      return wrap(`Your refund for ${title} is on its way`, [
        `Your order for ${title} has been cancelled and ${money(data.total_pence)} is being refunded to your original payment method. Banks usually take 5 to 10 days to show it.`,
        `Your order: ${orders}`,
      ]);
    case 'order_refunded':
      return wrap(`Refund sent for ${title}`, [
        `We have refunded ${money(data.total_pence)} for ${title} to your original payment method.`,
        `Your order: ${orders}`,
      ]);
    case 'order_cancelled':
      return wrap(`Order cancelled: ${title}`, [
        `The order for ${title} has been cancelled and the buyer refunded.`,
        `Details: ${orders}`,
      ]);
    case 'new_message':
      return wrap(`New message about ${title}`, [
        `You have a new message about ${title}.`,
        `Read and reply on Relofted: ${origin}`,
        `For your protection, keep conversations and payments on Relofted.`,
      ]);
    default:
      return null;
  }
}

/** Sends through Resend's HTTP API. The key and sender address are set only once a domain is verified there. */
export function resendSender(apiKey: string, from: string): EmailSender {
  return async ({ to, subject, text }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  };
}

/**
 * Sends queued emails. Safe to run repeatedly. An email older than a day is dropped rather
 * than sent late (telling someone "post by Friday" on Saturday helps nobody), and one that
 * keeps failing is abandoned after five attempts so it cannot block the queue.
 */
export async function sendPendingEmails(admin: SupabaseClient, send: EmailSender, origin: string) {
  const result = { sent: 0, dropped: 0, failed: 0 };
  const pending = await admin
    .from('email_outbox')
    .select('id,user_id,template,data,created_at,attempts')
    .is('sent_at', null)
    .order('id')
    .limit(50);
  if (pending.error) {
    // The queue arrives with a later migration; until then there is nothing to send.
    if (['PGRST205', '42P01'].includes(pending.error.code || '')) return result;
    throw new Error('Email queue could not be read');
  }
  const finish = (id: number, note: string | null) =>
    admin.from('email_outbox').update({ sent_at: new Date().toISOString(), last_error: note }).eq('id', id);
  for (const row of pending.data as Row[]) {
    const message = renderEmail(row.template, row.data, origin);
    if (!message || Date.parse(row.created_at) < Date.now() - 86_400_000) {
      await finish(row.id, message ? 'expired' : 'unknown template');
      result.dropped++;
      continue;
    }
    try {
      const found = await admin.auth.admin.getUserById(row.user_id);
      const to = found.data.user?.email;
      if (!to || to.endsWith('@deleted.invalid')) {
        await finish(row.id, 'no address');
        result.dropped++;
        continue;
      }
      await send({ to, ...message });
      await finish(row.id, null);
      result.sent++;
    } catch (error) {
      const note = error instanceof Error ? error.message.slice(0, 200) : 'failed';
      if (row.attempts >= 4) await finish(row.id, 'gave up: ' + note);
      else
        await admin
          .from('email_outbox')
          .update({ attempts: row.attempts + 1, last_error: note })
          .eq('id', row.id);
      result.failed++;
    }
  }
  return result;
}
