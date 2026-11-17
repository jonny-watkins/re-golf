-- Account suspension and deletion, and the queue of emails to send.
-- Run once, after 20261117180000_support_and_clawback.sql.
begin;

-- 1. Suspended or deleted accounts keep their history but can no longer act.
alter table public.profiles
  add column suspended_at timestamptz,
  add column deleted_at timestamptz;

-- Every "may this person list, message, save or report" rule already calls this function,
-- so tightening it here applies suspension everywhere at once.
create or replace function public.is_verified_seller() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.profiles p on p.id = u.id
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null
      and p.suspended_at is null and p.deleted_at is null);
$$;

-- New purchases are refused if either side is suspended or deleted. Orders already
-- under way carry on, so nobody's money or parcel is stranded.
create function private.guard_order_parties() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.profiles where id in (new.buyer_id, new.seller_id)
      and (suspended_at is not null or deleted_at is not null)) then
    raise exception 'This item cannot be bought at the moment' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_order_parties() from public, anon, authenticated;
create trigger orders_party_guard before insert on public.orders
  for each row execute function private.guard_order_parties();

-- 2. Emails are queued here by the database and sent by the server, so a slow or failing
-- email provider can never block a payment, a message or an order step.
create table public.email_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  template text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index email_outbox_pending on public.email_outbox (id) where sent_at is null;
alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.email_outbox to service_role;

create function private.queue_order_email() returns trigger
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
  elsif new.action in ('accept', 'hold_elapsed', 'resolve_release') then to_seller := 'order_completed';
  elsif new.action = 'released' then to_seller := 'order_paid_out';
  elsif new.action = 'report_issue' then to_seller := 'order_issue';
  elsif new.action in ('not_dispatched_refund', 'resolve_refund') then to_buyer := 'order_refunding'; to_seller := 'order_cancelled';
  elsif new.action = 'late_payment_refund' then to_buyer := 'order_refunding';
  elsif new.action = 'refunded' then to_buyer := 'order_refunded';
  else return new;
  end if;
  info := jsonb_build_object('order_id', o.id, 'title', o.title, 'total_pence', o.total_pence,
    'seller_pence', o.item_pence + o.delivery_pence, 'tracking', o.tracking,
    'dispatch_by', o.dispatch_by, 'release_at', o.release_at);
  if to_buyer is not null then insert into public.email_outbox (user_id, template, data) values (o.buyer_id, to_buyer, info); end if;
  if to_seller is not null then insert into public.email_outbox (user_id, template, data) values (o.seller_id, to_seller, info); end if;
  return new;
end;
$$;
revoke all on function private.queue_order_email() from public, anon, authenticated;
create trigger order_events_email after insert on public.order_events
  for each row execute function private.queue_order_email();

-- A new message emails the other person, at most once an hour per conversation.
create function private.queue_message_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  thread public.conversations;
  recipient uuid;
begin
  select * into thread from public.conversations where id = new.conversation_id;
  recipient := case when new.sender_id = thread.buyer_id then thread.seller_id else thread.buyer_id end;
  if not exists (select 1 from public.email_outbox where user_id = recipient and template = 'new_message'
      and data ->> 'conversation_id' = thread.id::text and created_at > now() - interval '1 hour') then
    insert into public.email_outbox (user_id, template, data)
      values (recipient, 'new_message', jsonb_build_object('conversation_id', thread.id, 'title', thread.listing_title));
  end if;
  return new;
end;
$$;
revoke all on function private.queue_message_email() from public, anon, authenticated;
create trigger messages_email after insert on public.messages
  for each row execute function private.queue_message_email();

commit;
