begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.favourites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  created_at timestamptz not null default now(), primary key(user_id, listing_id)
);
create index favourites_user_created on public.favourites(user_id, created_at desc, listing_id);
create index favourites_listing on public.favourites(listing_id);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id),
  buyer_id uuid not null references public.profiles(id),
  seller_id uuid not null references public.profiles(id),
  listing_title text not null,
  created_at timestamptz not null default now(),
  unique(listing_id,buyer_id), check(buyer_id <> seller_id)
);
create index conversations_buyer on public.conversations(buyer_id,created_at desc,id);
create index conversations_seller on public.conversations(seller_id,created_at desc,id);
create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id),
  sender_id uuid not null references public.profiles(id),
  client_id uuid not null,
  body text not null check(char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(), unique(sender_id,client_id)
);
create index messages_thread on public.messages(conversation_id,id desc);
create index messages_sender_time on public.messages(sender_id,created_at desc);
create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id),
  blocked_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key(blocker_id,blocked_id), check(blocker_id <> blocked_id)
);
create index blocks_target on public.user_blocks(blocked_id,blocker_id);
create table public.conversation_reports (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id),
  reporter_id uuid not null references public.profiles(id),
  reason text not null check(reason in ('spam','harassment','scam','other')),
  details text not null check(char_length(btrim(details)) between 1 and 2000),
  status text not null default 'open' check(status in ('open','reviewed','resolved')),
  created_at timestamptz not null default now(),
  unique(conversation_id,reporter_id)
);
create index reports_reporter on public.conversation_reports(reporter_id,created_at desc);
create index reports_open on public.conversation_reports(created_at) where status = 'open';

alter table public.favourites enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.user_blocks enable row level security;
alter table public.conversation_reports enable row level security;
revoke all on public.favourites,public.conversations,public.messages,public.user_blocks,public.conversation_reports from public,anon,authenticated;
grant select on public.favourites,public.conversations,public.messages,public.user_blocks,public.conversation_reports to authenticated;
grant insert(user_id,listing_id) on public.favourites to authenticated;
grant delete on public.favourites to authenticated;
grant insert(listing_id,buyer_id,seller_id) on public.conversations to authenticated;
grant insert(conversation_id,sender_id,body,client_id) on public.messages to authenticated;
grant insert(blocker_id,blocked_id) on public.user_blocks to authenticated;
grant delete on public.user_blocks to authenticated;
grant insert(conversation_id,reporter_id,reason,details) on public.conversation_reports to authenticated;
grant usage on sequence public.messages_id_seq to authenticated;
grant all on public.favourites,public.conversations,public.messages,public.user_blocks,public.conversation_reports to service_role;
grant usage, select on sequence public.messages_id_seq to service_role;

create policy favourites_read on public.favourites for select to authenticated using(user_id=(select auth.uid()));
create policy favourites_add on public.favourites for insert to authenticated with check(
  user_id=(select auth.uid()) and (select public.is_verified_seller()) and exists(select 1 from public.listings l where l.id=listing_id and l.status='active')
);
create policy favourites_remove on public.favourites for delete to authenticated using(user_id=(select auth.uid()));
create policy conversations_read on public.conversations for select to authenticated using((select auth.uid()) in (buyer_id,seller_id));
create policy conversations_add on public.conversations for insert to authenticated with check(
  buyer_id=(select auth.uid()) and (select public.is_verified_seller())
  and exists(select 1 from public.listings l where l.id=listing_id and l.seller_id=conversations.seller_id and l.status='active')
);
create policy messages_read on public.messages for select to authenticated using(
  exists(select 1 from public.conversations c where c.id=conversation_id and (select auth.uid()) in(c.buyer_id,c.seller_id))
);
create policy messages_add on public.messages for insert to authenticated with check(
  sender_id=(select auth.uid()) and (select public.is_verified_seller()) and
  exists(select 1 from public.conversations c where c.id=conversation_id and (select auth.uid()) in(c.buyer_id,c.seller_id))
);
-- Block status is visible only to the two affected people; only its creator can remove it.
create policy blocks_read on public.user_blocks for select to authenticated using((select auth.uid()) in(blocker_id,blocked_id));
create policy blocks_add on public.user_blocks for insert to authenticated with check(
  blocker_id=(select auth.uid()) and (select public.is_verified_seller()) and exists(
    select 1 from public.conversations c where (c.buyer_id=blocker_id and c.seller_id=blocked_id) or (c.seller_id=blocker_id and c.buyer_id=blocked_id))
);
create policy blocks_remove on public.user_blocks for delete to authenticated using(blocker_id=(select auth.uid()));
create policy reports_read on public.conversation_reports for select to authenticated using(reporter_id=(select auth.uid()));
create policy reports_add on public.conversation_reports for insert to authenticated with check(
  reporter_id=(select auth.uid()) and (select public.is_verified_seller()) and exists(
    select 1 from public.conversations c where c.id=conversation_id and (select auth.uid()) in(c.buyer_id,c.seller_id))
);

-- Invoker triggers preserve RLS. Pair locks serialize message/block writes;
-- actor locks prevent concurrent requests from bypassing per-account limits.
create function private.guard_social_write() returns trigger language plpgsql set search_path='' as $$
declare actor uuid := auth.uid(); a uuid; b uuid; thread public.conversations; n integer;
begin
  if actor is null or not public.is_verified_seller() then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended('social-actor:'||actor::text,0));
  if tg_table_name='conversations' then
    if new.buyer_id<>actor then raise insufficient_privilege; end if;
    a:=new.buyer_id; b:=new.seller_id;
    select l.brand||' '||l.name into new.listing_title from public.listings l where l.id=new.listing_id and l.seller_id=b and l.status='active';
    if new.listing_title is null then raise insufficient_privilege; end if;
    select count(*) into n from public.conversations where buyer_id=actor and created_at>now()-interval '1 hour';
    if n>=10 then raise exception 'Rate limit'; end if;
  elsif tg_table_name='messages' then
    if new.sender_id<>actor then raise insufficient_privilege; end if;
    select * into thread from public.conversations where id=new.conversation_id;
    if thread.id is null or actor not in(thread.buyer_id,thread.seller_id) then raise insufficient_privilege; end if;
    a:=thread.buyer_id; b:=thread.seller_id;
    select count(*) into n from public.messages where sender_id=actor and created_at>now()-interval '1 minute';
    if n>=20 then raise exception 'Rate limit'; end if;
  elsif tg_table_name='user_blocks' then
    if tg_op='DELETE' then a:=old.blocker_id; b:=old.blocked_id; else a:=new.blocker_id; b:=new.blocked_id; end if;
    if a<>actor then raise insufficient_privilege; end if;
  elsif tg_table_name='conversation_reports' then
    if new.reporter_id<>actor then raise insufficient_privilege; end if;
    select count(*) into n from public.conversation_reports where reporter_id=actor and created_at>now()-interval '1 hour';
    if n>=5 then raise exception 'Rate limit'; end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('social-pair:'||least(a,b)::text||greatest(a,b)::text,0));
  if tg_table_name in ('messages','conversations') and exists(select 1 from public.user_blocks where (blocker_id=a and blocked_id=b) or (blocker_id=b and blocked_id=a)) then
    raise insufficient_privilege;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_social_write() from public,anon,authenticated;
create trigger conversations_guard before insert on public.conversations for each row execute function private.guard_social_write();
create trigger messages_guard before insert on public.messages for each row execute function private.guard_social_write();
create trigger blocks_guard before insert or delete on public.user_blocks for each row execute function private.guard_social_write();
create trigger reports_guard before insert on public.conversation_reports for each row execute function private.guard_social_write();
commit;
