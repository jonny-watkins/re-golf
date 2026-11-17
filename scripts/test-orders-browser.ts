// Browser acceptance for a real purchase on the Render preview: the buyer pays on Stripe's
// hosted test-mode page, so the payment confirmation is a genuine Stripe webhook.
// Uses headless Edge, Stripe TEST keys and disposable accounts; removes its fixtures.
//   npx tsx scripts/test-orders-browser.ts
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, type Frame, type Locator, type Page } from 'playwright';
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
/** Stripe renders its forms inside frames; find a visible control in any of them. */
async function inFrames(page: Page, find: (root: Frame) => Locator, seconds = 30): Promise<Locator> {
  for (let i = 0; i < seconds * 2; i++) {
    for (const frame of page.frames()) {
      const found = find(frame).first();
      if (await found.isVisible().catch(() => false)) return found;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Control not found in any frame');
}
async function describeFrames(page: Page) {
  for (const frame of page.frames()) {
    const found = await frame.locator('input,select,button,a').evaluateAll(nodes => nodes.map(n => ({ tag: n.tagName, id: n.id, name: (n as HTMLInputElement).name, ph: (n as HTMLInputElement).placeholder,
      text: (n.textContent || '').trim().slice(0, 40), label: n.getAttribute('aria-label'), w: (n as HTMLElement).getBoundingClientRect().width })).filter(n => n.w > 0)).catch(() => []);
    if (found.length) console.log('FRAME', frame.url().slice(0, 70), '\n' + found.map(n => `  ${n.tag}#${n.id}[${n.name || ''}] ph="${n.ph || ''}" "${n.text || n.label || ''}"`).join('\n'));
  }
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
  if (stopAfter === 'checkout-page') { await describeFrames(buyerPage); throw new Error('stopped after checkout-page'); }

  step('buyer pays on Stripe with the test card');
  const type = async (find: (root: Frame) => Locator, value: string) => { const control = await inFrames(buyerPage, find); await control.click(); await control.pressSequentially(value, { delay: 30 }); };
  await type(root => root.getByPlaceholder('Full name'), 'Test Buyer');
  await type(root => root.getByPlaceholder('Address', { exact: true }), '10 Downing Street');
  await buyerPage.waitForTimeout(2500);
  await snap(buyerPage, 'stripe-address');
  if (stopAfter === 'address') { await describeFrames(buyerPage); throw new Error('stopped after address'); }
  // Skip Stripe's address suggestions and enter the rest by hand.
  const manual = await inFrames(buyerPage, root => root.getByRole('button', { name: 'Enter address manually' }), 3).catch(() => null);
  if (manual) await manual.click(); else await buyerPage.keyboard.press('Escape');
  await type(root => root.locator('#shippingAddress-localityInput'), 'London');
  await type(root => root.locator('#shippingAddress-postalCodeInput'), 'SW1A 2AA');
  await type(root => root.getByPlaceholder('Card number'), '4242424242424242');
  await type(root => root.getByPlaceholder('MM / YY'), '1234');
  await type(root => root.getByPlaceholder('Security code'), '123');
  await snap(buyerPage, 'stripe-filled');
  await (await inFrames(buyerPage, root => root.getByRole('button', { name: 'Pay', exact: true }))).click();
  await buyerPage.waitForURL(url => url.origin === base, { timeout: 90_000 });

  step('genuine Stripe webhook marks the order paid and funds held');
  await buyerPage.locator('#orders-dialog[open]').waitFor({ timeout: 30_000 });
  await refreshOrders(buyerPage, /Paid. Re-Golf is holding your payment/);
  await snap(buyerPage, 'buyer-paid');
  let order = (await dbOrder())!;
  assert.deepEqual([order.status, order.funds], ['paid', 'held']);
  assert.match(order.payment_ref, /^pi_/);
  const events = (await admin.from('payment_events').select('event_id,action').eq('order_id', order.id)).data!;
  assert.ok(events.some(event => event.action === 'payment_succeeded' && /^evt_(?!test_)/.test(event.event_id)), 'payment confirmed by a real Stripe event: ' + JSON.stringify(events));
  const address = (await admin.from('order_addresses').select('*').eq('order_id', order.id).maybeSingle()).data;
  assert.ok(address?.postcode && address.line1 && address.name === 'Test Buyer', 'delivery address saved from Stripe: ' + JSON.stringify(address));
  const intent = await stripe.paymentIntents.retrieve(order.payment_ref);
  assert.deepEqual([intent.status, intent.amount_received, intent.transfer_group], ['succeeded', 1190, order.id]);
  console.log('   paid via', events.map(event => event.event_id.slice(0, 8) + '…').join(', '), '| address', address.line1, address.city, address.postcode);
  if (stopAfter === 'paid') throw new Error('stopped after paid');

  step('seller sees the address and must give tracking to mark the order posted');
  const sellerPage = await (await context()).newPage(); pages.push(sellerPage);
  await signIn(sellerPage, seller);
  await sellerPage.locator('#orders-button').click();
  const sale = sellerPage.locator('#orders-sales .order-row');
  await sale.filter({ hasText: 'Post to: Test Buyer, 10 Downing Street, London, SW1A 2AA' }).waitFor();
  assert.match(await sale.innerText(), /You receive £10\.95/);
  await sale.getByRole('button', { name: 'Mark as posted' }).click();
  await sellerPage.locator('#orders-status').filter({ hasText: 'Tracked postage is required' }).waitFor();
  assert.equal((await dbOrder())!.status, 'paid');
  await sale.getByPlaceholder('Carrier and tracking number').fill('Royal Mail AB123456789GB');
  await sale.getByRole('button', { name: 'Mark as posted' }).click();
  await sale.filter({ hasText: 'Posted. You are paid after the buyer receives the item' }).waitFor();
  await snap(sellerPage, 'seller-posted');

  step('buyer confirms delivery (hold starts), then releases the payment early');
  await refreshOrders(buyerPage, /Tracking: Royal Mail AB123456789GB/);
  const purchase = buyerPage.locator('#orders-purchases .order-row');
  await purchase.getByRole('button', { name: 'I have received it' }).click();
  await purchase.filter({ hasText: 'the seller is paid on' }).waitFor();
  order = (await dbOrder())!;
  assert.deepEqual([order.status, order.funds], ['delivered', 'held']);
  assert.ok(Math.abs((Date.parse(order.release_at) - Date.now()) / 3_600_000 - 48) < 0.1, 'hold is 48 hours');
  await snap(buyerPage, 'buyer-hold');
  await purchase.getByRole('button', { name: 'All good — pay the seller now' }).click();
  await purchase.filter({ hasText: 'Complete. Thank you for buying on Re-Golf.' }).waitFor();
  order = (await dbOrder())!;
  assert.deepEqual([order.status, order.funds], ['completed', 'release_due']);

  step('seller starts payout setup on Stripe');
  await refreshOrders(sellerPage, /Set up payouts above to receive your payment/);
  await snap(sellerPage, 'seller-awaiting-payouts');
  await sellerPage.locator('#orders-payouts').getByRole('button', { name: 'Set up payouts' }).click();
  await sellerPage.waitForURL(/connect\.stripe\.com/, { timeout: 60_000 });
  await sellerPage.waitForTimeout(6000);
  await snap(sellerPage, 'stripe-onboarding');
  if (stopAfter === 'onboarding') { await describeFrames(sellerPage); throw new Error('stopped after onboarding'); }
  assert.match(await sellerPage.locator('h1').first().innerText(), /get started/i);
  // Stripe's hosted form is protected by a CAPTCHA, so a script stops here by design.
  // To prove the payout itself, swap in a test seller account whose details are supplied
  // through Stripe's API (test mode only). The app has not been told this account is ready.
  step('seller account becomes ready at Stripe');
  const onboarding = (await admin.from('seller_accounts').select('provider_account,payouts_enabled').eq('seller_id', seller.id).single()).data!;
  assert.equal(onboarding.payouts_enabled, false);
  const ready = await stripe.v2.core.accounts.create({
    contact_email: seller.email, display_name: 'Browser test seller', dashboard: 'none',
    identity: { country: 'gb', entity_type: 'individual',
      individual: { given_name: 'Test', surname: 'Seller', email: seller.email, phone: '+447400123456', date_of_birth: { day: 1, month: 1, year: 1901 },
        address: { line1: 'address_full_match', city: 'London', postal_code: 'SW1A 2AA', country: 'gb' } },
      attestations: { terms_of_service: { account: { date: new Date().toISOString(), ip: '8.8.8.8' } } } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    defaults: { currency: 'gbp', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
    metadata: { seller_id: seller.id },
  });
  await stripe.v2.core.accounts.close(onboarding.provider_account, { applied_configurations: ['recipient'] }).catch(() => {});
  await admin.from('seller_accounts').update({ provider_account: ready.id }).eq('seller_id', seller.id);
  // A change on the account makes Stripe send account.updated to the "Connected accounts" webhook.
  await stripe.v2.core.accounts.update(ready.id, { metadata: { seller_id: seller.id, nudge: '1' } });
  const viaWebhook = await until('payout status webhook', async () => (await admin.from('seller_accounts').select('payouts_enabled').eq('seller_id', seller.id).single()).data!.payouts_enabled, 45).catch(() => false);
  console.log('   payout status learned from', viaWebhook ? 'Stripe\'s connected-account webhook' : 'the settlement re-check (webhook not seen within 45s)');

  step('the preview server pays the seller on its own (settlement runs every five minutes)');
  order = await until('seller transfer', async () => { const found = await dbOrder(); return found?.funds === 'released' ? found : null; }, 400);
  const transfer = await stripe.transfers.retrieve(order.transfer_ref);
  const charge = (await stripe.paymentIntents.retrieve(order.payment_ref)).latest_charge;
  assert.deepEqual([transfer.amount, transfer.currency, transfer.destination, transfer.transfer_group, transfer.source_transaction], [1095, 'gbp', ready.id, order.id, charge]);
  console.log('   Stripe transfer', transfer.id.slice(0, 8) + '…', '£' + (transfer.amount / 100).toFixed(2), 'to the seller; platform keeps the £0.95 fee');
  await refreshOrders(sellerPage.url().startsWith(base) ? sellerPage : (await sellerPage.goto(base), await sellerPage.locator('#orders-button').click(), sellerPage), /Your payment has been sent to your payout account/);
  assert.match(await sellerPage.locator('#orders-payouts').innerText(), /Payouts are set up/);
  await snap(sellerPage, 'seller-paid');
  const history = (await admin.from('order_events').select('action').eq('order_id', order.id).order('id')).data!.map(event => event.action);
  assert.deepEqual(history, ['reserve', 'payment_succeeded', 'dispatch', 'confirm_delivery', 'accept', 'released']);
  console.log('\nBrowser purchase passed: paid on Stripe, held, posted with tracking, delivered, released, transferred to the seller.');
  // Leave the sandbox tidy: take the test transfer back before the fixtures are removed.
  await stripe.transfers.createReversal(transfer.id).catch(() => {});
  await stripe.refunds.create({ payment_intent: order.payment_ref }).catch(() => {});
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
