import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('isolated checkout enforces ownership, stock, immutable amounts and payment lifecycle', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111';
  const buyer = '22222222-2222-4222-8222-222222222222';
  const other = '33333333-3333-4333-8333-333333333333';
  const unverified = '44444444-4444-4444-8444-444444444444';
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon,service_role;
  `);
  for (const file of ['202611140001_foundations.sql','20261117123645_test_checkout_orders.sql'])
    await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  await db.query("insert into auth.users values($1,'{}',now()),($2,'{}',now()),($3,'{}',now()),($4,'{}',null)", [seller,buyer,other,unverified]);
  async function as(id: string) { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]); await db.exec('set role authenticated'); }
  async function call(action: string, listing: string | null = null, request: string | null = null, order: string | null = null) {
    return (await db.query<{ result: any }>("select public.test_checkout($1,$2,$3,$4,'Test driver',10000) as result", [action,listing,request,order])).rows[0].result;
  }
  let item: any, order: any;
  try {
    await t.test('unverified and anonymous users cannot transact', async () => {
      await as(unverified); await assert.rejects(call('create'), /Confirm your email/);
      await db.exec('reset role; set role anon'); await assert.rejects(call('create'), /permission denied/);
    });
    await t.test('buyer receives authoritative snapshot and repeats reuse the order', async () => {
      await as(seller); item = await call('create');
      await assert.rejects(call('reserve',item.id,buyer), /own listing/);
      await as(buyer); order = await call('reserve',item.id,buyer);
      assert.equal(order.total_pence,10845); assert.equal(order.item_pence,10000);
      assert.equal((await call('reserve',item.id,buyer)).id,order.id);
      await as(other); await assert.rejects(call('reserve',item.id,other), /already reserved/);
      assert.equal((await db.query('select * from public.test_orders')).rows.length,0);
      await assert.rejects(call('pay',null,null,order.id), /Order unavailable/);
    });
    await t.test('direct writes and forged order changes are denied', async () => {
      await as(buyer);
      await assert.rejects(db.exec('update public.test_orders set item_pence=1'), /permission denied/);
      await assert.rejects(db.exec("update public.test_listings set status='sold'"), /permission denied/);
      await assert.rejects(db.exec('select * from private.test_checkout_settings'), /permission denied/);
    });
    await t.test('failed payments release stock; paid snapshots survive fee changes', async () => {
      assert.equal((await call('fail',null,null,order.id)).status,'failed');
      await as(other); order = await call('reserve',item.id,other);
      await db.exec('reset role; update private.test_checkout_settings set fee_pence=999');
      await as(other);
      assert.equal((await call('pay',null,null,order.id)).total_pence,10845);
      assert.equal((await call('pay',null,null,order.id)).status,'paid');
      await as(buyer); await assert.rejects(call('reserve',item.id,seller), /already reserved/);
    });
    await t.test('only seller dispatches and only buyer confirms delivery', async () => {
      await as(other); await assert.rejects(call('dispatch',null,null,order.id), /Seller action/);
      await assert.rejects(call('deliver',null,null,order.id), /not dispatched/);
      await as(seller); assert.equal((await call('dispatch',null,null,order.id)).status,'dispatched');
      await assert.rejects(call('deliver',null,null,order.id), /Buyer action/);
      await as(other); assert.equal((await call('deliver',null,null,order.id)).status,'delivered');
    });
    await t.test('expired reservations reject late success and allow another buyer', async () => {
      await as(seller); item = await call('create');
      await as(buyer); order = await call('reserve',item.id,other);
      await db.exec('reset role');
      await db.query("update public.test_orders set expires_at=now()-interval '1 second' where id=$1",[order.id]);
      await db.query("update public.test_listings set reserved_until=now()-interval '1 second' where id=$1",[item.id]);
      await as(buyer); assert.equal((await call('pay',null,null,order.id)).status,'expired');
      await as(other); const next = await call('reserve',item.id,buyer);
      assert.equal((await call('cancel',null,null,next.id)).status,'cancelled');
      await db.exec('reset role');
      assert.equal((await db.query('select * from public.listings')).rows.length,0);
      await db.exec('update private.test_checkout_settings set enabled=false');
      await as(seller); await assert.rejects(call('create'), /disabled/);
    });
  } finally { await db.close(); }
});
