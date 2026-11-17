import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

// Generates real Supabase links without sending email. Inbox delivery is a separate check.
const config = readConfig(process.env);
assert.equal(process.env.TEST_PROJECT, new URL(config.supabaseUrl).hostname.split('.')[0]);
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.storageSecret, options);
const client = createClient(config.supabaseUrl, config.publishableKey, options);
const app = createApp(config); app.use(express.static(resolve('dist/client')));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const remote = process.env.TEST_BASE_URL;
if (remote) assert.equal(remote, 'https://re-golf-development.onrender.com');
const previewPassword = remote ? dotenv.parse(await readFile('.env.render-preview')).PREVIEW_ACCESS_PASSWORD : '';
if (remote) assert.ok(previewPassword);
const contextOptions = previewPassword ? { httpCredentials: { username: 'preview', password: previewPassword } } : {};
const base = remote || `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const callback = remote || config.origin;
config.origin = base;
let user = ''; let stage = 'generate confirmation';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const check = (r: { error: unknown }) => { if (r.error) throw new Error('Auth operation failed'); };
async function follow(link: string, recovery = false) {
  const response = await fetch(link, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const destination = new URL(response.headers.get('location')!);
  assert.equal(destination.origin, new URL(callback).origin);
  if (recovery) assert.equal(destination.searchParams.get('auth'), 'recovery');
  if (remote) return destination.href;
  // Keep the real callback parameters while isolating the browser from the user's running preview.
  return base + destination.pathname + destination.search + destination.hash;
}
try {
  const email = `auth-link-${randomUUID()}@example.com`; const password = randomUUID() + 'aA1!';
  const created = await admin.auth.admin.generateLink({ type: 'signup', email, password, options: { redirectTo: `${callback}/`, data: { display_name: 'Disposable auth test' } } });
  check(created); user = created.data.user!.id;
  assert.equal(created.data.user!.email_confirmed_at, undefined);
  assert.ok((await client.auth.signInWithPassword({ email, password })).error);
  stage = 'confirmation callback';
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext(contextOptions); const page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.goto(await follow(created.data.properties!.action_link));
  await page.locator('#account-button').filter({ hasText: 'My account' }).waitFor();
  assert.ok((await admin.auth.admin.getUserById(user)).data.user!.email_confirmed_at);
  console.log('PASS: unconfirmed sign-in blocked; real confirmation link confirms account and signs in through browser callback.');
  stage = 'confirmation link replay';
  const replay = new URL(await follow(created.data.properties!.action_link));
  assert.ok(new URLSearchParams(replay.hash.slice(1)).get('error'));
  stage = 'recovery callback and password update';
  await context.close();
  const recovery = await admin.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo: `${callback}/?auth=recovery` } }); check(recovery);
  const recoveryContext = await browser.newContext(contextOptions); const reset = await recoveryContext.newPage(); reset.setDefaultTimeout(30000);
  await reset.goto(await follow(recovery.data.properties!.action_link, true));
  await reset.locator('#auth-title').filter({ hasText: 'Choose a new password' }).waitFor();
  const replacement = randomUUID() + 'bB2!';
  await reset.locator('#auth-password').fill(replacement); await reset.locator('#auth-submit').click();
  await reset.locator('#auth-message').filter({ hasText: 'Your password has been updated' }).waitFor();
  assert.ok((await client.auth.signInWithPassword({ email, password })).error);
  check(await client.auth.signInWithPassword({ email, password: replacement }));
  check(await client.auth.signOut());
  await recoveryContext.close();
  console.log('PASS: recovery callback opens password form; browser updates password; old password rejected and new password accepted.');
  stage = 'reused recovery link and visible errors';
  const reused = await follow(recovery.data.properties!.action_link, true);
  assert.ok(new URLSearchParams(new URL(reused).hash.slice(1)).get('error'));
  const invalidContext = await browser.newContext(contextOptions); const invalidPage = await invalidContext.newPage(); invalidPage.setDefaultTimeout(30000);
  await invalidPage.goto(reused);
  await invalidPage.locator('#auth-dialog').waitFor({ state: 'visible' });
  assert.match(await invalidPage.locator('#auth-message').innerText(), /invalid|expired/i);
  assert.equal(new URL(invalidPage.url()).hash, '');
  console.log('PASS: confirmation/recovery links cannot be reused; invalid/expired-link error is visible and callback fragment cleared.');
  await invalidContext.close();
} catch { console.error(`FAIL: ${stage} (credentials, links and response bodies suppressed)`); process.exitCode = 1; }
finally {
  await browser?.close(); await client.auth.signOut();
  server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  if (user) { const removed = await admin.auth.admin.deleteUser(user); if (removed.error) { console.error('FAIL: test-account cleanup'); process.exitCode = 1; } else console.log('PASS: temporary auth account and profile removed.'); }
}
