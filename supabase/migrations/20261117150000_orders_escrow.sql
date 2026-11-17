-- Real marketplace orders with held funds.
-- The database decides what should happen to the money (funds column); a server
-- worker performs it with the payment provider and reports back through
-- order_system(). Nothing here talks to a provider, and checkout starts disabled.
begin;
create schema if not exists private;

create table private.marketplace_settings (
  singleton boolean primary key default true check (singleton),
  checkout_enabled boolean not null default false,
  fee_fixed_pence integer not null default 70 check (fee_fixed_pence between 0 and 100000),
  fee_bps integer not null default 500 check (fee_bps between 0 and 5000),
  delivery_pence integer not null default 595 check (delivery_pence between 0 and 100000),
  reservation_minutes integer not null default 35 check (reservation_minutes between 5 and 1440),
  dispatch_days integer not null default 5 check (dispatch_days between 1 and 30),
  delivery_timeout_days integer not null default 10 check (delivery_timeout_days between 1 and 60),
  hold_hours integer not null default 48 check (hold_hours between 0 and 720)
);
insert into private.marketplace_settings default values;
alter table private.marketplace_settings enable row level security;
revoke all on private.marketplace_settings from public, anon, authenticated;

-- Listings gain reserved and sold. Only order functions may enter or leave them.
alter table public.listings drop constraint listings_status_check;
alter table public.listings add constraint listings_status_check
  check (status in ('active', 'reserved', 'sold', 'archived'));

create function private.guard_listing_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Order functions run as their owner; direct client writes run as these roles.
  if current_user in ('anon', 'authenticated')
     and (old.status in ('reserved', 'sold') or new.status in ('reserved', 'sold')) then
    raise exception 'This listing is part of an order' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_listing_status() from public, anon, authenticated;
create trigger listings_status_guard before update on public.listings
  for each row execute function private.guard_listing_status();

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id),
  buyer_id uuid not null references public.profiles(id),
  seller_id uuid not null references public.profiles(id),
  request_id uuid not null,
  title text not null,
  item_pence integer not null check (item_pence > 0),
  fee_pence integer not null check (fee_pence >= 0),
  delivery_pence integer not null check (delivery_pence >= 0),
  total_pence integer generated always as (item_pence + fee_pence + delivery_pence) stored,
  -- Fulfilment and money are tracked separately.
  status text not null default 'awaiting_payment' check (status in
    ('awaiting_payment', 'paid', 'dispatched', 'delivered', 'completed', 'disputed', 'cancelled', 'expired')),
  funds text not null default 'none' check (funds in
    ('none', 'held', 'release_due', 'released', 'refund_due', 'refunded')),
  expires_at timestamptz not null,
  paid_at timestamptz,
  dispatch_by timestamptz,
  dispatched_at timestamptz,
  tracking text check (char_length(tracking) <= 100),
  delivered_at timestamptz,
  release_at timestamptz,
  completed_at timestamptz,
  issue text check (char_length(issue) <= 2000),
  checkout_ref text,          -- provider checkout session, so a cancelled order can close it
  payment_ref text,
  transfer_ref text,
  refund_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_id, request_id),
  check (buyer_id <> seller_id)
);
create unique index orders_one_live_per_listing on public.orders (listing_id)
  where status in ('awaiting_payment', 'paid', 'dispatched', 'delivered', 'completed', 'disputed');
create index orders_buyer on public.orders (buyer_id, created_at desc);
create index orders_seller on public.orders (seller_id, created_at desc);
create index orders_money_work on public.orders (funds) where funds in ('release_due', 'refund_due');
create index orders_open on public.orders (status) where status in ('awaiting_payment', 'paid', 'dispatched', 'delivered');
create trigger orders_updated before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id),
  actor_id uuid,              -- null for the system (webhook, sweep, support)
  action text not null,
  status text not null,
  funds text not null,
  note text,
  created_at timestamptz not null default now()
);
create index order_events_order on public.order_events (order_id, id);

-- One row per provider event, so a repeated webhook is recognised and ignored.
create table public.payment_events (
  event_id text primary key,
  order_id uuid references public.orders(id),
  action text not null,
  received_at timestamptz not null default now()
);

-- Delivery address: written by the server from the provider's checkout, shown to
-- the seller only while they need it to post the item.
create table public.order_addresses (
  order_id uuid primary key references public.orders(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  line1 text not null check (char_length(line1) between 1 and 120),
  line2 text check (char_length(line2) <= 120),
  city text not null check (char_length(city) between 1 and 80),
  postcode text not null check (char_length(postcode) between 2 and 12),
  country text not null default 'GB' check (country = 'GB'),
  created_at timestamptz not null default now()
);
alter table public.order_addresses enable row level security;
revoke all on public.order_addresses from public, anon, authenticated;
grant select on public.order_addresses to authenticated;
grant all on public.order_addresses to service_role;
create policy order_address_participants on public.order_addresses for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (
    o.buyer_id = (select auth.uid())
    or (o.seller_id = (select auth.uid()) and o.status in ('paid', 'dispatched', 'delivered', 'disputed')))));

-- The seller's payout account with the payment provider. Funds wait in
-- release_due until payouts_enabled is true.
create table public.seller_accounts (
  seller_id uuid primary key references public.profiles(id),
  provider_account text not null unique,
  payouts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger seller_accounts_updated before update on public.seller_accounts
  for each row execute function public.set_updated_at();
alter table public.seller_accounts enable row level security;
revoke all on public.seller_accounts from public, anon, authenticated;
grant select (seller_id, payouts_enabled) on public.seller_accounts to authenticated;
grant all on public.seller_accounts to service_role;
create policy seller_account_own on public.seller_accounts for select to authenticated
  using (seller_id = (select auth.uid()));

alter table public.orders enable row level security;
alter table public.order_events enable row level security;
alter table public.payment_events enable row level security;
revoke all on public.orders, public.order_events, public.payment_events from public, anon, authenticated;
grant select on public.orders, public.order_events to authenticated;
grant all on public.orders, public.order_events, public.payment_events to service_role;
create policy orders_participants on public.orders for select to authenticated
  using ((select auth.uid()) in (buyer_id, seller_id));
create policy order_events_participants on public.order_events for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and (select auth.uid()) in (o.buyer_id, o.seller_id)));

create function private.order_fee(p_item integer, s private.marketplace_settings) returns integer
language sql immutable set search_path = '' as $$
  select s.fee_fixed_pence + round(p_item::numeric * s.fee_bps / 10000)::integer;
$$;

create function private.log_order(o public.orders, p_actor uuid, p_action text, p_note text default null) returns void
language sql set search_path = '' as $$
  insert into public.order_events (order_id, actor_id, action, status, funds, note)
  values (o.id, p_actor, p_action, o.status, o.funds, p_note);
$$;

revoke all on function private.order_fee(integer, private.marketplace_settings) from public, anon, authenticated;
revoke all on function private.log_order(public.orders, uuid, text, text) from public, anon, authenticated;

-- Buyer and seller actions. Money never moves here: the furthest a client can
-- go is to make funds release_due (buyer accepting) or freeze them (issue).
create function public.order_action(p_action text, p_listing uuid default null, p_request uuid default null,
  p_order uuid default null, p_text text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  s private.marketplace_settings;
  item public.listings;
  ord public.orders;
  note text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if actor is null or not exists (select 1 from auth.users where id = actor and email_confirmed_at is not null) then
    raise exception 'Confirm your email before buying or selling' using errcode = '42501';
  end if;
  select * into s from private.marketplace_settings where singleton;

  if p_action in ('quote', 'reserve') then
    if not s.checkout_enabled then raise exception 'Checkout is not open yet' using errcode = '55000'; end if;
    select * into item from public.listings where id = p_listing for update;
    if not found then raise exception 'Listing unavailable' using errcode = 'P0002'; end if;
    if item.seller_id = actor then raise exception 'You cannot buy your own listing' using errcode = '42501'; end if;
    if p_action = 'reserve' then
      if p_request is null then raise exception 'Request ID required' using errcode = '22023'; end if;
      -- A retried request returns the order it already created.
      select * into ord from public.orders where buyer_id = actor and request_id = p_request;
      if found then
        if ord.listing_id <> item.id then raise exception 'Request already used' using errcode = '22023'; end if;
        return to_jsonb(ord);
      end if;
    end if;
    -- Release a lapsed reservation before judging availability.
    update public.orders set status = 'expired'
      where listing_id = item.id and status = 'awaiting_payment' and expires_at <= now();
    if found and item.status = 'reserved' then
      update public.listings set status = 'active' where id = item.id returning * into item;
    end if;
    if item.status <> 'active' then raise exception 'This item is already reserved or sold' using errcode = '23505'; end if;
    if p_action = 'quote' then
      return jsonb_build_object('title', item.brand || ' ' || item.name, 'item_pence', item.price_pence,
        'fee_pence', private.order_fee(item.price_pence, s), 'delivery_pence', s.delivery_pence,
        'total_pence', item.price_pence + private.order_fee(item.price_pence, s) + s.delivery_pence,
        'hold_hours', s.hold_hours);
    end if;
    if exists (select 1 from public.user_blocks where (blocker_id = actor and blocked_id = item.seller_id)
        or (blocker_id = item.seller_id and blocked_id = actor)) then
      raise exception 'This item is unavailable to you' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('order-buyer:' || actor::text, 0));
    if (select count(*) from public.orders where buyer_id = actor and created_at > now() - interval '1 hour') >= 10 then
      raise exception 'Too many checkouts started. Please wait.' using errcode = 'P0001';
    end if;
    insert into public.orders (listing_id, buyer_id, seller_id, request_id, title, item_pence, fee_pence, delivery_pence, expires_at)
      values (item.id, actor, item.seller_id, p_request, item.brand || ' ' || item.name, item.price_pence,
        private.order_fee(item.price_pence, s), s.delivery_pence, now() + make_interval(mins => s.reservation_minutes))
      returning * into ord;
    update public.listings set status = 'reserved' where id = item.id;
    perform private.log_order(ord, actor, 'reserve');
    return to_jsonb(ord);
  end if;

  select * into ord from public.orders where id = p_order and actor in (buyer_id, seller_id) for update;
  if not found then raise exception 'Order unavailable' using errcode = 'P0002'; end if;

  if p_action = 'cancel' then
    -- Only before payment. After payment, cancellation is a refund decided by rules or support.
    if actor <> ord.buyer_id then raise exception 'Buyer action only' using errcode = '42501'; end if;
    if ord.status = 'cancelled' then return to_jsonb(ord); end if;
    if ord.status <> 'awaiting_payment' then raise exception 'This order can no longer be cancelled here' using errcode = '23514'; end if;
    update public.orders set status = 'cancelled' where id = ord.id returning * into ord;
    update public.listings set status = 'active' where id = ord.listing_id and status = 'reserved';
  elsif p_action = 'dispatch' then
    if actor <> ord.seller_id then raise exception 'Seller action only' using errcode = '42501'; end if;
    if ord.status in ('dispatched', 'delivered', 'completed') then return to_jsonb(ord); end if;
    if ord.status <> 'paid' then raise exception 'Order is not awaiting dispatch' using errcode = '23514'; end if;
    -- Tracked postage is mandatory: it is the seller's proof of posting.
    if note is null or char_length(note) < 6 then raise exception 'Enter the carrier and tracking number' using errcode = '22023'; end if;
    update public.orders set status = 'dispatched', dispatched_at = now(), tracking = left(note, 100)
      where id = ord.id returning * into ord;
  elsif p_action = 'confirm_delivery' then
    if actor <> ord.buyer_id then raise exception 'Buyer action only' using errcode = '42501'; end if;
    if ord.status in ('delivered', 'completed') then return to_jsonb(ord); end if;
    if ord.status <> 'dispatched' then raise exception 'Order is not in transit' using errcode = '23514'; end if;
    update public.orders set status = 'delivered', delivered_at = now(),
        release_at = now() + make_interval(hours => s.hold_hours)
      where id = ord.id returning * into ord;
  elsif p_action = 'accept' then
    -- Buyer is happy: end the hold early.
    if actor <> ord.buyer_id then raise exception 'Buyer action only' using errcode = '42501'; end if;
    if ord.status = 'completed' then return to_jsonb(ord); end if;
    if ord.status not in ('dispatched', 'delivered') then raise exception 'Order cannot be completed yet' using errcode = '23514'; end if;
    update public.orders set status = 'completed', funds = 'release_due', completed_at = now(),
        delivered_at = coalesce(delivered_at, now())
      where id = ord.id returning * into ord;
  elsif p_action = 'report_issue' then
    if actor <> ord.buyer_id then raise exception 'Buyer action only' using errcode = '42501'; end if;
    if ord.status = 'disputed' then return to_jsonb(ord); end if;
    if ord.status not in ('dispatched', 'delivered') then raise exception 'The issue window for this order is closed' using errcode = '23514'; end if;
    if note is null then raise exception 'Describe the issue' using errcode = '22023'; end if;
    update public.orders set status = 'disputed', issue = left(note, 2000), release_at = null
      where id = ord.id returning * into ord;
  else
    raise exception 'Invalid order action' using errcode = '22023';
  end if;
  perform private.log_order(ord, actor, p_action, note);
  return to_jsonb(ord);
end;
$$;
revoke all on function public.order_action(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.order_action(text, uuid, uuid, uuid, text) to authenticated;

-- Server-only transitions: verified payment webhooks, the money worker, carrier
-- updates and support decisions. p_event makes provider events repeat-safe.
create function public.order_system(p_action text, p_order uuid, p_ref text default null, p_event text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s private.marketplace_settings;
  ord public.orders;
  item public.listings;
begin
  select * into s from private.marketplace_settings where singleton;
  select * into ord from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if p_event is not null then
    insert into public.payment_events (event_id, order_id, action) values (p_event, ord.id, p_action)
      on conflict do nothing;
    if not found then return to_jsonb(ord); end if;
  end if;
  select * into item from public.listings where id = ord.listing_id for update;

  if p_action = 'payment_succeeded' then
    if ord.funds <> 'none' then return to_jsonb(ord); end if;
    if ord.status = 'awaiting_payment' then
      null;
    elsif ord.status in ('expired', 'cancelled') and item.status = 'active' then
      -- Late success and the item is still free: honour the purchase.
      null;
    elsif ord.status in ('expired', 'cancelled') then
      -- Late success but the item has gone: take no sale, give the money back.
      update public.orders set funds = 'refund_due', payment_ref = p_ref, paid_at = now()
        where id = ord.id returning * into ord;
      perform private.log_order(ord, null, 'late_payment_refund', p_ref);
      return to_jsonb(ord);
    else
      return to_jsonb(ord);
    end if;
    update public.orders set status = 'paid', funds = 'held', payment_ref = p_ref, paid_at = now(),
        dispatch_by = now() + make_interval(days => s.dispatch_days)
      where id = ord.id returning * into ord;
    update public.listings set status = 'sold' where id = item.id;
  elsif p_action = 'payment_failed' then
    if ord.status <> 'awaiting_payment' then return to_jsonb(ord); end if;
    update public.orders set status = 'cancelled' where id = ord.id returning * into ord;
    update public.listings set status = 'active' where id = item.id and status = 'reserved';
  elsif p_action = 'mark_delivered' then
    if ord.status <> 'dispatched' then return to_jsonb(ord); end if;
    update public.orders set status = 'delivered', delivered_at = now(),
        release_at = now() + make_interval(hours => s.hold_hours)
      where id = ord.id returning * into ord;
  elsif p_action = 'released' then
    if ord.funds = 'released' then return to_jsonb(ord); end if;
    if ord.funds <> 'release_due' then raise exception 'Funds are not due for release' using errcode = '23514'; end if;
    update public.orders set funds = 'released', transfer_ref = p_ref where id = ord.id returning * into ord;
  elsif p_action = 'refunded' then
    if ord.funds = 'refunded' then return to_jsonb(ord); end if;
    if ord.funds <> 'refund_due' then raise exception 'No refund is due' using errcode = '23514'; end if;
    update public.orders set funds = 'refunded', refund_ref = p_ref where id = ord.id returning * into ord;
  elsif p_action = 'chargeback' then
    -- The buyer's bank disputed the charge. Freeze anything not yet released;
    -- if already released, the event is still recorded for support.
    if ord.funds = 'held' and ord.status in ('paid', 'dispatched', 'delivered') then
      update public.orders set status = 'disputed', release_at = null,
          issue = coalesce(issue, 'Card dispute opened with the payment provider')
        where id = ord.id returning * into ord;
    end if;
  elsif p_action = 'resolve_release' then
    if ord.status <> 'disputed' or ord.funds <> 'held' then raise exception 'Order is not in dispute' using errcode = '23514'; end if;
    update public.orders set status = 'completed', funds = 'release_due', completed_at = now()
      where id = ord.id returning * into ord;
  elsif p_action = 'resolve_refund' then
    -- Support refund of any order still holding funds. Before dispatch the item
    -- goes back on sale; afterwards the seller relists once it is returned.
    if ord.funds <> 'held' then raise exception 'No held funds to refund' using errcode = '23514'; end if;
    update public.listings set status = case when ord.status = 'paid' then 'active' else 'archived' end where id = item.id;
    update public.orders set status = 'cancelled', funds = 'refund_due' where id = ord.id returning * into ord;
  else
    raise exception 'Invalid system action' using errcode = '22023';
  end if;
  perform private.log_order(ord, null, p_action, p_ref);
  return to_jsonb(ord);
end;
$$;
revoke all on function public.order_system(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.order_system(text, uuid, text, text) to service_role;

-- Time-based rules. Safe to run as often as wanted.
create function public.order_sweep() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s private.marketplace_settings;
  ord public.orders;
  n_expired integer := 0; n_undispatched integer := 0; n_delivered integer := 0; n_released integer := 0;
begin
  select * into s from private.marketplace_settings where singleton;
  for ord in select * from public.orders where status = 'awaiting_payment' and expires_at <= now() for update skip locked loop
    update public.orders set status = 'expired' where id = ord.id returning * into ord;
    update public.listings set status = 'active' where id = ord.listing_id and status = 'reserved';
    perform private.log_order(ord, null, 'expire');
    n_expired := n_expired + 1;
  end loop;
  for ord in select * from public.orders where status = 'paid' and dispatch_by <= now() for update skip locked loop
    update public.orders set status = 'cancelled', funds = 'refund_due' where id = ord.id returning * into ord;
    update public.listings set status = 'active' where id = ord.listing_id and status = 'sold';
    perform private.log_order(ord, null, 'not_dispatched_refund');
    n_undispatched := n_undispatched + 1;
  end loop;
  for ord in select * from public.orders where status = 'dispatched'
      and dispatched_at <= now() - make_interval(days => s.delivery_timeout_days) for update skip locked loop
    update public.orders set status = 'delivered', delivered_at = now(),
        release_at = now() + make_interval(hours => s.hold_hours)
      where id = ord.id returning * into ord;
    perform private.log_order(ord, null, 'assume_delivered');
    n_delivered := n_delivered + 1;
  end loop;
  for ord in select * from public.orders where status = 'delivered' and release_at <= now() for update skip locked loop
    update public.orders set status = 'completed', funds = 'release_due', completed_at = now()
      where id = ord.id returning * into ord;
    perform private.log_order(ord, null, 'hold_elapsed');
    n_released := n_released + 1;
  end loop;
  return jsonb_build_object('expired', n_expired, 'not_dispatched', n_undispatched,
    'assumed_delivered', n_delivered, 'release_due', n_released);
end;
$$;
revoke all on function public.order_sweep() from public, anon, authenticated;
grant execute on function public.order_sweep() to service_role;

commit;
