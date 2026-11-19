// Compares what Stripe says happened to money with what the orders table says, and checks that
// nothing is stuck: refunds and payouts that are due, order deadlines, and queued emails. Read-only.
// Exits with code 1 if anything is wrong, so it can be scheduled as an alert
// (.github/workflows/money-check.yml runs it and GitHub emails the repository owner on failure).
//   npm run orders:reconcile            (last 30 days)
//   npm run orders:reconcile -- 90      (last 90 days)
// Settings come from .env when there is one, otherwise from the environment (a scheduled run).
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../server/config.js';

const config = readConfig(existsSync('.env') ? (dotenv.parse(readFileSync('.env')) as NodeJS.ProcessEnv) : process.env);
if (!config.stripeSecretKey) throw new Error('Set the Stripe keys in .env first.');
const days = Number(process.argv[2] || 30);
const since = new Date(Date.now() - days * 86_400_000);
const stripe = new Stripe(config.stripeSecretKey);
const admin = createClient(config.supabaseUrl, config.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const money = (pence: number) => '£' + (pence / 100).toFixed(2);
type Order = {
  id: string;
  title: string;
  status: string;
  funds: string;
  total_pence: number;
  item_pence: number;
  delivery_pence: number;
  payment_ref: string | null;
  seller_id: string;
  updated_at: string;
};

const { data, error } = await admin
  .from('orders')
  .select('id,title,status,funds,total_pence,item_pence,delivery_pence,payment_ref,seller_id,updated_at')
  .gte('created_at', since.toISOString())
  .order('created_at');
if (error) throw new Error('Orders could not be read: ' + error.code);
const orders = data as Order[];
const problems: string[] = [],
  pending: string[] = [];
const totals = { charged: 0, refunded: 0, paidToSellers: 0, held: 0 };
// Sellers who can be paid: money due to them should move within minutes.
const payable = new Set(
  ((await admin.from('seller_accounts').select('seller_id').eq('payouts_enabled', true)).data || []).map(
    row => row.seller_id as string,
  ),
);

for (const order of orders) {
  const label = `${order.id.slice(0, 8)} "${order.title}" (${order.status}, ${order.funds})`;
  if (!order.payment_ref) {
    if (order.funds !== 'none') problems.push(`${label}: money state without a Stripe payment`);
    continue;
  }
  const intent = await stripe.paymentIntents.retrieve(order.payment_ref, { expand: ['latest_charge'] });
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const refunded = charge?.amount_refunded ?? 0;
  let transferred = 0;
  for await (const transfer of stripe.transfers.list({ transfer_group: order.id, limit: 100 }))
    transferred += transfer.amount - transfer.amount_reversed;
  const sellerShare = order.item_pence + order.delivery_pence;
  if (intent.status !== 'succeeded' || intent.amount_received !== order.total_pence)
    problems.push(
      `${label}: Stripe charged ${money(intent.amount_received)} (${intent.status}), order total is ${money(order.total_pence)}`,
    );
  if (charge?.disputed && order.status !== 'disputed' && !['refunded', 'reversed'].includes(order.funds))
    problems.push(`${label}: Stripe shows a card dispute but the order is not frozen`);
  const expect = (wantRefund: number, wantTransfer: number) => {
    if (refunded !== wantRefund)
      problems.push(`${label}: Stripe refunded ${money(refunded)}, expected ${money(wantRefund)}`);
    if (transferred !== wantTransfer)
      problems.push(`${label}: Stripe paid the seller ${money(transferred)}, expected ${money(wantTransfer)}`);
  };
  const waitingMinutes = (Date.now() - Date.parse(order.updated_at)) / 60_000;
  switch (order.funds) {
    case 'held':
      expect(0, 0);
      totals.held += order.total_pence;
      break;
    case 'released':
      expect(0, sellerShare);
      break;
    case 'refunded':
      expect(order.total_pence, 0);
      break;
    case 'reversed':
      expect(0, 0);
      break;
    case 'release_due':
    case 'refund_due':
    case 'reversal_due':
      // In progress. A seller who has not set up payouts can legitimately wait; everything else should not.
      if ((order.funds !== 'release_due' || payable.has(order.seller_id)) && waitingMinutes > 60)
        problems.push(`${label}: waiting ${Math.round(waitingMinutes)} minutes for the money to move`);
      else pending.push(`${label}: in progress for ${Math.round(waitingMinutes)} minutes`);
      break;
    default:
      problems.push(`${label}: Stripe has a payment but the order shows no money`);
  }
  totals.charged += intent.amount_received;
  totals.refunded += refunded;
  totals.paidToSellers += transferred;
}

// The other direction: money Stripe holds that no order accounts for.
const known = new Set(orders.map(order => order.payment_ref));
let orphans = 0;
for await (const intent of stripe.paymentIntents.list({
  created: { gte: Math.floor(since.getTime() / 1000) },
  limit: 100,
  expand: ['data.latest_charge'],
})) {
  if (intent.status !== 'succeeded' || known.has(intent.id)) continue;
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  if ((charge?.amount_refunded ?? 0) >= intent.amount_received) continue; // fully returned, nothing owed
  orphans++;
  problems.push(
    `Stripe payment ${intent.id.slice(0, 12)}… of ${money(intent.amount_received)} has no matching order${intent.metadata.order_id ? ` (says order ${intent.metadata.order_id.slice(0, 8)})` : ''}`,
  );
}

// Deadlines are applied by a timer inside the web server. Reservations still open long after they
// expired, or orders unreleased long after their hold ended, mean that timer is not running.
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
for (const [what, query] of [
  [
    'reservation(s) still open more than an hour after expiring',
    admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'awaiting_payment')
      .lt('expires_at', hourAgo),
  ],
  [
    'delivered order(s) not released more than an hour after the hold ended',
    admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'delivered')
      .lt('release_at', hourAgo),
  ],
] as const) {
  const { count, error: failed } = await query;
  if (failed) problems.push(`Could not check for ${what}: ${failed.code}`);
  else if (count) problems.push(`${count} ${what}: the order deadlines are not being applied (is the server running?)`);
}
// Emails that keep failing. Unsent emails are normal until an email provider is configured.
{
  const { count, error: failed } = await admin
    .from('email_outbox')
    .select('id', { count: 'exact', head: true })
    .is('sent_at', null)
    .gte('attempts', 3);
  if (failed) problems.push(`Could not check the email queue: ${failed.code}`);
  else if (count) problems.push(`${count} email(s) have failed to send three or more times`);
}

console.log(
  `Checked ${orders.length} orders from the last ${days} days (${config.stripeSecretKey.includes('_test_') ? 'Stripe TEST mode' : 'LIVE'}).`,
);
console.log(
  `Charged ${money(totals.charged)}, refunded ${money(totals.refunded)}, paid to sellers ${money(totals.paidToSellers)}, currently held for buyers and sellers ${money(totals.held)}.`,
);
if (pending.length) console.log(`\nIn progress (${pending.length}):\n  ` + pending.join('\n  '));
if (problems.length) {
  console.log(`\nMISMATCHES (${problems.length}):\n  ` + problems.join('\n  '));
  process.exitCode = 1;
} else console.log('\nStripe and the orders table agree, and nothing is stuck.');
