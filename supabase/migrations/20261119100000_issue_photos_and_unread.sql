-- Photos with a reported problem, and knowing which conversations have unread messages.
-- Run once, after 20261118130000_minimum_fee_and_payout_rule.sql.
--
-- While a problem is open on an order, the buyer and the seller can each add up to four photos
-- (damage on arrival, what came back). The files are stored privately and served by the server,
-- which checks the viewer is the buyer, the seller or support.
-- Each person's place in each conversation is remembered, so the site can show unread messages.
begin;

-- 1. Photos of a reported problem. Rows are created only by the server.
create table public.order_issue_photos (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  uploader_id uuid not null,
  ready boolean not null default false,
  created_at timestamptz not null default now()
);
create index order_issue_photos_order on public.order_issue_photos (order_id, created_at);
alter table public.order_issue_photos enable row level security;
revoke all on public.order_issue_photos from public, anon, authenticated;
grant select on public.order_issue_photos to authenticated;
grant all on public.order_issue_photos to service_role;
create policy order_issue_photos_participants on public.order_issue_photos for select to authenticated
  using (ready and exists (select 1 from public.orders o
    where o.id = order_id and (select auth.uid()) in (o.buyer_id, o.seller_id)));

-- Reserves a place for one photo. The server uploads the file and then marks it ready.
create function public.add_issue_photo(p_order uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ord public.orders;
  made uuid;
begin
  select * into ord from public.orders where id = p_order and p_user in (buyer_id, seller_id) for update;
  if not found then raise exception 'Order unavailable' using errcode = 'P0002'; end if;
  if ord.status <> 'disputed' then
    raise exception 'Photos can only be added while a problem is open on the order' using errcode = '23514';
  end if;
  -- Uploads that never finished do not count against the limit.
  delete from public.order_issue_photos
    where order_id = p_order and not ready and created_at < now() - interval '10 minutes';
  if (select count(*) from public.order_issue_photos where order_id = p_order and uploader_id = p_user) >= 4 then
    raise exception 'You can add up to four photos' using errcode = '23514';
  end if;
  insert into public.order_issue_photos (order_id, uploader_id) values (p_order, p_user) returning id into made;
  return made;
end;
$$;
revoke all on function public.add_issue_photo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_issue_photo(uuid, uuid) to service_role;

-- 2. Unread messages: the last message each person has seen in each conversation.
create table public.conversation_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null,
  last_read_id bigint not null default 0,
  primary key (conversation_id, user_id)
);
alter table public.conversation_reads enable row level security;
revoke all on public.conversation_reads from public, anon, authenticated;
grant select, insert (conversation_id, user_id, last_read_id), update (last_read_id)
  on public.conversation_reads to authenticated;
grant all on public.conversation_reads to service_role;
create policy conversation_reads_own on public.conversation_reads for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.conversations c
    where c.id = conversation_id and (select auth.uid()) in (c.buyer_id, c.seller_id)));

-- Everything sent before this change counts as already read.
insert into public.conversation_reads (conversation_id, user_id, last_read_id)
  select c.id, person, latest.id
  from public.conversations c
  cross join lateral (select max(m.id) as id from public.messages m where m.conversation_id = c.id) latest
  cross join lateral (values (c.buyer_id), (c.seller_id)) people(person)
  where latest.id is not null;

-- The caller's conversations that hold a message from the other person newer than their place.
-- Runs with the caller's own access, so row-level security still applies.
create function public.unread_conversations() returns setof uuid
language sql stable set search_path = '' as $$
  select c.id from public.conversations c
  where (select auth.uid()) in (c.buyer_id, c.seller_id)
    and exists (select 1 from public.messages m
      where m.conversation_id = c.id and m.sender_id <> (select auth.uid())
        and m.id > coalesce((select r.last_read_id from public.conversation_reads r
          where r.conversation_id = c.id and r.user_id = (select auth.uid())), 0))
  limit 100;
$$;
revoke all on function public.unread_conversations() from public, anon;
grant execute on function public.unread_conversations() to authenticated, service_role;

commit;
