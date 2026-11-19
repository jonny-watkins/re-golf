// Sends one of every order and message email, with sample details, to an inbox you name, so the
// wording, links and spam placement can be checked by eye. Uses EMAIL_API_KEY and EMAIL_FROM
// from .env (or the environment) and sends real emails through the email provider.
//   npx tsx scripts/send-sample-emails.ts you@yourinbox.example
//   npx tsx scripts/send-sample-emails.ts you@yourinbox.example order_sold new_message
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { readConfig } from '../server/config.js';
import { renderEmail, resendSender, undeliverable } from '../server/email.js';

const config = readConfig(existsSync('.env') ? (dotenv.parse(readFileSync('.env')) as NodeJS.ProcessEnv) : process.env);
const [to, ...only] = process.argv.slice(2);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to || '') || undeliverable(to)) throw new Error('Give a real inbox address.');
if (!config.emailApiKey || !config.emailFrom) throw new Error('Set EMAIL_API_KEY and EMAIL_FROM first.');

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const data = {
  order_id: '00000000-0000-4000-8000-000000000000',
  title: 'Ping G430 driver (sample)',
  total_pence: 23645,
  seller_pence: 23095,
  tracking: 'Royal Mail RM123456789GB',
  dispatch_by: soon(5),
  release_at: soon(2),
  return_by: soon(5),
  return_tracking: 'Evri H00ABC123456',
};
const templates = [
  'order_paid',
  'order_sold',
  'order_posted',
  'order_check',
  'order_delivered',
  'order_completed',
  'order_paid_out',
  'order_issue',
  'return_requested',
  'return_posted',
  'return_expired',
  'order_refunding',
  'order_refunded',
  'order_cancelled',
  'new_message',
].filter(name => !only.length || only.includes(name));

// Links in a sample must open on a phone, so a local address is replaced by the hosted preview.
const origin = /localhost|127\.0\.0\.1/.test(config.origin)
  ? 'https://re-golf-development.onrender.com'
  : config.origin;
const send = resendSender(config.emailApiKey, config.emailFrom);
let failed = 0;
for (const template of templates) {
  const email = renderEmail(template, data, origin)!;
  try {
    await send({ to, subject: email.subject, text: email.text });
    console.log('sent  ', template, '—', email.subject);
  } catch (error) {
    failed++;
    console.log('FAILED', template, '—', error instanceof Error ? error.message : error);
  }
  // The provider allows only a couple of sends a second.
  await new Promise(resolve => setTimeout(resolve, 700));
}
console.log(`\n${templates.length - failed} of ${templates.length} sent from ${config.emailFrom}.`);
process.exitCode = failed ? 1 : 0;
