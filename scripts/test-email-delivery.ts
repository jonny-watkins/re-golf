import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

// Run only after checking account existence with the Supabase plugin.
// No passwords, tokens, links, response bodies, or browser traces are recorded.
const mode = process.env.EMAIL_TEST_ACTION;
if (!['signup', 'reset'].includes(mode ?? '') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.EMAIL_TEST_ADDRESS ?? '')) {
  throw new Error('Explicit email test address and action required');
}
let browser;
let stage = 'launch';
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  stage = 'load preview';
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  stage = 'open account';
  await page.locator('#account-button').click();
  await page.locator(`[data-auth-mode="${mode}"]`).click();
  stage = 'fill form';
  await page.locator('#auth-email').fill(process.env.EMAIL_TEST_ADDRESS!);
  if (mode === 'signup') {
    await page.locator('[name="display_name"]').fill('Email delivery test');
    await page.locator('#auth-password').fill(randomUUID() + 'aA1!');
  }
  const endpoint = mode === 'signup' ? '/auth/v1/signup' : '/auth/v1/recover';
  stage = 'submit';
  const response = page.waitForResponse(r => r.url().includes(endpoint) && r.request().method() === 'POST');
  console.log('Submission time UTC:', new Date().toISOString());
  await page.locator('#auth-submit').click();
  const result = await response;
  console.log('Action:', mode, 'HTTP status:', result.status());
  if (!result.ok()) {
    const body = await result.json().catch(() => ({}));
    const code = body.error_code ?? body.code;
    console.log('Error code:', typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'suppressed');
    process.exitCode = 1;
  } else {
    console.log('Request accepted; inbox receipt and link outcome require owner verification.');
  }
} catch {
  console.error('Email test failed at ' + stage + '; sensitive diagnostics suppressed.');
  process.exitCode = 1;
} finally {
  await browser?.close();
}
