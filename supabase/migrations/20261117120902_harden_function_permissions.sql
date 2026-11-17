begin;

-- Supabase defaults grant client roles explicitly; revoking PUBLIC alone is insufficient.
-- Existing triggers continue to run without client EXECUTE permission.
revoke execute on function public.create_user_profile() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.queue_photo_cleanup() from public, anon, authenticated;

-- RLS and social-write guards need this current-user-only check for signed-in users.
revoke execute on function public.is_verified_seller() from public, anon;
grant execute on function public.is_verified_seller() to authenticated;

commit;
