-- Lintel: form capture + persistent rate limiting
-- Run in the Supabase SQL editor, or save to /supabase and apply.

-- ---------------------------------------------------------------
-- 1. Submissions
-- ---------------------------------------------------------------

create table if not exists public.submissions (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'message'
              check (kind in ('message', 'list_signup')),
  payload     jsonb not null,
  ip_hash     text,
  user_agent  text,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);

-- user_id is denormalised from sites so RLS is a single-column check
-- rather than a join on every read.

create index if not exists submissions_user_created_idx
  on public.submissions (user_id, created_at desc);

create index if not exists submissions_site_created_idx
  on public.submissions (site_id, created_at desc);

alter table public.submissions enable row level security;

-- Owners can read their own submissions.
drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own
  on public.submissions for select
  using (auth.uid() = user_id);

-- Owners can delete their own submissions (needed for erasure requests
-- from the visitors who submitted them).
drop policy if exists submissions_delete_own on public.submissions;
create policy submissions_delete_own
  on public.submissions for delete
  using (auth.uid() = user_id);

-- No INSERT policy on purpose. The public capture endpoint writes with
-- the service role, which bypasses RLS. Nothing holding an anon key can
-- write here, so a leaked anon key cannot be used to flood the table.

-- ---------------------------------------------------------------
-- 2. Persistent rate limiting
-- ---------------------------------------------------------------
-- Replaces the in-memory limiter, which is not multi-instance safe on
-- Vercel. Used by the public capture endpoint first, then by the rest
-- of the mutation routes in the security block.

create table if not exists public.rate_limits (
  key          text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);

create index if not exists rate_limits_window_idx
  on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;
-- No policies at all: service role only.

-- Atomically bump a counter and report whether the caller is over the
-- limit. Returns true when the request is ALLOWED.
create or replace function public.check_rate_limit(
  p_key        text,
  p_limit      integer,
  p_window_sec integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits as r (key, count, window_start)
  values (p_key, 1, now())
  on conflict (key) do update
    set count = case
          when r.window_start < now() - make_interval(secs => p_window_sec)
          then 1
          else r.count + 1
        end,
        window_start = case
          when r.window_start < now() - make_interval(secs => p_window_sec)
          then now()
          else r.window_start
        end
  returning r.count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;

-- Housekeeping: drop rows whose window closed long ago. Call from the
-- existing purge cron rather than adding a second schedule.
create or replace function public.sweep_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limits
  where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.sweep_rate_limits() from public, anon, authenticated;
