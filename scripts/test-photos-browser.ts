import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

const config = readConfig(process.env);
assert.equal(process.env.PHOTO_TEST_PROJECT, new URL(config.supabaseUrl).hostname.split('.')[0]);
const admin = createClient(config.supabaseUrl, config.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = createApp(config);
// Run npm run build first; static assets avoid sharing the dev server's HMR port.
app.use(express.static(resolve('dist/client')));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.origin = origin;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let user = '';
let stage = 'browser launch';
const check = (r: { error: unknown }) => {
  if (r.error) throw new Error('Hosted operation failed');
};
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors: string[] = [];
  page.on('pageerror', error =>
    errors.push(error.message.replace(/https?:\/\/\S+/g, '[URL]').replace(/sb_[A-Za-z0-9_-]+/g, '[KEY]')),
  );
  stage = 'temporary account';
  const email = `photo-browser-${randomUUID()}@example.com`;
  const password = randomUUID() + 'aA1!';
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'Photo browser test' },
  });
  check(created);
  user = created.data.user!.id;
  await page.goto(origin);
  await page.locator('#connection-status').filter({ hasText: 'Photos are enabled' }).waitFor();
  stage = 'UI sign-in';
  await page.locator('#account-button').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
  stage = 'listing form and photo previews';
  await page.locator('[data-open-sell]').first().click();
  for (const [id, value] of Object.entries({
    'club-brand': 'Test',
    'club-name': 'Disposable photo browser test',
    'club-price': '100',
    'club-location': 'Leeds',
    'club-loft': '10.5',
  }))
    await page.locator(`#${id}`).fill(value);
  await page.locator('#club-handedness').selectOption('Left');
  await page.locator('#club-shaft-flex').selectOption('Stiff');
  const file = async (color: string) => ({
    name: `${color}.jpg`,
    mimeType: 'image/jpeg',
    buffer: await sharp({ create: { width: 900, height: 600, channels: 3, background: color } })
      .jpeg()
      .toBuffer(),
  });
  await page.locator('#club-photos').setInputFiles([await file('green'), await file('blue')]);
  assert.equal(await page.locator('#photo-editor .photo-tile').count(), 2);
  await mkdir('artifacts/photo-flow', { recursive: true });
  await page.locator('#photo-editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/photo-flow/desktop-editor.png' });
  stage = 'save and reload';
  await page.locator('#sell-form button[type=submit]').click();
  await page.locator('#sell-dialog').waitFor({ state: 'hidden' });
  await page.reload();
  await page.locator('#my-listings').click();
  const card = page.locator('.listing').filter({ hasText: 'Disposable photo browser test' });
  await card.locator('[data-listing]').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#photo-gallery button').length === 2 &&
      [...document.querySelectorAll<HTMLImageElement>('#photo-gallery img, #dialog-visual img')].every(
        i => i.complete && i.naturalWidth > 0,
      ),
  );
  const first = await page.locator('#dialog-visual img').getAttribute('data-photo');
  await page.getByRole('button', { name: 'Show photo 2', exact: true }).click();
  const second = await page.locator('#dialog-visual img').getAttribute('data-photo');
  assert.notEqual(first, second);
  assert.match(await page.locator('#dialog-specs').innerText(), /10.5/);
  stage = 'change main and remove';
  await page.locator('#edit-listing').click();
  await page.getByRole('button', { name: 'Make main photo 2', exact: true }).click();
  await page.waitForFunction(
    id => document.querySelector('#photo-editor img')?.getAttribute('data-photo') === id,
    second,
  );
  await page.getByRole('button', { name: 'Remove photo 2', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#photo-editor .photo-tile').length === 1);
  await page.locator('#club-photos').setInputFiles(await file('red'));
  await page.locator('#sell-form button[type=submit]').click();
  await page.locator('#sell-dialog').waitFor({ state: 'hidden' });
  stage = 'persisted replacement and mobile layout';
  await page.reload();
  await page.locator('#my-listings').click();
  await card.locator('[data-listing]').click();
  await page.waitForFunction(() => document.querySelectorAll('#photo-gallery button').length === 2);
  assert.equal(await page.locator('#dialog-visual img').getAttribute('data-photo'), second);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>('#photo-gallery img, #dialog-visual img')].every(
      i => i.complete && i.naturalWidth > 0,
    ),
  );
  await page.screenshot({ path: 'artifacts/photo-flow/mobile-gallery.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#edit-listing').click();
  await page.locator('#club-photos').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/photo-flow/mobile-editor.png' });
  stage = 'mobile dialog overflow';
  assert.ok(await page.locator('#sell-dialog').evaluate(e => e.scrollWidth <= e.clientWidth));
  stage = 'browser JavaScript errors';
  if (errors.length) console.log('Browser errors:', errors.join('; '));
  assert.equal(errors.length, 0);
  console.log(
    'PASS: browser sign-in, two-photo preview/upload, refresh persistence, gallery selection, golf details, main change, removal/replacement, mobile layout, no JavaScript errors.',
  );
} catch {
  console.error(`FAIL: ${stage} (private details suppressed)`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  if (user)
    try {
      const rows = await admin.from('listings').select('id').eq('seller_id', user);
      check(rows);
      for (const row of rows.data || []) {
        check(await admin.from('listings').delete().eq('id', row.id));
        const objects = await admin.storage.from('listing-photos').list(row.id);
        check(objects);
        if (objects.data?.length)
          check(await admin.storage.from('listing-photos').remove(objects.data.map(o => `${row.id}/${o.name}`)));
        check(await admin.from('photo_cleanup').delete().like('path', `${row.id}/%`));
      }
      check(await admin.auth.admin.deleteUser(user));
      console.log('PASS: all disposable browser test data removed.');
    } catch {
      console.error('FAIL: test data cleanup needs investigation');
      process.exitCode = 1;
    }
}
