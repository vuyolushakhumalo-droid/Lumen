-- Lintel: enquiries about Lintel's own services (Studio, Done for you),
-- sent from the enquiry form on the marketing site via /api/enquiry.
--
-- Deliberately separate from submissions, which belong to customers'
-- sites and show in their dashboards. These are ours: nobody outside the
-- team ever reads them, so the table is service role only.

create table if not exists public.enquiries (
  id          uuid primary key default gen_random_uuid(),
  interest    text not null default 'studio'
              check (interest in ('studio', 'done_for_you', 'other')),
  name        text not null,
  email       text not null,
  message     text not null,
  ip_hash     text,
  user_agent  text,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists enquiries_created_idx
  on public.enquiries (created_at desc);

alter table public.enquiries enable row level security;

-- No policies, deliberately -- service role only, like rate_limits.

-- Retention. The privacy policy keeps support messages for 2 years, and an
-- enquiry is a message sent to us. Called from the purge-trash cron, the
-- same way as purge_submissions.
create or replace function public.purge_enquiries(p_days integer default 730)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 1 then
    p_days := 730;
  end if;

  delete from public.enquiries
  where created_at < now() - make_interval(days => p_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_enquiries(integer) from public, anon, authenticated;
