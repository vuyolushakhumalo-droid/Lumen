-- ============================================================
-- Optimistic locking for projects.current_code.
--
-- Two tabs editing the same project concurrently could race: the
-- later write silently overwrote the earlier one, with both attempts
-- logged as succeeded. code_version is a dedicated lock token, bumped
-- only when current_code is actually written -- not updated_at, which
-- is also touched by unrelated writes (e.g. renaming a project) and
-- would cause false conflicts on an in-flight edit.
-- ============================================================
alter table projects add column if not exists code_version integer not null default 0;

-- Widen generation_attempts.status so a lock conflict is recorded
-- distinctly rather than folded into 'failed'.
alter table generation_attempts drop constraint if exists generation_attempts_status_check;
alter table generation_attempts add constraint generation_attempts_status_check
  check (status in ('started','succeeded','failed','aborted','refused','conflict'));
