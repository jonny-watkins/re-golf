import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../server/app.js';
import { readConfig } from '../server/config.js';
const config = readConfig(process.env);
assert.equal(process.env.TEST_PROJECT,new URL(config.supabaseUrl).hostname.split('.')[0]);
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(config.supabaseUrl,config.storageSecret,opts);
const users:any[]=[];
const app=createApp(config); app.use(express.static(resolve('dist/client')));
const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
const remote=process.env.TEST_BASE_URL;
if(remote) assert.equal(remote,'https://re-golf-development.onrender.com');
const password=remote?dotenv.parse(await readFile('.env.render-preview')).PREVIEW_ACCESS_PASSWORD:'';
const base=remote||`http://127.0.0.1:${(server.address() as any).port}`; config.origin=base;
const cookie=password?{Cookie:'re_golf_preview='+createHash('sha256').update(password).digest('hex')}:{};
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined, stage='fixtures';
const check=(r:{error:unknown})=>assert.ok(!r.error);
async function api(i:number,body?:unknown,expected=200){
  const r=await fetch(base+'/api/test-checkout',{method:body?'POST':'GET',headers:{...cookie,Authorization:'Bearer '+users[i].token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.equal(r.status,expected); return r.json();
}
try{
  const before=await admin.from('listings').select('*').order('id');check(before);
  for(let i=0;i<3;i++){
    const email='checkout-'+randomUUID()+'@example.com',pw=randomUUID()+'Aa1!';
    const made=await admin.auth.admin.createUser({email,password:pw,email_confirm:true});check(made);
    const client=createClient(config.supabaseUrl,config.publishableKey,opts);
    const user={id:made.data.user!.id,email,pw,client,token:''};users.push(user);
    const login=await client.auth.signInWithPassword({email,password:pw});check(login);user.token=login.data.session!.access_token;
  }
  stage='simultaneous buyers';
  const item=(await api(0,{action:'create',title:'Concurrent test club',price_pence:10000})).result;
  const attempts=await Promise.all([1,2].map(async i=>{
    const r=await fetch(base+'/api/test-checkout',{method:'POST',headers:{...cookie,Authorization:'Bearer '+users[i].token,'Content-Type':'application/json'},body:JSON.stringify({action:'reserve',listing_id:item.id,request_id:randomUUID()})});
    return {i,status:r.status,data:await r.json()};
  }));
  assert.deepEqual(attempts.map(a=>a.status).sort(),[200,409]);
  const winner=attempts.find(a=>a.status===200)!;
  await api(winner.i,{action:'fail',order_id:winner.data.result.id});
  await api(1,{action:'reserve',listing_id:item.id,request_id:randomUUID(),total_pence:1},400);
  stage='browser purchase journey';
  await api(0,{action:'create',title:'Browser checkout driver',price_pence:12500});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const contexts=[];
  for(const i of [0,1]){
    stage='browser login '+i;
    const context=await browser.newContext({viewport:i?{width:390,height:844}:{width:1280,height:900},...(password?{httpCredentials:{username:'preview',password}}:{})});contexts.push(context);
    const page=await context.newPage();await page.goto(base);
    await page.locator('#account-button').click();await page.locator('#auth-email').fill(users[i].email);await page.locator('#auth-password').fill(users[i].pw);await page.locator('#auth-submit').click();
    await page.locator('#account-button').filter({hasText:'My account'}).waitFor();
    stage='open checkout '+i;
    await page.locator('#checkout-test-button').click();
    await page.locator('#test-inventory').getByText('Browser checkout driver',{exact:false}).waitFor();
  }
  const seller=contexts[0].pages()[0],buyer=contexts[1].pages()[0];
  stage='reserve through browser';
  await buyer.locator('#test-inventory section').filter({hasText:'Browser checkout driver'}).getByRole('button',{name:'Review test checkout'}).click();
  const order=buyer.locator('#test-orders section').filter({hasText:'Browser checkout driver'});
  await order.getByRole('button',{name:'Simulate successful payment'}).waitFor();
  stage='price breakdown and mobile layout';
  assert.match(await order.innerText(),/£133.45/);
  await mkdir('artifacts/checkout-flow',{recursive:true});
  await buyer.screenshot({path:'artifacts/checkout-flow/mobile.png',fullPage:true});
  assert.ok(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await order.getByRole('button',{name:'Simulate successful payment'}).click();
  await order.getByText(/— paid\./).waitFor();
  stage='seller dispatch';
  await seller.locator('#test-checkout-refresh').click();
  const sale=seller.locator('#test-orders section').filter({hasText:'Browser checkout driver'});
  await sale.getByRole('button',{name:'Simulate dispatch'}).click();
  await sale.getByText(/— dispatched\./).waitFor();
  stage='buyer delivery';
  await buyer.locator('#test-checkout-refresh').click();await order.getByRole('button',{name:'Simulate delivery'}).click();
  await order.getByText(/delivered/).waitFor();
  stage='reload persistence';
  await buyer.reload();await buyer.locator('#checkout-test-button').click();await buyer.locator('#test-orders').getByText(/delivered/).waitFor();
  stage='privacy and isolation';
  const stranger=await api(2);assert.equal(stranger.orders.some((o:any)=>o.title==='Browser checkout driver'),false);
  const after=await admin.from('listings').select('*').order('id');check(after);assert.deepEqual(after.data,before.data);
  console.log('PASS: concurrent buyers, forged amount rejection, failed payment release, browser purchase/dispatch/delivery, reload persistence, mobile width, private orders and existing listing preservation.');
}catch{console.error('FAIL: '+stage+'; sensitive diagnostics suppressed.');process.exitCode=1;}
finally{
  await browser?.close();
  for(const u of users){check(await admin.from('test_listings').delete().eq('seller_id',u.id));await u.client.auth.signOut();check(await admin.auth.admin.deleteUser(u.id));}
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  console.log('Disposable test accounts and inventory removed.');
}
