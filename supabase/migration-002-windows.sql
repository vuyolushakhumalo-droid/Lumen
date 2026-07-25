-- ============================================================
-- Migration 002 — rolling usage windows
-- Moves from a once-a-day reset to a 5-hour rolling window,
-- with a monthly ceiling to bound worst-case cost.
--
-- Run in Supabase: SQL Editor -> New query -> paste -> Run
-- Safe to run on an existing database.
-- ============================================================

create table if not exists usage_windows (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  window_start  timestamptz not null,
  builds_used   int not null default 0,
  unique (user_id, window_start)
);

create index if not exists idx_usage_windows_user
  on usage_windows(user_id, window_start desc);

alter table usage_windows enable row level security;

drop policy if exists "own window usage" on usage_windows;
create policy "own window usage" on usage_windows
  for select using (auth.uid() = user_id);

-- Increment the current window atomically. Called only after a
-- successful build, so failures are never charged.
create or replace function increment_window_usage(p_user_id uuid, p_window timestamptz)
returns int language plpgsql security definer as $$
declare
  new_count int;
begin
  insert into usage_windows (user_id, window_start, builds_used)
  values (p_user_id, p_window, 1)
  on conflict (user_id, window_start)
  do update set builds_used = usage_windows.builds_used + 1
  returning builds_used into new_count;
  return new_count;
end;
$$;
