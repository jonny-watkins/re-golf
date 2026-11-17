begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 70),
  brand text not null check (char_length(btrim(brand)) between 1 and 40),
  category text not null check (category in ('Drivers', 'Irons', 'Putters', 'Wedges', 'Woods', 'Bags & gear')),
  condition text not null check (condition in ('New', 'Very good', 'Good', 'Well played')),
  price_pence integer not null check (price_pence between 100 and 2000000),
  location text not null check (char_length(btrim(location)) between 1 and 40),
  description text not null default '' check (char_length(description) <= 2000),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index listings_active_created on public.listings (created_at desc, id) where status = 'active';
create index listings_seller_created on public.listings (seller_id, created_at desc, id);

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger listings_updated before update on public.listings for each row execute function public.set_updated_at();

create function public.create_user_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 60), ''), 'Golfer'));
  return new;
end;
$$;
create trigger create_profile_after_signup after insert on auth.users
for each row execute function public.create_user_profile();
-- Support projects with accounts created before this migration was applied.
insert into public.profiles (id, display_name)
select id, coalesce(nullif(left(btrim(raw_user_meta_data ->> 'display_name'), 60), ''), 'Golfer') from auth.users;

create function public.is_verified_seller() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id = (select auth.uid()) and email_confirmed_at is not null);
$$;
revoke all on function public.create_user_profile() from public;
revoke all on function public.set_updated_at() from public;
revoke all on function public.is_verified_seller() from public;
grant execute on function public.is_verified_seller() to authenticated;

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
revoke all on public.profiles, public.listings from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.listings to anon, authenticated;
grant insert (seller_id, name, brand, category, condition, price_pence, location, description) on public.listings to authenticated;
grant update (name, brand, category, condition, price_pence, location, description, status) on public.listings to authenticated;

create policy profiles_read_own on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy listings_public_read on public.listings for select to anon, authenticated using (status = 'active');
create policy listings_owner_read on public.listings for select to authenticated using (seller_id = (select auth.uid()));
create policy listings_owner_insert on public.listings for insert to authenticated
with check (seller_id = (select auth.uid()) and status = 'active' and (select public.is_verified_seller()));
create policy listings_owner_update on public.listings for update to authenticated
using (seller_id = (select auth.uid()) and (select public.is_verified_seller()))
with check (seller_id = (select auth.uid()) and (select public.is_verified_seller()));

commit;
