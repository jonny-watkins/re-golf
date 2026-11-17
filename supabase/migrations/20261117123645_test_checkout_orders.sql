begin;
create schema if not exists private;
create table private.test_checkout_settings (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default true,
  fee_pence integer not null check(fee_pence between 0 and 100000),
  delivery_pence integer not null check(delivery_pence between 0 and 100000)
);
insert into private.test_checkout_settings values(true,true,250,595);
alter table private.test_checkout_settings enable row level security;
revoke all on private.test_checkout_settings from public,anon,authenticated;

-- Isolated inventory: simulated purchases never reserve or sell real listings.
create table public.test_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check(char_length(btrim(title)) between 1 and 70),
  price_pence integer not null check(price_pence between 100 and 2000000),
  status text not null default 'active' check(status in ('active','reserved','sold')),
  reserved_until timestamptz,
  created_at timestamptz not null default now()
);
create table public.test_orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.test_listings(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  seller_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  title text not null,
  item_pence integer not null,
  fee_pence integer not null,
  delivery_pence integer not null,
  total_pence integer generated always as (item_pence+fee_pence+delivery_pence) stored,
  status text not null check(status in ('reserved','paid','dispatched','delivered','failed','cancelled','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(buyer_id,request_id),
  check(buyer_id<>seller_id)
);
create unique index test_orders_one_sale on public.test_orders(listing_id)
  where status in ('reserved','paid','dispatched','delivered');
create index test_orders_seller on public.test_orders(seller_id,created_at desc);
create index test_orders_buyer on public.test_orders(buyer_id,created_at desc);
create index test_listings_seller on public.test_listings(seller_id);
alter table public.test_listings enable row level security;
alter table public.test_orders enable row level security;
revoke all on public.test_listings,public.test_orders from public,anon,authenticated;
grant select on public.test_listings,public.test_orders to authenticated;
grant all on public.test_listings,public.test_orders to service_role;
create policy test_inventory_read on public.test_listings for select to authenticated using(true);
create policy test_order_participants on public.test_orders for select to authenticated
  using(buyer_id=(select auth.uid()) or seller_id=(select auth.uid()));

create function private.test_checkout(p_action text,p_listing uuid,p_request uuid,p_order uuid,p_title text,p_price integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := auth.uid();
  item public.test_listings;
  ord public.test_orders;
  settings private.test_checkout_settings;
begin
  if actor is null or not public.is_verified_seller() then
    raise exception 'Confirm your email before testing checkout' using errcode='42501';
  end if;
  select * into settings from private.test_checkout_settings where singleton;
  if not settings.enabled then raise exception 'Test checkout is disabled' using errcode='42501'; end if;
  if p_action='create' then
    perform pg_advisory_xact_lock(hashtextextended(actor::text,1));
    if (select count(*) from public.test_listings where seller_id=actor and created_at>now()-interval '1 hour')>=10 then
      raise exception 'Test listing limit reached' using errcode='P0001';
    end if;
    insert into public.test_listings(seller_id,title,price_pence) values(actor,p_title,p_price) returning * into item;
    return to_jsonb(item);
  end if;
  if p_action in ('quote','reserve') then
    select * into item from public.test_listings where id=p_listing for update;
  else
    select * into ord from public.test_orders where id=p_order and actor in (buyer_id,seller_id);
    if not found then raise exception 'Order unavailable' using errcode='42501'; end if;
    select * into item from public.test_listings where id=ord.listing_id for update;
  end if;
  if item.id is null then raise exception 'Test listing unavailable' using errcode='42501'; end if;
  update public.test_orders set status='expired',updated_at=now()
    where listing_id=item.id and status='reserved' and expires_at<=now();
  if item.status='reserved' and item.reserved_until<=now() then
    update public.test_listings set status='active',reserved_until=null where id=item.id returning * into item;
  end if;
  if p_action in ('quote','reserve') then
    if item.seller_id=actor then raise exception 'You cannot buy your own listing' using errcode='42501'; end if;
    if p_action='reserve' then
      if p_request is null then raise exception 'Request ID required' using errcode='22023'; end if;
      select * into ord from public.test_orders where buyer_id=actor and request_id=p_request;
      if found then
        if ord.listing_id<>item.id then raise exception 'Request already used' using errcode='23505'; end if;
        return to_jsonb(ord);
      end if;
    end if;
    if item.status<>'active' then raise exception 'Test item already reserved or sold' using errcode='23505'; end if;
    if p_action='quote' then
      return jsonb_build_object('title',item.title,'item_pence',item.price_pence,'fee_pence',settings.fee_pence,
        'delivery_pence',settings.delivery_pence,'total_pence',item.price_pence+settings.fee_pence+settings.delivery_pence);
    end if;
    insert into public.test_orders(listing_id,buyer_id,seller_id,request_id,title,item_pence,fee_pence,delivery_pence,status,expires_at)
      values(item.id,actor,item.seller_id,p_request,item.title,item.price_pence,settings.fee_pence,settings.delivery_pence,'reserved',now()+interval '15 minutes')
      returning * into ord;
    update public.test_listings set status='reserved',reserved_until=ord.expires_at where id=item.id;
    return to_jsonb(ord);
  end if;
  select * into ord from public.test_orders where id=p_order;
  if p_action in ('pay','fail','cancel') then
    if ord.buyer_id<>actor then raise exception 'Buyer action only' using errcode='42501'; end if;
    if (p_action='pay' and ord.status in ('paid','dispatched','delivered'))
      or (p_action='fail' and ord.status='failed') or (p_action='cancel' and ord.status='cancelled') then return to_jsonb(ord); end if;
    if ord.status<>'reserved' then return to_jsonb(ord); end if;
    update public.test_orders set status=case p_action when 'pay' then 'paid' when 'fail' then 'failed' else 'cancelled' end,
      updated_at=now() where id=ord.id returning * into ord;
    update public.test_listings set status=case when p_action='pay' then 'sold' else 'active' end,reserved_until=null where id=item.id;
  elsif p_action='dispatch' then
    if actor<>ord.seller_id then raise exception 'Seller action only' using errcode='42501'; end if;
    if ord.status='paid' then update public.test_orders set status='dispatched',updated_at=now() where id=ord.id returning * into ord;
    elsif ord.status not in ('dispatched','delivered') then raise exception 'Order is not paid' using errcode='23514'; end if;
  elsif p_action='deliver' then
    if actor<>ord.buyer_id then raise exception 'Buyer action only' using errcode='42501'; end if;
    if ord.status='dispatched' then update public.test_orders set status='delivered',updated_at=now() where id=ord.id returning * into ord;
    elsif ord.status<>'delivered' then raise exception 'Order is not dispatched' using errcode='23514'; end if;
  else raise exception 'Invalid test action' using errcode='22023';
  end if;
  return to_jsonb(ord);
end;
$$;
revoke all on function private.test_checkout(text,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant usage on schema private to authenticated;
grant execute on function private.test_checkout(text,uuid,uuid,uuid,text,integer) to authenticated;
create function public.test_checkout(p_action text,p_listing uuid default null,p_request uuid default null,p_order uuid default null,p_title text default null,p_price integer default null)
returns jsonb language sql security invoker set search_path='' as $$
  select private.test_checkout(p_action,p_listing,p_request,p_order,p_title,p_price);
$$;
revoke all on function public.test_checkout(text,uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.test_checkout(text,uuid,uuid,uuid,text,integer) to authenticated;
commit;
