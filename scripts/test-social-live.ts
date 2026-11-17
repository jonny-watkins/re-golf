import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import express from 'express';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';

const config = readConfig(process.env);
assert.equal(process.env.TEST_PROJECT, new URL(config.supabaseUrl).hostname.split('.')[0]);
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(config.supabaseUrl, config.storageSecret, options);
const users: { id: string; email: string; password: string; token: string; client: ReturnType<typeof createClient> }[] = [];
const listingIds: string[] = [], threadIds: string[] = [];
const app = createApp(config); app.use(express.static(resolve('dist/client')));
const server = app.listen(0,'127.0.0.1'); await once(server,'listening');
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`; config.origin = base;
let stage = 'fixtures', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const check = (result: {error: unknown}) => { assert.equal(!!result.error,false); };
async function api(index:number, path:string, method='GET', body?:unknown, expected=200) {
  const response = await fetch(base+path,{method,headers:{Authorization:`Bearer ${users[index].token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
  assert.equal(response.status,expected,`Unexpected status at ${method} ${path.split('?')[0]}`);
  return response.json();
}
try {
  for (let i=0;i<3;i++) {
    const email=`social-test-${randomUUID()}@example.com`, password=randomUUID()+'aA1!';
    const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:'Disposable social test'}}); check(created);
    const user={id:created.data.user!.id,email,password,token:'',client:createClient(config.supabaseUrl,config.publishableKey,options)}; users.push(user);
    const login=await user.client.auth.signInWithPassword({email,password}); check(login); user.token=login.data.session!.access_token;
  }
  const listing=await api(0,'/api/listings','POST',{name:'Messaging acceptance club',brand:'Test',category:'Drivers',condition:'Good',price_pence:10000,location:'Leeds'},201);
  listingIds.push(listing.listing.id); const id=listingIds[0];
  stage='favourites persistence and isolation';
  await api(1,`/api/me/favourites/${id}`,'PUT',{});
  await api(1,`/api/me/favourites/${id}`,'PUT',{});
  assert.equal((await api(1,'/api/me/favourites')).total,1);
  assert.equal((await api(2,'/api/me/favourites')).total,0);
  assert.equal((await users[2].client.from('favourites').select('*')).data?.length,0);
  stage='conversations, messages and isolation';
  const thread=(await api(1,'/api/conversations','POST',{listing_id:id},201)).conversation; threadIds.push(thread.id);
  assert.equal((await api(1,'/api/conversations','POST',{listing_id:id})).conversation.id,thread.id);
  const path=`/api/conversations/${thread.id}`;
  const message={body:'Is the shaft in good condition? <script>text only</script>',client_id:randomUUID()};
  await api(1,path+'/messages','POST',message,201); await api(1,path+'/messages','POST',message);
  assert.equal((await api(0,path+'/messages')).messages.length,1);
  await api(2,path+'/messages','GET',undefined,404);
  assert.equal((await users[2].client.from('messages').select('*')).data?.length,0);
  assert.ok((await users[2].client.from('messages').insert({conversation_id:thread.id,sender_id:users[2].id,body:'intrusion',client_id:randomUUID()})).error);
  stage='blocking and reports';
  await api(1,path+'/block','PUT',{});
  await api(0,path+'/messages','POST',{body:'blocked',client_id:randomUUID()},403);
  assert.ok((await users[0].client.from('messages').insert({conversation_id:thread.id,sender_id:users[0].id,body:'blocked direct',client_id:randomUUID()})).error);
  await api(0,path+'/block','DELETE',{});
  assert.equal((await api(0,path+'/messages')).blocked,true);
  await api(1,path+'/report','POST',{reason:'spam',details:'Disposable acceptance report'},201);
  assert.equal((await users[0].client.from('conversation_reports').select('*')).data?.length,0);
  assert.equal((await admin.from('conversation_reports').select('id').eq('conversation_id',thread.id)).data?.length,1);
  await api(1,path+'/block','DELETE',{});
  await api(0,path+'/messages','POST',{body:'Yes, the shaft is in good condition.',client_id:randomUUID()},201);
  console.log('PASS: hosted favourites persistence, duplicate safety, private conversations, sender checks, bilateral blocking and private reports.');
  stage='headless browser';
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext(); const page=await context.newPage(); page.setDefaultTimeout(20000);
  const errors:string[]=[]; page.on('pageerror',()=>errors.push('pageerror'));
  await page.goto(base); await page.locator('#account-button').click();
  await page.locator('#auth-email').fill(users[1].email); await page.locator('#auth-password').fill(users[1].password); await page.locator('#auth-submit').click();
  await page.locator('#account-button').filter({hasText:'My account'}).waitFor();
  await page.locator('#saved-filter').click(); await page.locator('[data-listing]').first().waitFor();
  assert.equal(await page.locator('[data-listing]').count(),1);
  await page.reload(); await page.locator('[data-save].saved').waitFor();
  await page.locator('#messages-button').click(); await page.locator('#conversation-list button').first().click();
  await page.locator('#message-history li').filter({hasText:'shaft is in good condition'}).waitFor();
  assert.equal(await page.locator('#message-history script').count(),0);
  await page.locator('#message-body').fill('Thanks, message sent from the browser.'); await page.locator('#send-message').click();
  await page.locator('#message-history li').filter({hasText:'message sent from the browser'}).waitFor();
  await page.locator('#block-user').click(); await page.locator('#block-user').filter({hasText:/^Unblock golfer$/}).waitFor();
  assert.equal(await page.locator('#send-message').isDisabled(),true);
  await page.locator('#block-user').click(); await page.locator('#block-user').filter({hasText:/^Block golfer$/}).waitFor();
  assert.equal(await page.locator('#send-message').isDisabled(),false);
  await page.locator('#messages-dialog').evaluate(node => { node.scrollTop=0; });
  await mkdir('artifacts/social-flow',{recursive:true});
  await page.screenshot({path:'artifacts/social-flow/messages-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'artifacts/social-flow/messages-mobile.png'});
  await page.locator('[aria-label="Close messages"]').click();
  await page.locator('#account-button').click(); await page.locator('#sign-out').click();
  assert.equal(await page.locator('#message-history li').count(),0);
  assert.equal(errors.length,0);
  // A second participant submits a report through the actual form.
  await page.locator('#account-button').click();
  await page.locator('#auth-email').fill(users[0].email); await page.locator('#auth-password').fill(users[0].password); await page.locator('#auth-submit').click();
  await page.locator('#account-button').filter({hasText:'My account'}).waitFor();
  await page.locator('#messages-button').click(); await page.locator('#conversation-list button').first().click();
  await page.locator('#message-history li').first().waitFor();
  await page.locator('#report-user').click(); await page.locator('#report-details').fill('Browser report acceptance only'); await page.locator('#submit-report').click();
  await page.locator('#messages-status').filter({hasText:'Report saved for review'}).waitFor();
  assert.equal((await admin.from('conversation_reports').select('id').eq('conversation_id',thread.id)).data?.length,2);
  console.log('PASS: headless UI saved clubs survive reload; inbox, sending, block/unblock, text escaping, sign-out clearing and mobile width.');
  stage='archive visibility';
  await api(0,`/api/listings/${id}/archive`,'POST',{});
  assert.equal((await api(1,'/api/me/favourites')).total,0);
  assert.ok((await api(1,path+'/messages')).messages.length);
  console.log('PASS: archived listings disappear from saved browsing while conversation history remains.');
} catch { console.error(`FAIL: ${stage}; sensitive diagnostics suppressed.`); process.exitCode=1; }
finally {
  await browser?.close();
  // Cleanup is restricted to IDs created by this invocation. Never target an existing email/account.
  if (threadIds.length) {
    for(const thread of threadIds) for(let i=0;i<Math.min(users.length,2);i++) { try { await api(i,`/api/conversations/${thread}/block`,'DELETE',{}); } catch { /* verified below */ } }
    for(const table of ['conversation_reports','messages']) check(await admin.from(table).delete().in('conversation_id',threadIds));
    check(await admin.from('conversations').delete().in('id',threadIds));
  }
  if(listingIds.length) { check(await admin.from('favourites').delete().in('listing_id',listingIds)); check(await admin.from('listings').delete().in('id',listingIds)); }
  for(const user of users) { await user.client.auth.signOut(); check(await admin.auth.admin.deleteUser(user.id)); }
  server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));
  console.log('Cleanup complete: only this run’s temporary accounts and records removed.');
}
