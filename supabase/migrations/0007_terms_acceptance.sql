-- Lintel: record which version of the terms an account accepted, and when.
--
-- Acceptance was already written to audit_log as a dated event, and that
-- stays -- it is the history, including re-acceptance when the terms
-- change. What was missing is the answer to the question you actually
-- ask about an account: has this user accepted, and which version?
--
-- A column beats scanning the log for two reasons. It is a single-row
-- read on a path that runs on every sign-up and every checkout, and it
-- survives audit_log's `on delete set null` -- which today quietly
-- orphans the acceptance record when a profile is removed.

alter table public.profiles
  add column if not exists terms_accepted_at timestamptz;

alter table public.profiles
  add column if not exists terms_version text;

-- ---------------------------------------------------------------
-- Backfill from the log
-- ---------------------------------------------------------------
-- Accounts that accepted before these columns existed already have a
-- row in audit_log. Earliest acceptance wins: the first agreement is
-- the one that bound the account, and taking the latest would lose it.
--
-- The version comes from the same earliest row rather than from the
-- current constant, so an account that agreed to 1.0 is not silently
-- recorded as having agreed to something published later.

update public.profiles p
set terms_accepted_at = a.first_at,
    terms_version     = a.version
from (
  select
    user_id,
    min(created_at) as first_at,
    (array_agg(meta->>'version' order by created_at))[1] as version
  from public.audit_log
  where action = 'terms.accepted'
    and user_id is not null
  group by user_id
) a
where p.id = a.user_id
  and p.terms_accepted_at is null;

-- Idempotent: `add column if not exists` above, and the backfill only
-- touches rows that are still null, so re-running this changes nothing.
