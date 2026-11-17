-- Support tools, payout clawback, and removal of the retired checkout simulation.
-- Safe to run once on a database that already has 20261117150000_orders_escrow.sql.
begin;

-- 1. Retire the simulation (its tables are test-only and separate from real listings).
drop function if exists public.test_checkout(text, uuid, uuid, uuid, text, integer);
drop function if exists private.test_checkout(text, uuid, uuid, uuid, text, integer);
drop table if exists public.test_orders;
drop table if exists public.test_listings;
drop table if exists private.test_checkout_settings;
-- The simulation was the only reason signed-in users could reach this schema.
revoke usage on schema private from authenticated;

-- 2. Settings the server may read and the support screen may switch.
create function public.marketplace_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) - 'singleton' from private.marketplace_settings s where singleton;
$$;
create function public.set_checkout_enabled(p_enabled boolean) returns jsonb
language sql security definer set search_path = '' as $$
  update private.marketplace_settings set checkout_enabled = p_enabled where singleton;
  select public.marketplace_settings();
$$;
revoke all on function public.marketplace_settings() from public, anon, authenticated;
revoke all on function public.set_checkout_enabled(boolean) from public, anon, authenticated;
grant execute on function public.marketplace_settings() to service_role;
grant execute on function public.set_checkout_enabled(boolean) to service_role;

-- 3. Who did what in the support screen.
create table public.admin_actions (
  id bigint generated always as identity primary key,
  admin_id uuid not null,
  action text not null,
  target text not null,
  note text,
  created_at timestamptz not null default now()
);
alter table public.admin_actions enable row level security;
revoke all on public.admin_actions from public, anon, authenticated;
grant select, insert on public.admin_actions to service_role;

-- 4. Taking a payout back. Needed when the buyer's bank disputes a charge, or support
-- refunds an order, after the seller has already been paid.
alter table public.orders drop constraint orders_funds_check;
alter table public.orders add constraint orders_funds_check check (funds in
  ('none', 'held', 'release_due', 'released', 'refund_due', 'refunded', 'reversal_due', 'reversed'));
alter table public.orders
  add column reversal_ref text,
  add column refund_after_reversal boolean not null default false;
drop index public.orders_money_work;
create index orders_money_work on public.orders (funds) where funds in ('release_due', 'refund_due', 'reversal_due');

create function public.order_clawback(p_action text, p_order uuid, p_ref text default null, p_refund boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ord public.orders;
begin
  select * into ord from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if p_action = 'start' then
    if ord.funds = 'release_due' then
      -- Not paid out yet: simply stop the payout and hold the money for support.
      update public.orders set funds = 'held', status = 'disputed', release_at = null,
          issue = coalesce(issue, 'Payout stopped for review')
        where id = ord.id returning * into ord;
      insert into public.order_events (order_id, action, status, funds, note) values (ord.id, 'payout_stopped', ord.status, ord.funds, p_ref);
    elsif ord.funds = 'released' then
      update public.orders set funds = 'reversal_due', status = 'disputed', refund_after_reversal = p_refund,
          issue = coalesce(issue, 'Payout being taken back for review')
        where id = ord.id returning * into ord;
      insert into public.order_events (order_id, action, status, funds, note) values (ord.id, 'clawback_started', ord.status, ord.funds, p_ref);
    end if;
  elsif p_action = 'reversed' then
    if ord.funds in ('reversed', 'refund_due', 'refunded') and ord.reversal_ref is not null then return to_jsonb(ord); end if;
    if ord.funds <> 'reversal_due' then raise exception 'No payout is being taken back' using errcode = '23514'; end if;
    update public.orders set reversal_ref = p_ref,
        funds = case when refund_after_reversal then 'refund_due' else 'reversed' end,
        status = case when refund_after_reversal then 'cancelled' else status end
      where id = ord.id returning * into ord;
    insert into public.order_events (order_id, action, status, funds, note) values (ord.id, 'payout_reversed', ord.status, ord.funds, p_ref);
  else
    raise exception 'Invalid clawback action' using errcode = '22023';
  end if;
  return to_jsonb(ord);
end;
$$;
revoke all on function public.order_clawback(text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.order_clawback(text, uuid, text, boolean) to service_role;

commit;
