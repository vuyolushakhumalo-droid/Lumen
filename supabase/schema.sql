-- ============================================================
-- Lumen — database schema
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run
-- ============================================================

-- ---------- profiles (extends Supabase auth.users) ----------
create table if not exists profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  name                text,
  timezone            text default 'Europe/London',
  stripe_customer_id  text unique,
  is_admin            boolean default false,
  created_at          timestamptz default now()
);

-- Automatically create a profile row whenever someone signs up
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- subscriptions ----------
create table if not exists subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles(id) on delete cascade,
  plan                    text not null check (plan in ('standard','pro','frontier','done_for_you','studio')),
  status                  text not null check (status in ('trialing','active','past_due','canceled','incomplete')),
  billing_interval        text check (billing_interval in ('month','year')),
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean default false,
  stripe_subscription_id  text unique,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);
create index if not exists idx_subs_user on subscriptions(user_id);

-- ---------- projects ----------
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  name          text not null default 'Untitled project',
  current_code  text,
  preview_url   text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_projects_user on projects(user_id);

-- ---------- versions (append-only history) ----------
create table if not exists versions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  label       text,
  brief       text,
  code        text not null,
  model_used  text,
  created_at  timestamptz default now()
);
create index if not exists idx_versions_project on versions(project_id, created_at desc);

-- ---------- daily usage ----------
create table if not exists usage_daily (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  date        date not null,
  builds_used int not null default 0,
  unique (user_id, date)
);
create index if not exists idx_usage_user_date on usage_daily(user_id, date);

-- ---------- top-up credits (roll over, never expire) ----------
create table if not exists topups (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  credits_purchased  int not null,
  credits_remaining  int not null,
  stripe_payment_id  text,
  created_at         timestamptz default now()
);
create index if not exists idx_topups_user on topups(user_id) where credits_remaining > 0;

-- ---------- published sites ----------
create table if not exists sites (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  user_id           uuid not null references profiles(id) on delete cascade,
  subdomain         text unique,
  custom_domain     text unique,
  provider_site_id  text,
  status            text default 'draft' check (status in ('draft','live')),
  last_deployed_at  timestamptz
);

-- ---------- audit log (support, abuse, disputes) ----------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete set null,
  action      text not null,
  meta        jsonb,
  created_at  timestamptz default now()
);
create index if not exists idx_audit_created on audit_log(created_at desc);

-- ============================================================
-- Row Level Security
-- Users may only ever touch their own rows. The server uses the
-- service-role key, which bypasses RLS for trusted operations.
-- ============================================================
alter table profiles      enable row level security;
alter table subscriptions enable row level security;
alter table projects      enable row level security;
alter table versions      enable row level security;
alter table usage_daily   enable row level security;
alter table topups        enable row level security;
alter table sites         enable row level security;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own subscription" on subscriptions;
create policy "own subscription" on subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "own projects" on projects;
create policy "own projects" on projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own versions" on versions;
create policy "own versions" on versions
  for select using (
    exists (select 1 from projects p where p.id = versions.project_id and p.user_id = auth.uid())
  );

drop policy if exists "own usage" on usage_daily;
create policy "own usage" on usage_daily
  for select using (auth.uid() = user_id);

drop policy if exists "own topups" on topups;
create policy "own topups" on topups
  for select using (auth.uid() = user_id);

drop policy if exists "own sites" on sites;
create policy "own sites" on sites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Helper: atomically increment today's build count.
-- Called ONLY after a successful generation.
-- ============================================================
create or replace function increment_usage(p_user_id uuid, p_date date)
returns int language plpgsql security definer as $$
declare
  new_count int;
begin
  insert into usage_daily (user_id, date, builds_used)
  values (p_user_id, p_date, 1)
  on conflict (user_id, date)
  do update set builds_used = usage_daily.builds_used + 1
  returning builds_used into new_count;
  return new_count;
end;
$$;

-- ============================================================
-- Helper: spend one top-up credit (oldest pack first).
-- Returns true if a credit was available and consumed.
-- ============================================================
create or replace function spend_topup_credit(p_user_id uuid)
returns boolean language plpgsql security definer as $$
declare
  target uuid;
begin
  select id into target
  from topups
  where user_id = p_user_id and credits_remaining > 0
  order by created_at asc
  limit 1
  for update skip locked;

  if target is null then
    return false;
  end if;

  update topups set credits_remaining = credits_remaining - 1 where id = target;
  return true;
end;
$$;
