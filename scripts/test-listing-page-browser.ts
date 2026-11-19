// Browser check of a listing's own page: the shared link opens the listing, the link preview
// tags are in the page, Back and Forward work, a missing listing is explained, and an item whose
// seller cannot yet be paid is shown as not buyable. Development database only; removes its fixtures.
//   npx tsx scripts/test-listing-page-browser.ts                              (the Render preview)
//   CHECK_BASE=http://localhost:3000 npx tsx scripts/test-listing-page-browser.ts   (a local `npm start`)
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../server/config.js';
import { assertDevelopmentOnly } from './dev-guard.js';

const config = readConfig(dotenv.parse(readFileSync('.env')) as NodeJS.ProcessEnv);
assertDevelopmentOnly(config);
const preview = 'https://re-golf-development.onrender.com';
const base = (process.env.CHECK_BASE || preview).replace(/\/$/, '');
const previewCookie =
  base === preview
    ? createHash('sha256')
        .update(dotenv.parse(readFileSync('.env.render-preview')).PREVIEW_ACCESS_PASSWORD)
        .digest('hex')
    : '';
const headers: Record<string, string> = previewCookie ? { Cookie: 'relofted_preview=' + previewCookie } : {};
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.secretKey, options);
const shots = 'artifacts/listing-page/';
let stage = 'fixtures',
  shot = 0,
  sellerId = '';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
const snap = (name: string) =>
  page?.screenshot({ path: `${shots}${String(++shot).padStart(2, '0')}-${name}.png` }).catch(() => {});
const step = (name: string) => {
  stage = name;
  console.log('…', name);
};
const path = () => new URL(page!.url()).pathname;

try {
  const email = `listing-page-${randomUUID()}@example.com`,
    password = randomUUID() + 'Aa1!';
  const made = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'Listing page test' },
  });
  assert.ok(!made.error, made.error?.message);
  sellerId = made.data.user!.id;
  const login = await createClient(config.supabaseUrl, config.publishableKey, options).auth.signInWithPassword({
    email,
    password,
  });
  const name = 'Link test putter ' + randomUUID().slice(0, 6);
  const listed = await fetch(base + '/api/listings', {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: 'Bearer ' + login.data.session!.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      brand: 'Automated',
      category: 'Putters',
      condition: 'Good',
      price_pence: 4500,
      location: 'Leeds',
      description: 'A "quoted" <b>description</b> that costs $1 & more.',
    }),
  });
  assert.equal(listed.status, 201, await listed.clone().text());
  const id = ((await listed.json()) as { listing: { id: string } }).listing.id;
  const address = `/listing/${id}`;

  step('the page a messaging app or search engine reads carries the listing title, price and preview tags');
  const raw = await fetch(base + address, { headers });
  const html = await raw.text();
  assert.equal(raw.status, 200);
  assert.ok(html.includes(`<title>Automated ${name} — £45 | Relofted</title>`), html.slice(0, 900));
  assert.ok(html.includes(`<meta property="og:url" content="${base}${address}">`), 'og:url');
  assert.ok(html.includes('<meta property="og:image" content="'), 'og:image');
  assert.ok(html.includes('&quot;quoted&quot; &lt;b&gt;description&lt;/b&gt; that costs $1 &amp; more.'), 'escaped');
  // The preview is hidden from search engines as a whole; anywhere else a live listing may be indexed.
  if (!previewCookie) assert.ok(!/noindex/.test(raw.headers.get('x-robots-tag') || ''), 'listing is indexable');

  step('the sitemap lists it; a missing listing still serves the app, marked not to be indexed');
  const sitemap = await (await fetch(base + '/sitemap.xml', { headers })).text();
  assert.ok(sitemap.includes(`<loc>${base}${address}</loc>`), sitemap.slice(0, 600));
  assert.match(await (await fetch(base + '/robots.txt', { headers })).text(), /Sitemap: .*\/sitemap\.xml/);
  const missing = await fetch(`${base}/listing/${randomUUID()}`, { headers });
  assert.deepEqual([missing.status, /noindex/.test(missing.headers.get('x-robots-tag') || '')], [200, true]);
  assert.match(await missing.text(), /<title>Relofted — /);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (previewCookie)
    await context.addCookies([{ name: 'relofted_preview', value: previewCookie, url: base, httpOnly: true }]);
  page = await context.newPage();
  const dialog = page.locator('#listing-dialog');

  step('a visitor who is not signed in opens the shared link and sees the listing');
  await page.goto(base + address);
  await dialog.locator('#listing-dialog-title').filter({ hasText: name }).waitFor({ timeout: 120_000 });
  assert.equal(await page.title(), `Automated ${name} | Relofted`);
  assert.equal(await page.locator('#share-listing').isVisible(), true);

  step('an item whose seller cannot yet be paid says so instead of offering Buy now');
  const buy = page.locator('#checkout-button');
  await buy.filter({ hasText: 'Not available to buy yet' }).waitFor();
  assert.equal(await buy.isDisabled(), true);
  assert.match(await page.locator('#estimate-note').innerText(), /seller has not finished setting up payments/);
  await snap('shared-link');

  step('closing returns to the marketplace address; opening from the list gives the listing address');
  await dialog.locator('[data-close-dialog]').first().click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(path(), '/');
  assert.match(await page.title(), /^Relofted — /);
  await page.locator('#search-input').fill(name);
  const card = page.locator('.listing').filter({ hasText: name });
  await card.locator('[data-listing]').click();
  await dialog.locator('#listing-dialog-title').filter({ hasText: name }).waitFor();
  assert.equal(path(), address);
  await buy.filter({ hasText: 'Not available to buy yet' }).waitFor();

  step('Back closes the listing and Forward reopens it');
  await page.goBack();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(path(), '/');
  await page.goForward();
  await dialog.locator('#listing-dialog-title').filter({ hasText: name }).waitFor();
  assert.equal(path(), address);
  await dialog.locator('[data-close-dialog]').first().click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => location.pathname === '/');

  step('a link to a listing that has gone explains itself');
  await admin.from('listings').update({ status: 'archived' }).eq('id', id);
  await page.goto(base + address);
  await page.locator('#market-message').filter({ hasText: 'no longer available' }).waitFor({ timeout: 60_000 });
  assert.equal(path(), '/');
  assert.equal(await dialog.isVisible(), false);
  await snap('gone');

  console.log(`\nListing page passed in the browser at ${base}. Screenshots: ${shots}`);
} catch (error) {
  await snap('failure');
  console.log(
    '\nFAILED at:',
    stage,
    '\n ',
    error instanceof Error ? error.message.split('\n').slice(0, 8).join('\n  ') : error,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (sellerId) {
    await admin.from('listings').delete().eq('seller_id', sellerId);
    await admin.auth.admin.deleteUser(sellerId);
    console.log('Cleanup: removed the test listing and account.');
  }
}
