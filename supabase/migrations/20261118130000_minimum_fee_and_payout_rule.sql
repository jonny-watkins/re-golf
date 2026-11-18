-- A minimum buyer fee, and items can only be bought from sellers who can be paid.
-- Run once, after 20261118100000_order_returns.sql.
--
-- The fee stays at a fixed amount plus a percentage, but is never less than
-- fee_min_pence: below that, card processing and payout costs exceed the fee.
-- A buyer cannot start an order until the seller has finished payout setup, so
-- money is never held for a seller who cannot receive it.
begin;

alter table private.marketplace_settings
  add column fee_min_pence integer not null default 300 check (fee_min_pence between 0 and 100000),
  add column require_payouts boolean not null default true;

create or replace function private.order_fee(p_item integer, s private.marketplace_settings) returns integer
language sql immutable set search_path = '' as $$
  select greatest(s.fee_min_pence, s.fee_fixed_pence + round(p_item::numeric * s.fee_bps / 10000)::integer);
$$;

-- Server-only switch for the payout rule (used by the automated checks).
create function public.set_require_payouts(p_required boolean) returns jsonb
language sql security definer set search_path = '' as $$
  update private.marketplace_settings set require_payouts = p_required where singleton;
  select public.marketplace_settings();
$$;
revoke all on function public.set_require_payouts(boolean) from public, anon, authenticated;
grant execute on function public.set_require_payouts(boolean) to service_role;

-- Buyer and seller actions, unchanged except for the payout rule on quote and reserve.
create or replace function public.order_action(p_action text, p_listing uuid default null, p_request uuid default null,
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
    if s.require_payouts and not exists (select 1 from public.seller_accounts a
        where a.seller_id = item.seller_id and a.payouts_enabled) then
      raise exception 'The seller has not finished setting up payments, so this item cannot be bought yet' using errcode = '23514';
    end if;
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

commit;
