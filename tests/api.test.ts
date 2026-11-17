import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { listingInput } from '../shared/listings';
import { searchFilters } from '../server/search';

test('configuration never exposes privileged keys', () => {
  assert.throws(() => readConfig({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not_public' }), /publishable/);
  assert.throws(() => readConfig({ SUPABASE_URL: 'https://test.supabase.co' }), /both/);
  assert.throws(() => readConfig({ SUPABASE_URL: 'http://attacker.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }), /HTTPS/);
});
test('Render uses the public origin and interface and fails closed without configuration', () => {
  const env = { RENDER: 'true', PREVIEW_ACCESS_PASSWORD: 'test-only-preview-password-not-real', RENDER_EXTERNAL_URL: 'https://re-golf-test.onrender.com', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', PORT: '10000' };
  const config = readConfig(env);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.origin, env.RENDER_EXTERNAL_URL);
  assert.equal(config.port, 10000);
  assert.equal(config.trustProxyHops, 1);
  assert.throws(() => readConfig({ ...env, PREVIEW_ACCESS_PASSWORD: '' }), /PREVIEW_ACCESS_PASSWORD/);
  assert.equal(readConfig({ ...env, APP_ORIGIN: 'https://re-golf.example/' }).origin, 'https://re-golf.example');
  assert.throws(() => readConfig({ ...env, SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' }), /requires SUPABASE/);
  assert.throws(() => readConfig({ ...env, RENDER_EXTERNAL_URL: '' }), /public HTTPS/);
  for (const origin of ['http://localhost:3000', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?key=value']) {
    assert.throws(() => readConfig({ ...env, APP_ORIGIN: origin }));
  }
  assert.throws(() => readConfig({ ...env, TRUST_PROXY_HOPS: 'true' }), /TRUST_PROXY_HOPS/);
  assert.equal(readConfig({}).host, '127.0.0.1');
  assert.equal(readConfig({}).trustProxyHops, 0);
});
test('proxy-aware API keeps separate client rate-limit buckets', async () => {
  const config = { ...readConfig({}), trustProxyHops: 1 };
  const server = createApp(config).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Forged leftmost IPs must not bypass the closest trusted hop's client address.
    for (let n = 0; n < 120; n++) {
      const response = await fetch(`${url}/api/config`, { headers: { 'X-Forwarded-For': `198.51.100.${n}, 203.0.113.1` } });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal((await fetch(`${url}/api/config`, { headers: { 'X-Forwarded-For': '198.51.100.250, 203.0.113.1' } })).status, 429);
    assert.equal((await fetch(`${url}/api/config`, { headers: { 'X-Forwarded-For': '203.0.113.2' } })).status, 200);
    assert.equal((await fetch(`${url}/api/health`, { headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('server validation rejects forged fields and unsafe price values', () => {
  const valid = { name: 'Driver', brand: 'Ping', category: 'Drivers', condition: 'Good', price_pence: 12345, location: 'Leeds' };
  assert.equal(listingInput.parse(valid).price_pence, 12345);
  for (const change of [{ seller_id: 'other-user' }, { status: 'sold' }, { price_pence: 12.5 }, { price_pence: -100 }, { price_pence: '100' }, { name: ' ' }, { description: 'x'.repeat(2001) }, { category: 'Cars' }]) {
    assert.equal(listingInput.safeParse({ ...valid, ...change }).success, false);
  }
});
test('unconfigured app is honest and rejects writes', async () => {
  const server = createApp(readConfig({})).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${url}/api/config`);
    assert.equal((await response.json()).configured, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${url}/api/listings`)).status, 503);
    assert.equal((await fetch(`${url}/api/listings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('HTTP authentication and validation stop unauthorized writes before the database', async t => {
  let databaseCalls = 0;
  const config = readConfig({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' });
  const app = createApp(config, () => ({
    auth: { getUser: async (token: string) => ({
      data: { user: token === 'invalid' ? null : { id: '11111111-1111-4111-8111-111111111111', email_confirmed_at: token === 'unconfirmed' ? null : '2026-01-01' } },
      error: token === 'invalid' ? new Error('Invalid JWT') : null,
    }) },
    from: () => { databaseCalls++; throw new Error('No database calls expected'); },
  } as unknown as SupabaseClient));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function post(token = '', body = '{}', path = '/api/listings', origin?: string) {
    return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) }, body });
  }
  try {
    await t.test('anonymous and forged sessions are rejected', async () => {
      assert.equal((await post()).status, 401);
      assert.equal((await post('invalid')).status, 401);
      assert.equal((await post('unconfirmed')).status, 403);
    });
    await t.test('cross-site mutation is rejected', async () => { assert.equal((await post('valid', '{}', '/api/listings', 'https://other.test')).status, 403); });
    await t.test('invalid input and identifiers return readable errors', async () => {
      assert.equal((await post('valid')).status, 400);
      assert.equal((await post('valid', '{')).status, 400);
      assert.equal((await post('valid', '{}', '/api/listings/not-a-uuid/archive')).status, 400);
    });
    assert.equal(databaseCalls, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('search matches every word across name, brand and description, with user text kept literal', () => {
  assert.deepEqual(searchFilters('Ping  driver'), ['name.ilike."%Ping%",brand.ilike."%Ping%",description.ilike."%Ping%"', 'name.ilike."%driver%",brand.ilike."%driver%",description.ilike."%driver%"']);
  assert.deepEqual(searchFilters(''), []);
  // LIKE wildcards, quotes, commas and brackets cannot change the filter.
  assert.deepEqual(searchFilters('50%_off', ['name']), ['name.ilike."%50\\\\%\\\\_off%"']);
  assert.deepEqual(searchFilters('a",status.eq.archived)'), ['name.ilike."%a\\",status.eq.archived)%",brand.ilike."%a\\",status.eq.archived)%",description.ilike."%a\\",status.eq.archived)%"']);
  assert.deepEqual(searchFilters('back\\slash', ['name']), ['name.ilike."%back\\\\\\\\slash%"']);
  assert.equal(searchFilters('one two three four five six seven eight').length, 6);
});
