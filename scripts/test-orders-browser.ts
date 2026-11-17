// Browser acceptance for a real purchase on the Render preview: the buyer pays on Stripe's
// hosted test-mode page, so the payment confirmation is a genuine Stripe webhook.
// Uses headless Edge, Stripe TEST keys and disposable accounts; removes its fixtures.
//   npx tsx scripts/test-orders-browser.ts
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../server/config.js';

const env = dotenv.parse(readFileSync('.env'));
const config = readConfig(env as NodeJS.ProcessEnv);
assert.ok(config.stripeSecretKey.startsWith('sk_test_'), 'Stripe test keys only');
const base = 'https://re-golf-development.onrender.com';
const previewPassword = dotenv.parse(readFileSync('.env.render-preview')).PREVIEW_ACCESS_PASSWORD;
const cookie = { Cookie: 're_golf_preview=' + createHash('sha256').update(previewPassword).digest('hex') };
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.storageSecret, options);
const stripe = new Stripe(config.stripeSecretKey);
const stopAfter = process.env.STOP_AFTER || '';
const shots = 'artifacts/orders-flow/';
type User = { id: string; email: string; password: string; token: string };
const users: User[] = [];
let listing = '', stage = 'fixtures', shot = 0;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const pages: Page[] = [];
const snap = async (page: Page, name: string) => { await page.screenshot({ path: `${shots}${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {}); };
const step = (name: string) => { stage = name; console.log('…', name); };
async function api(user: User, path: string, body?: unknown) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...cookie, Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
const dbOrder = async () => (await admin.from('orders').select('*').eq('listing_id', listing).order('created_at', { ascending: false }).limit(1).maybeSingle()).data;
async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, seconds = 60) {
  for (let i = 0; i < seconds; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error('Timed out waiting for ' + what);
}
async function describeControls(page: Page) {
  const found = await page.locator('input,select,button,a[role=button]').evaluateAll(nodes => nodes.map(n => ({ tag: n.tagName, id: n.id, name: (n as HTMLInputElement).name, type: (n as HTMLInputElement).type,
    text: (n.textContent || '').trim().slice(0, 40), label: n.getAttribute('aria-label'), testid: n.getAttribute('data-testid'), visible: !!(n as HTMLElement).offsetParent }))
    .filter(n => n.visible && (n.id || n.testid || n.text || n.label)));
  console.log(found.map(n => `${n.tag}#${n.id}[${n.name || ''}|${n.type || ''}|${n.testid || ''}] "${n.text || n.label || ''}"`).join('\n'));
}
async function signIn(page: Page, user: User) {
  await page.goto(base);
  await page.locator('#connection-status').filter({ hasText: 'Payments are in test mode' }).waitFor({ timeout: 120_000 });
  await page.locator('#account-button').click();
  await page.locator('#auth-email').fill(user.email); await page.locator('#auth-password').fill(user.password); await page.locator('#auth-submit').click();
  await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
}
const refreshOrders = async (page: Page, text: RegExp) => until('orders screen: ' + text, async () => {
  await page.locator('#orders-refresh').click(); await page.waitForTimeout(1500);
  return text.test(await page.locator('#orders-dialog').innerText());
}, 40);

try {
  for (const name of ['seller', 'buyer']) {
    const email = `orders-browser-${name}-${randomUUID()}@example.com`, password = randomUUID() + 'Aa1!';
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Browser test ' + name } });
    assert.ok(!made.error, made.error?.message);
    const login = await createClient(config.supabaseUrl, config.publishableKey, options).auth.signInWithPassword({ email, password });
    users.push({ id: made.data.user!.id, email, password, token: login.data.session!.access_token });
  }
  const [seller, buyer] = users;
  const title = 'Browser test putter ' + randomUUID().slice(0, 6);
  const made = await api(seller, '/api/listings', { name: title, brand: 'Automated', category: 'Putters', condition: 'Good', price_pence: 500, location: 'Test' });
  assert.equal(made.status, 201); listing = made.data.listing.id;

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = () => browser!.newContext({ httpCredentials: { username: 'preview', password: previewPassword }, viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
  const buyerPage = await (await context()).newPage(); pages.push(buyerPage);

  step('buyer signs in, sees the full price, and is sent to Stripe');
  await signIn(buyerPage, buyer);
  await buyerPage.locator('#search-input').fill(title);
  const card = buyerPage.locator('.listing').filter({ hasText: title });
  await card.locator('[data-listing]').click();
  await buyerPage.locator('#checkout-button').filter({ hasText: 'Buy now' }).click();
  await buyerPage.locator('#checkout-button').filter({ hasText: 'Pay £11.90 securely' }).waitFor();
  assert.match(await buyerPage.locator('#price-breakdown').innerText(), /Club price: £5\.00[\s\S]*Buyer protection fee: £0\.95[\s\S]*Tracked delivery: £5\.95[\s\S]*Total to pay: £11\.90/);
  await snap(buyerPage, 'price-breakdown');
  await buyerPage.locator('#checkout-button').click();
  await buyerPage.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await buyerPage.getByText('Tracked delivery').first().waitFor({ timeout: 60_000 });
  await buyerPage.waitForTimeout(5000);
  await snap(buyerPage, 'stripe-checkout');
  if (stopAfter === 'checkout-page') {
    await describeControls(buyerPage);
    await buyerPage.getByText('Card', { exact: true }).first().click({ timeout: 5000 }).catch(() => console.log('(no Card choice to click)')); await buyerPage.waitForTimeout(2000);
    await buyerPage.getByPlaceholder('Address', { exact: true }).fill('1 Test', { timeout: 5000 }).catch(() => console.log('(no Address placeholder)')); await buyerPage.waitForTimeout(3000);
    console.log('--- after choosing card and typing an address'); await describeControls(buyerPage); await snap(buyerPage, 'stripe-card');
    throw new Error('stopped after checkout-page');
  }
  // __REST__
} catch (error) {
  for (const page of pages) await snap(page, 'failure');
  console.log('FAILED at:', stage, '\n ', error instanceof Error ? error.message.split('\n').slice(0, 8).join('\n  ') : error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  const ids = users.map(user => user.id);
  if (ids.length) {
    const orders = (await admin.from('orders').select('id,payment_ref,funds').in('seller_id', ids)).data || [];
    for (const order of orders) if (order.payment_ref && ['held', 'release_due', 'refund_due'].includes(order.funds)) {
      try { await stripe.refunds.create({ payment_intent: order.payment_ref }); } catch { /* already refunded */ }
    }
    const orderIds = orders.map(order => order.id);
    if (orderIds.length) {
      for (const table of ['order_events', 'payment_events', 'order_addresses']) await admin.from(table).delete().in('order_id', orderIds);
      await admin.from('orders').delete().in('id', orderIds);
    }
    const accounts = (await admin.from('seller_accounts').select('provider_account').in('seller_id', ids)).data || [];
    for (const account of accounts) { try { await stripe.v2.core.accounts.close(account.provider_account, { applied_configurations: ['recipient'] }); } catch { /* left in sandbox */ } }
    await admin.from('seller_accounts').delete().in('seller_id', ids);
    if (listing) await admin.from('listings').delete().eq('id', listing);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log(`Cleanup: removed ${orderIds.length} order(s), the test listing and ${ids.length} test accounts.`);
  }
}
