import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), APP_ORIGIN: origin,
    RENDER: '', SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_STORAGE_SECRET: '', PREVIEW_ACCESS_PASSWORD: '', TRUST_PROXY_HOPS: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const exited = once(child, 'exit');
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      ready = response.ok;
    } catch { /* Wait for the server to bind. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Server did not start: ${output}`);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
  const html = await page.text();
  assert.match(html, /Re-Golf/);
  const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/);
  assert.ok(asset, 'Built JavaScript asset must be referenced');
  assert.equal((await fetch(origin + asset[1])).status, 200);
  const recovery = await fetch(`${origin}/?auth=recovery`);
  assert.equal(recovery.status, 200);
  const config = await fetch(`${origin}/api/config`);
  assert.equal((await config.json()).configured, false);
  assert.equal((await fetch(`${origin}/api/listings`)).status, 503);
  assert.equal((await fetch(`${origin}/.env`)).status, 404);
  assert.equal((await fetch(`${origin}/server/config.ts`)).status, 404);
  console.log('Production smoke check passed: page, assets, auth callback, API, headers, and private file isolation.');
} finally {
  child.kill('SIGTERM');
  await exited;
}
