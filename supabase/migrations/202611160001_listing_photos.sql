begin;

alter table public.listings
  add column handedness text check (handedness in ('Right','Left','Ambidextrous')),
  add column shaft_flex text check (shaft_flex in ('Ladies','Senior','Regular','Stiff','Extra stiff','Uniflex')),
  add column loft numeric check (loft between 1 and 90 and mod(loft, 0.5) = 0);
grant insert (handedness, shaft_flex, loft), update (handedness, shaft_flex, loft) on public.listings to authenticated;

create table public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  position integer not null check (position between 0 and 5),
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  unique (listing_id, position) deferrable initially deferred
);
alter table public.listing_photos enable row level security;
revoke all on public.listing_photos from anon, authenticated;
grant select on public.listing_photos to anon, authenticated;
grant all on public.listing_photos to service_role;
create policy photos_visible on public.listing_photos for select to anon, authenticated
using (ready and exists (select 1 from public.listings l where l.id = listing_id));

-- Only the server can write objects. The API checks ownership and decodes every upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-photos', 'listing-photos', false, 8388608, array['image/webp']);
-- Restrictive policies also protect this bucket if broader storage policies exist.
create policy listing_photos_no_client_access on storage.objects as restrictive
for all to anon, authenticated
using (bucket_id <> 'listing-photos') with check (bucket_id <> 'listing-photos');

create table public.photo_cleanup (
  path text primary key,
  created_at timestamptz not null default now()
);
alter table public.photo_cleanup enable row level security;
revoke all on public.photo_cleanup from anon, authenticated;
grant all on public.photo_cleanup to service_role;
create function public.queue_photo_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.photo_cleanup(path) values (old.listing_id::text || '/' || old.id::text || '.webp') on conflict do nothing;
  return old;
end;
$$;
revoke all on function public.queue_photo_cleanup() from public;
create trigger photo_cleanup_after_delete after delete on public.listing_photos
for each row execute function public.queue_photo_cleanup();

-- All photo changes lock the parent, so simultaneous uploads cannot exceed six.
create function public.manage_listing_photo(p_listing uuid, p_seller uuid, p_photo uuid, p_action text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_position integer; v_first integer;
begin
  perform 1 from public.listings l join auth.users u on u.id = l.seller_id
    where l.id = p_listing and l.seller_id = p_seller and l.status = 'active' and u.email_confirmed_at is not null
    for update of l;
  if not found then raise exception 'Listing unavailable' using errcode = '42501'; end if;
  if p_action = 'reserve' then
    -- Compact gaps left by abandoned uploads without changing the chosen main photo.
    with ordered as (select id, (row_number() over(order by position) - 1)::integer as n
      from public.listing_photos where listing_id = p_listing)
    update public.listing_photos p set position = ordered.n from ordered where p.id = ordered.id;
    select n into v_position from generate_series(0,5) n
      where not exists (select 1 from public.listing_photos where listing_id = p_listing and position = n)
      order by n limit 1;
    if v_position is null then raise exception 'Maximum six photos' using errcode = '23514'; end if;
    insert into public.listing_photos(listing_id, position) values(p_listing, v_position) returning id into v_id;
    return v_id;
  end if;
  select position into v_position from public.listing_photos where id = p_photo and listing_id = p_listing;
  if not found then raise exception 'Photo unavailable' using errcode = 'P0002'; end if;
  if p_action = 'complete' then
    update public.listing_photos set ready = true where id = p_photo;
  elsif p_action = 'remove' then
    delete from public.listing_photos where id = p_photo;
    with ordered as (select id, (row_number() over(order by position) - 1)::integer as n
      from public.listing_photos where listing_id = p_listing)
    update public.listing_photos p set position = ordered.n from ordered where p.id = ordered.id;
  elsif p_action = 'main' then
    if not exists (select 1 from public.listing_photos where id = p_photo and ready) then
      raise exception 'Photo not ready' using errcode = 'P0002';
    end if;
    select min(position) into v_first from public.listing_photos where listing_id = p_listing and ready;
    update public.listing_photos set position = case when id = p_photo then v_first else v_position end
      where listing_id = p_listing and (id = p_photo or position = v_first);
  else
    raise exception 'Invalid photo action';
  end if;
  return p_photo;
end;
$$;
revoke all on function public.manage_listing_photo(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.manage_listing_photo(uuid,uuid,uuid,text) to service_role;

create function public.prune_pending_photos() returns void
language sql security definer set search_path = '' as $$
  delete from public.listing_photos where not ready and created_at < now() - interval '1 hour';
$$;
revoke all on function public.prune_pending_photos() from public, anon, authenticated;
grant execute on function public.prune_pending_photos() to service_role;
commit;
