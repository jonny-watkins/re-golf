import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';

test('private preview gates content, keeps health available and preserves JWT authorization', async () => {
  const password = 'fixture-preview-access-not-a-real-secret';
  const app = createApp(readConfig({ PREVIEW_ACCESS_PASSWORD: password, APP_ORIGIN: 'https://preview.example.com' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    for (const path of ['/', '/api/config', '/api/listings', '/assets/test.js']) assert.equal((await fetch(base + path)).status, 401);
    const wrong = await fetch(base + '/api/config', { headers: { Authorization: 'Basic '+Buffer.from('preview:wrong').toString('base64') } });
    assert.equal(wrong.status, 401);
    const access = await fetch(base + '/api/config', { headers: { Authorization: 'Basic '+Buffer.from('preview:'+password).toString('base64') } });
    assert.equal(access.status, 200);
    const cookie = access.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    assert.ok(!(await access.text()).includes(password));
    const api = await fetch(base + '/api/config', { headers: { Cookie: cookie.split(';')[0], Authorization: 'Bearer test-jwt' } });
    assert.equal(api.status, 200); assert.equal(api.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await fetch(base + '/api/config', { headers: { Cookie: 're_golf_preview='+'x'.repeat(64) } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(()=>r())); }
});
