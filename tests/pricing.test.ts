import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('minimum buyer fee, and only sellers who can be paid can be bought from', async t => {
  const db = new PGlite();
  const seller = '11111111-1111-4111-8111-111111111111',
    buyer = '22222222-2222-4222-8222-222222222222';
  const admin = async (sql: string, params: unknown[] = []) => {
    await db.exec('reset role');
    return db.query<any>(sql, params);
  };
  async function as(id: string) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec('set role authenticated');
  }
  const newListing = async (pence: number) => {
    await as(seller);
    return (
      await db.query<{ id: string }>(
        "insert into public.listings(seller_id,name,brand,category,condition,price_pence,location) values($1,'G430','Ping','Drivers','Good',$2,'Leeds') returning id",
        [seller, pence],
      )
    ).rows[0].id;
  };
  const act = async (action: string, listing: string) => {
    await as(buyer);
    return (
      await db.query<{ r: any }>('select public.order_action($1,$2,$3) as r', [
        action,
        listing,
        action === 'reserve' ? randomUUID() : null,
      ])
    ).rows[0].r;
  };

  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    const folder = new URL('../supabase/migrations/', import.meta.url);
    // Photos need Supabase Storage, which the in-memory database does not have.
    for (const file of (await readdir(folder)).filter(name => !/listing_photos|harden_function/.test(name)).sort())
      await db.exec(await readFile(new URL(file, folder), 'utf8'));
    for (const id of [seller, buyer]) await db.query("insert into auth.users values($1,'{}',now())", [id]);
    await admin('select public.set_checkout_enabled(true)');
    const cheap = await newListing(1000),
      dear = await newListing(10000);

    await t.test('an item cannot be quoted or reserved until the seller can be paid', async () => {
      await assert.rejects(act('quote', cheap), /not finished setting up payments/);
      await assert.rejects(act('reserve', cheap), /not finished setting up payments/);
      // Starting payout setup is not enough: it must be complete.
      await admin("insert into public.seller_accounts(seller_id,provider_account) values($1,'acct_1')", [seller]);
      await assert.rejects(act('quote', cheap), /not finished setting up payments/);
      assert.equal((await admin('select status from public.listings where id=$1', [cheap])).rows[0].status, 'active');
      await admin('update public.seller_accounts set payouts_enabled=true');
      assert.equal((await act('quote', cheap)).item_pence, 1000);
    });

    await t.test('the fee is fixed plus a percentage, but never below the minimum', async () => {
      // 70p + 5% of £10 is £1.20, so the £3 minimum applies.
      const low = await act('quote', cheap);
      assert.deepEqual([low.fee_pence, low.total_pence], [300, 1000 + 300 + 595]);
      // 70p + 5% of £100 is £5.70, above the minimum.
      const high = await act('quote', dear);
      assert.deepEqual([high.fee_pence, high.total_pence], [570, 10000 + 570 + 595]);
      // The order stores the same fee the buyer was quoted.
      assert.equal((await act('reserve', cheap)).fee_pence, 300);
    });

    await t.test('the payout rule can only be switched by the server', async () => {
      await as(buyer);
      await assert.rejects(db.query('select public.set_require_payouts(false)'), /permission denied/);
      await db.exec('reset role; set role service_role');
      const settings = (await db.query<{ r: any }>('select public.set_require_payouts(false) as r')).rows[0].r;
      assert.deepEqual([settings.require_payouts, settings.fee_min_pence], [false, 300]);
      await admin('update public.seller_accounts set payouts_enabled=false');
      assert.equal((await act('quote', dear)).fee_pence, 570);
    });
  } finally {
    await db.close();
  }
});
