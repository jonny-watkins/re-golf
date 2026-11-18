import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { retentionDays, runRetention } from '../server/retention';
import { assertDevelopmentOnly, developmentProject } from '../scripts/dev-guard';

test('clean-up removes only records past their retention period and never orders', async () => {
  const now = Date.parse('2026-12-31T12:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const tables: Record<string, Record<string, any>[]> = {
    orders: [
      { id: 'old-done', status: 'completed', updated_at: daysAgo(40) },
      { id: 'recent-done', status: 'completed', updated_at: daysAgo(5) },
      { id: 'old-open', status: 'dispatched', updated_at: daysAgo(40) },
      { id: 'old-cancelled', status: 'cancelled', updated_at: daysAgo(31) },
    ],
    order_addresses: [
      { order_id: 'old-done' },
      { order_id: 'recent-done' },
      { order_id: 'old-open' },
      { order_id: 'old-cancelled' },
    ],
    email_outbox: [
      { id: 1, sent_at: daysAgo(45) },
      { id: 2, sent_at: daysAgo(3) },
      { id: 3, sent_at: null },
    ],
    payment_events: [
      { event_id: 'evt_old', received_at: daysAgo(120) },
      { event_id: 'evt_new', received_at: daysAgo(10) },
    ],
  };
  const admin = {
    from: (table: string) => {
      let rows = tables[table];
      let deleting = false;
      const query: Record<string, any> = {
        select: () => query,
        delete: () => {
          deleting = true;
          return query;
        },
        in: (key: string, values: unknown[]) => {
          rows = rows.filter(row => values.includes(row[key]));
          return query;
        },
        lt: (key: string, value: string) => {
          rows = rows.filter(row => row[key] !== null && row[key] < value);
          return query;
        },
        limit: () => query,
        then: (resolve: (value: unknown) => void) => {
          if (deleting) tables[table] = tables[table].filter(row => !rows.includes(row));
          resolve({ data: rows, error: null });
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  assert.deepEqual(await runRetention(admin, now), { addresses: 2, emails: 1, paymentEvents: 1 });
  assert.deepEqual(
    tables.order_addresses.map(row => row.order_id),
    ['recent-done', 'old-open'],
  );
  assert.deepEqual(
    tables.email_outbox.map(row => row.id),
    [2, 3],
  );
  assert.deepEqual(
    tables.payment_events.map(row => row.event_id),
    ['evt_new'],
  );
  assert.equal(tables.orders.length, 4);
  assert.deepEqual(await runRetention(admin, now), { addresses: 0, emails: 0, paymentEvents: 0 });
  assert.ok(retentionDays.deliveryAddress >= 14, 'sellers and support need the address for a while after delivery');
});

test('hosted test scripts refuse any database except the development project', () => {
  assertDevelopmentOnly({ supabaseUrl: `https://${developmentProject}.supabase.co`, stripeSecretKey: 'sk_test_abc' });
  assert.throws(
    () =>
      assertDevelopmentOnly({ supabaseUrl: 'https://productionproject.supabase.co', stripeSecretKey: 'sk_test_abc' }),
    /only run against the development project/,
  );
  assert.throws(
    () =>
      assertDevelopmentOnly({
        supabaseUrl: `https://${developmentProject}.supabase.co`,
        stripeSecretKey: 'sk_live_abc',
      }),
    /TEST keys/,
  );
});
