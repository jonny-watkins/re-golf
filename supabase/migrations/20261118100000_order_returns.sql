-- Settling a reported problem between buyer and seller, with a tracked return.
-- Run once, after 20261117210000_accounts_and_emails.sql.
--
-- Once a buyer reports a problem the payment is frozen (existing behaviour). Now:
--   the seller may refund straight away, or ask for the item back at an address they give;
--   the buyer posts it back with tracking by a deadline, or the seller is paid;
--   the seller confirms it is back and the buyer is refunded, or the refund happens
--     automatically once the return has had time to arrive;
--   the buyer may withdraw the problem; either side may ask support to decide.
-- As before, nothing here moves money: it only sets what the server worker should do.
begin;

alter table private.marketplace_settings
  add column return_days integer not null default 5 check (return_days between 1 and 30);

alter table public.orders
  add column return_address text check (char_length(return_address) <= 300),
  add column return_by timestamptz,
  add column return_tracking text check (char_length(return_tracking) <= 100),
  add column return_posted_at timestamptz,
  add column return_escalated_at timestamptz;

-- The seller's return address is only needed while the problem is open.
create function private.clear_return_address() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status <> 'disputed' then new.return_address := null; end if;
  return new;
end;
$$;
revoke all on function private.clear_return_address() from public, anon, authenticated;
create trigger orders_return_address before update on public.orders
  for each row execute function private.clear_return_address();

-- A card dispute or a stopped payout is for support only: a refund agreed between the
-- two parties on top of the bank's own refund would pay the buyer twice.
create function private.order_with_bank(p_order uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.order_events where order_id = p_order
    and action in ('chargeback', 'payout_stopped', 'clawback_started'));
$$;
revoke all on function private.order_with_bank(uuid) from public, anon, authenticated;

create function public.order_return(p_action text, p_order uuid, p_text text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  s private.marketplace_settings;
  ord public.orders;
  note text := nullif(btrim(coalesce(p_text, '')), '');
begin
  if actor is null or not exists (select 1 from auth.users where id = actor and email_confirmed_at is not null) then
    raise exception 'Confirm your email before buying or selling' using errcode = '42501';
  end if;
  select * into s from private.marketplace_settings where singleton;
  select * into ord from public.orders where id = p_order and actor in (buyer_id, seller_id) for update;
  if not found then raise exception 'Order unavailable' using errcode = 'P0002'; end if;
  if ord.status <> 'disputed' or ord.funds <> 'held' then
    raise exception 'This order has no open problem to settle' using errcode = '23514';
  end if;
  if private.order_with_bank(ord.id) then
    raise exception 'Relofted support is handling this order' using errcode = '42501';
  end if;

  if p_action = 'withdraw' then
    -- The buyer is satisfied after all: the sale completes and the seller is paid.
    if actor <> ord.buyer_id then raise exception 'Buyer action only' using errcode = '42501'; end if;
    if ord.return_posted_at is not null then
      raise exception 'You have already posted the item back' using errcode = '23514';
    end if;
    update public.orders set status = 'completed', funds = 'release_due', completed_at = now()
      where id = ord.id returning * into ord;
  elsif p_action = 'refund' then
    -- The seller refunds: either without wanting the item back, or because it has come back.
    if actor <> ord.seller_id then raise exception 'Seller action only' using errcode = '42501'; end if;
    update public.listings set status = 'archived' where id = ord.listing_id;
    update public.orders set status = 'cancelled', funds = 'refund_due' where id = ord.id returning * into ord;
  elsif p_action = 'request_return' then
    if actor <> ord.seller_id then raise exception 'Seller action only' using errcode = '42501'; end if;
    if ord.return_by is not null then return to_jsonb(ord); end if;
    if ord.return_escalated_at is not null then
      raise exception 'Relofted support is deciding this order' using errcode = '23514';
    end if;
    if note is null or char_length(note) < 10 then
      raise exception 'Enter the address the item should be sent back to' using errcode = '22023';
    end if;
    update public.orders set return_address = left(note, 300), return_by = now() + make_interval(days => s.return_days)
      where id = ord.id returning * into ord;
    note := null;  -- the address is not copied into the order history
  elsif p_action = 'return_posted' then
    if actor <> ord.buyer_id then raise exception 'Buyer action only' using errcode = '42501'; end if;
    if ord.return_posted_at is not null then return to_jsonb(ord); end if;
    if ord.return_by is null then
      raise exception 'The seller has not asked for the item back' using errcode = '23514';
    end if;
    if note is null or char_length(note) < 6 then
      raise exception 'Enter the carrier and tracking number' using errcode = '22023';
    end if;
    update public.orders set return_tracking = left(note, 100), return_posted_at = now()
      where id = ord.id returning * into ord;
  elsif p_action = 'escalate' then
    -- Either side asks support to decide. This stops the automatic return deadlines.
    if ord.return_escalated_at is not null then return to_jsonb(ord); end if;
    if note is null then raise exception 'Say what you need Relofted to decide' using errcode = '22023'; end if;
    update public.orders set return_escalated_at = now() where id = ord.id returning * into ord;
  else
    raise exception 'Invalid order action' using errcode = '22023';
  end if;
  perform private.log_order(ord, actor,
    case p_action when 'withdraw' then 'withdraw_issue' when 'refund' then 'seller_refund' else p_action end,
    left(note, 2000));
  return to_jsonb(ord);
end;
$$;
revoke all on function public.order_return(text, uuid, text) from public, anon, authenticated;
grant execute on function public.order_return(text, uuid, text) to authenticated;

-- Time-based rules, now including return deadlines. Safe to run as often as wanted.
create or replace function public.order_sweep() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s private.marketplace_settings;
  ord public.orders;
  n_expired integer := 0; n_undispatched integer := 0; n_delivered integer := 0; n_released integer := 0;
  n_not_returned integer := 0; n_returned integer := 0;
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
  -- The buyer was asked to send the item back and did not: the seller is paid.
  for ord in select * from public.orders o where status = 'disputed' and funds = 'held'
      and return_escalated_at is null and return_posted_at is null and return_by <= now()
      and not private.order_with_bank(o.id) for update skip locked loop
    update public.orders set status = 'completed', funds = 'release_due', completed_at = now()
      where id = ord.id returning * into ord;
    perform private.log_order(ord, null, 'return_not_posted');
    n_not_returned := n_not_returned + 1;
  end loop;
  -- The return has had time to arrive and the seller has not raised a problem: refund.
  for ord in select * from public.orders o where status = 'disputed' and funds = 'held'
      and return_escalated_at is null
      and return_posted_at <= now() - make_interval(days => s.delivery_timeout_days)
      and not private.order_with_bank(o.id) for update skip locked loop
    update public.listings set status = 'archived' where id = ord.listing_id;
    update public.orders set status = 'cancelled', funds = 'refund_due' where id = ord.id returning * into ord;
    perform private.log_order(ord, null, 'return_assumed');
    n_returned := n_returned + 1;
  end loop;
  return jsonb_build_object('expired', n_expired, 'not_dispatched', n_undispatched,
    'assumed_delivered', n_delivered, 'release_due', n_released,
    'return_not_posted', n_not_returned, 'return_assumed', n_returned);
end;
$$;

-- Emails for the new steps.
create or replace function private.queue_order_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders;
  info jsonb;
  to_buyer text;
  to_seller text;
begin
  select * into o from public.orders where id = new.order_id;
  if new.action = 'payment_succeeded' then to_buyer := 'order_paid'; to_seller := 'order_sold';
  elsif new.action = 'dispatch' then to_buyer := 'order_posted';
  elsif new.action = 'confirm_delivery' then to_seller := 'order_delivered';
  elsif new.action in ('assume_delivered', 'mark_delivered') then to_buyer := 'order_check'; to_seller := 'order_delivered';
  elsif new.action in ('accept', 'hold_elapsed', 'resolve_release', 'withdraw_issue') then to_seller := 'order_completed';
  elsif new.action = 'released' then to_seller := 'order_paid_out';
  elsif new.action = 'report_issue' then to_seller := 'order_issue';
  elsif new.action = 'request_return' then to_buyer := 'return_requested';
  elsif new.action = 'return_posted' then to_seller := 'return_posted';
  elsif new.action = 'return_not_posted' then to_buyer := 'return_expired'; to_seller := 'order_completed';
  elsif new.action in ('not_dispatched_refund', 'resolve_refund', 'seller_refund', 'return_assumed') then
    to_buyer := 'order_refunding'; to_seller := 'order_cancelled';
  elsif new.action = 'late_payment_refund' then to_buyer := 'order_refunding';
  elsif new.action = 'refunded' then to_buyer := 'order_refunded';
  else return new;
  end if;
  info := jsonb_build_object('order_id', o.id, 'title', o.title, 'total_pence', o.total_pence,
    'seller_pence', o.item_pence + o.delivery_pence, 'tracking', o.tracking,
    'dispatch_by', o.dispatch_by, 'release_at', o.release_at,
    'return_by', o.return_by, 'return_tracking', o.return_tracking);
  if to_buyer is not null then insert into public.email_outbox (user_id, template, data) values (o.buyer_id, to_buyer, info); end if;
  if to_seller is not null then insert into public.email_outbox (user_id, template, data) values (o.seller_id, to_seller, info); end if;
  return new;
end;
$$;

commit;
