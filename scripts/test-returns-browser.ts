// Browser click-through of settling a reported problem with a tracked return, on the Render
// preview. The order is set up through the API (payment as in test-orders-live.ts); the return
// itself is done by clicking as the seller and the buyer in headless Edge.
// Stripe TEST keys and disposable accounts only; removes its fixtures.
//   npx tsx scripts/test-returns-browser.ts
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { readConfig } from '../server/config.js';
import { assertDevelopmentOnly } from './dev-guard.js';

const env = dotenv.parse(readFileSync('.env'));
const config = readConfig(env as NodeJS.ProcessEnv);
assertDevelopmentOnly(config);
const base = 'https://re-golf-development.onrender.com';
const previewPassword = dotenv.parse(readFileSync('.env.render-preview')).PREVIEW_ACCESS_PASSWORD;
const cookie = { Cookie: 'relofted_preview=' + createHash('sha256').update(previewPassword).digest('hex') };
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.secretKey, options);
const stripe = new Stripe(config.stripeSecretKey);
const shots = 'artifacts/returns-flow/';
const returnAddress = 'Sam Seller, 1 Fairway Road, Leeds, LS1 1AA';
type User = { id: string; email: string; password: string; token: string };
const users: User[] = [];
let stage = 'fixtures',
  shot = 0,
  payoutRule = false;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const pages: Page[] = [];
const snap = (page: Page, name: string) =>
  page.screenshot({ path: `${shots}${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {});
const step = (name: string) => {
  stage = name;
  console.log('…', name);
};
async function api(user: User, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...cookie, Authorization: 'Bearer ' + user.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as any };
}
const dbOrder = async (id: string) => (await admin.from('orders').select('*').eq('id', id).single()).data!;
async function until(what: string, done: () => Promise<boolean>, seconds = 90) {
  for (let i = 0; i < seconds / 2; i++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Timed out waiting for ' + what);
}
/** Takes a real test-card payment and tells the preview about it the way Stripe would. */
async function pay(order: { id: string; total_pence: number }) {
  const session = await stripe.checkout.sessions.retrieve((await dbOrder(order.id)).checkout_ref);
  const intent = await stripe.paymentIntents.create({
    amount: order.total_pence,
    currency: 'gbp',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    transfer_group: order.id,
    metadata: { order_id: order.id },
  });
  const payload = JSON.stringify({
    id: 'evt_test_' + randomUUID(),
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        ...session,
        status: 'complete',
        payment_status: 'paid',
        payment_intent: intent.id,
        collected_information: {
          shipping_details: {
            name: 'Test Buyer',
            address: {
              line1: '1 Test Fairway',
              line2: null,
              city: 'Leeds',
              state: null,
              postal_code: 'LS1 1AA',
              country: 'GB',
            },
          },
        },
      },
    },
  });
  const response = await fetch(base + '/api/stripe/webhook', {
    method: 'POST',
    headers: {
      ...cookie,
      'Content-Type': 'application/json',
      'Stripe-Signature': stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripeWebhookSecret }),
    },
    body: payload,
  });
  assert.equal(response.status, 200);
  return intent.id;
}
async function signIn(page: Page, user: User) {
  await page.goto(base);
  await page
    .locator('#connection-status')
    .filter({ hasText: 'Payments are in test mode' })
    .waitFor({ timeout: 120_000 });
  await page.locator('#account-button').click();
  await page.locator('#auth-email').fill(user.email);
  await page.locator('#auth-password').fill(user.password);
  await page.locator('#auth-submit').click();
  await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
  await page.locator('#orders-button').click();
}
const refresh = (page: Page, text: RegExp) =>
  until('orders screen: ' + text, async () => {
    await page.locator('#orders-refresh').click();
    await page.waitForTimeout(1500);
    return text.test(await page.locator('#orders-dialog').innerText());
  });

try {
  // Sellers here have no payout account, so the payout rule is off for the run (see test-orders-live.ts).
  payoutRule = !(await admin.rpc('set_require_payouts', { p_required: false })).error;
  for (const name of ['seller', 'buyer']) {
    const email = `returns-browser-${name}-${randomUUID()}@example.com`,
      password = randomUUID() + 'Aa1!';
    const made = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: 'Browser test ' + name },
    });
    assert.ok(!made.error, made.error?.message);
    const login = await createClient(config.supabaseUrl, config.publishableKey, options).auth.signInWithPassword({
      email,
      password,
    });
    users.push({ id: made.data.user!.id, email, password, token: login.data.session!.access_token });
  }
  const [seller, buyer] = users;
  const listed = await api(seller, '/api/listings', {
    name: 'Return test putter ' + randomUUID().slice(0, 6),
    brand: 'Automated',
    category: 'Putters',
    condition: 'Good',
    price_pence: 1000,
    location: 'Test',
  });
  assert.equal(listed.status, 201, JSON.stringify(listed.data));
  const reserved = await api(buyer, '/api/orders', { listing_id: listed.data.listing.id, request_id: randomUUID() });
  assert.equal(reserved.status, 201, JSON.stringify(reserved.data));
  const order = reserved.data.order as { id: string; total_pence: number };
  const intent = await pay(order);
  const posted = await api(seller, `/api/orders/${order.id}/dispatch`, { text: 'Royal Mail AB123456789GB' });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  const reported = await api(buyer, `/api/orders/${order.id}/report_issue`, { text: 'Shaft is cracked' });
  assert.equal(reported.status, 200, JSON.stringify(reported.data));

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const open = async (user: User) => {
    const context = await browser!.newContext({
      httpCredentials: { username: 'preview', password: previewPassword },
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    });
    const page = await context.newPage();
    pages.push(page);
    page.on('dialog', dialog => dialog.accept());
    await signIn(page, user);
    return page;
  };

  step('seller sees the problem and asks for the item back');
  const sellerPage = await open(seller);
  const sale = sellerPage.locator('#orders-sales .order-row');
  await sale.filter({ hasText: 'The buyer reported a problem' }).waitFor();
  assert.match(await sale.innerText(), /Shaft is cracked/);
  await snap(sellerPage, 'seller-problem');
  const askBack = sale.getByRole('button', { name: 'Ask for the item back' });
  await askBack.click(); // reveals the address box
  await askBack.click(); // refused without an address
  await sellerPage.locator('#orders-status').filter({ hasText: 'first' }).waitFor();
  assert.equal((await dbOrder(order.id)).return_by, null, 'no address, no return request');
  await sale.getByPlaceholder('Name and full address to send it back to').fill(returnAddress);
  await askBack.click();
  await sale.filter({ hasText: 'You asked for the item back' }).waitFor();
  await snap(sellerPage, 'seller-asked');
  assert.equal(await askBack.count(), 0);

  step('buyer sees the return address and deadline, and marks it posted with tracking');
  const buyerPage = await open(buyer);
  const purchase = buyerPage.locator('#orders-purchases .order-row');
  await purchase.filter({ hasText: 'The seller has asked for the item back' }).waitFor();
  const asked = await purchase.innerText();
  assert.ok(asked.includes(returnAddress), 'return address shown to the buyer: ' + asked);
  assert.match(asked, /Return postage is paid by you/);
  await snap(buyerPage, 'buyer-asked');
  const postedBack = purchase.getByRole('button', { name: 'I have posted it back' });
  await postedBack.click(); // refused without tracking
  await buyerPage.locator('#orders-status').filter({ hasText: 'first' }).waitFor();
  assert.equal((await dbOrder(order.id)).return_posted_at, null, 'tracking is required');
  await purchase.getByPlaceholder('Carrier and tracking number').fill('Evri H00ABC123456');
  await postedBack.click();
  await purchase.filter({ hasText: 'You have posted the item back' }).waitFor();
  await snap(buyerPage, 'buyer-posted');
  assert.equal(await purchase.getByRole('button', { name: /Withdraw/ }).count(), 0);

  step('seller confirms it is back; the buyer is refunded in full through Stripe');
  await refresh(sellerPage, /The buyer has posted the item back/);
  assert.match(await sale.innerText(), /Evri H00ABC123456/);
  await snap(sellerPage, 'seller-return-posted');
  await sale.getByRole('button', { name: 'Item received back: refund the buyer' }).click();
  await sale.filter({ hasText: /Cancelled\. The buyer (is being|was) refunded/ }).waitFor();
  await snap(sellerPage, 'seller-refunded');
  await until('the Stripe refund', async () => (await dbOrder(order.id)).funds === 'refunded', 180);
  const after = await dbOrder(order.id);
  assert.deepEqual([after.status, after.return_address], ['cancelled', null]);
  assert.deepEqual(
    (await stripe.refunds.list({ payment_intent: intent })).data.map(refund => refund.amount),
    [order.total_pence],
  );
  await refresh(buyerPage, /Cancelled and refunded in full/);
  await snap(buyerPage, 'buyer-refunded');
  console.log(`\nReturn flow passed in the browser. Screenshots: ${shots}`);
} catch (error) {
  for (const page of pages) await snap(page, 'failure');
  console.log(
    '\nFAILED at:',
    stage,
    '\n ',
    error instanceof Error ? error.message.split('\n').slice(0, 8).join('\n  ') : error,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (payoutRule) await admin.rpc('set_require_payouts', { p_required: true });
  const ids = users.map(user => user.id);
  if (ids.length) {
    const orders = (await admin.from('orders').select('id,payment_ref,funds').in('seller_id', ids)).data || [];
    for (const order of orders)
      if (order.payment_ref && ['held', 'release_due', 'refund_due'].includes(order.funds)) {
        try {
          await stripe.refunds.create({ payment_intent: order.payment_ref });
        } catch {
          /* already refunded */
        }
      }
    const orderIds = orders.map(order => order.id);
    if (orderIds.length) {
      for (const table of ['order_events', 'payment_events', 'order_addresses'])
        await admin.from(table).delete().in('order_id', orderIds);
      await admin.from('orders').delete().in('id', orderIds);
    }
    await admin.from('email_outbox').delete().in('user_id', ids);
    await admin.from('listings').delete().in('seller_id', ids);
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    console.log(`Cleanup: removed ${orderIds.length} order(s), the test listing and ${ids.length} test accounts.`);
  }
}
