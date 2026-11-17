import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { renderEmail, sendPendingEmails } from '../server/email';
import { readConfig } from '../server/config';

const origin = 'https://relofted.example';
const data = {
  order_id: 'o-1',
  title: 'Ping G430',
  total_pence: 11165,
  seller_pence: 10595,
  tracking: 'Royal Mail RM123456789GB',
  dispatch_by: '2026-11-22T15:36:00Z',
  release_at: '2026-11-24T10:00:00Z',
  conversation_id: 'c-1',
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
  'order_refunding',
  'order_refunded',
  'order_cancelled',
  'new_message',
];

test('every queued template renders a subject, the item, and a link back to the site', () => {
  for (const template of templates) {
    const email = renderEmail(template, data, origin);
    assert.ok(email, template);
    assert.match(email.subject, /Ping G430/, template);
    assert.ok(email.text.includes(origin) && email.text.includes('Relofted'), template);
    assert.ok(!/undefined|NaN|Invalid Date|\[object/.test(email.subject + email.text), `${template}: ${email.text}`);
  }
  assert.equal(renderEmail('nonsense', data, origin), null);
  const sold = renderEmail('order_sold', data, origin)!;
  assert.match(sold.subject, /post it by Sunday 22 November/);
  assert.match(sold.text, /You will receive £105\.95/);
  assert.match(sold.text, /\?order=o-1/);
  assert.match(renderEmail('order_paid', data, origin)!.text, /You paid £111\.65/);
  assert.match(renderEmail('order_posted', data, origin)!.text, /Tracking: Royal Mail RM123456789GB/);
});

test('email settings are all-or-nothing', () => {
  const base = {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_STORAGE_SECRET: 'sb_secret_test',
  };
  assert.equal(readConfig(base).emailApiKey, '');
  assert.throws(() => readConfig({ ...base, EMAIL_API_KEY: 're_123' }), /both EMAIL_API_KEY and EMAIL_FROM/);
  assert.throws(() => readConfig({ ...base, EMAIL_API_KEY: 're_123', EMAIL_FROM: 'not an address' }), /EMAIL_FROM/);
  assert.throws(
    () => readConfig({ EMAIL_API_KEY: 're_123', EMAIL_FROM: 'orders@relofted.example' }),
    /SUPABASE_STORAGE_SECRET/,
  );
  assert.equal(
    readConfig({ ...base, EMAIL_API_KEY: 're_123', EMAIL_FROM: 'Relofted <orders@relofted.example>' }).emailFrom,
    'Relofted <orders@relofted.example>',
  );
});

test('the queue sends once, drops stale or unsendable emails, and gives up on repeated failure', async () => {
  const now = new Date().toISOString(),
    old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const rows: Record<string, any>[] = [
    { id: 1, user_id: 'seller', template: 'order_sold', data, created_at: now, attempts: 0, sent_at: null },
    { id: 2, user_id: 'buyer', template: 'order_paid', data, created_at: old, attempts: 0, sent_at: null },
    { id: 3, user_id: 'deleted', template: 'new_message', data, created_at: now, attempts: 0, sent_at: null },
    { id: 4, user_id: 'bounces', template: 'order_posted', data, created_at: now, attempts: 0, sent_at: null },
    { id: 5, user_id: 'bounces', template: 'order_refunded', data, created_at: now, attempts: 4, sent_at: null },
    { id: 6, user_id: 'seller', template: 'mystery', data, created_at: now, attempts: 0, sent_at: null },
    { id: 7, user_id: 'seller', template: 'order_paid_out', data, created_at: now, attempts: 0, sent_at: now },
  ];
  const emails: Record<string, string> = {
    seller: 'seller@example.com',
    buyer: 'buyer@example.com',
    deleted: 'deleted-x@deleted.invalid',
    bounces: 'bounces@example.com',
  };
  const admin = {
    from: () => {
      let update: Record<string, unknown> | undefined;
      const query: Record<string, any> = {
        select: () => query,
        order: () => query,
        is: () => query,
        limit: async () => ({ data: rows.filter(row => !row.sent_at), error: null }),
        update: (values: Record<string, unknown>) => {
          update = values;
          return query;
        },
        eq: async (_key: string, id: number) => {
          Object.assign(
            rows.find(row => row.id === id)!,
            update,
          );
          return { error: null };
        },
      };
      return query;
    },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: emails[id] } }, error: null }) } },
  } as unknown as SupabaseClient;
  const sent: string[] = [];
  const send = async (message: { to: string; subject: string }) => {
    if (message.to.startsWith('bounces')) throw new Error('Email provider returned 500');
    sent.push(`${message.to}: ${message.subject}`);
  };
  assert.deepEqual(await sendPendingEmails(admin, send, origin), { sent: 1, dropped: 3, failed: 2 });
  assert.deepEqual(sent, ['seller@example.com: You sold Ping G430: post it by Sunday 22 November at 15:36']);
  const state = Object.fromEntries(
    rows.map(row => [row.id, `${row.sent_at ? 'done' : 'queued'}${row.last_error ? ' (' + row.last_error + ')' : ''}`]),
  );
  assert.deepEqual(state, {
    1: 'done',
    2: 'done (expired)',
    3: 'done (no address)',
    4: 'queued (Email provider returned 500)',
    5: 'done (gave up: Email provider returned 500)',
    6: 'done (unknown template)',
    7: 'done',
  });
  assert.equal(rows[3].attempts, 1);
  // Running again sends nothing twice; only the retry is attempted.
  assert.deepEqual(await sendPendingEmails(admin, send, origin), { sent: 0, dropped: 0, failed: 1 });
  assert.equal(sent.length, 1);
});
