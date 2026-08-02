-- ============================================================
-- Attempt-and-failure log for the generation pipeline. Every other
-- table here only ever recorded success (versions, usage_events on
-- commit) -- a failed build left no trace anywhere. This is a row
-- per attempt: inserted as 'started' before any model call, then
-- updated to its terminal status once known.
-- ============================================================
create table if not exists generation_attempts (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid,
  user_id               uuid,
  kind                  text check (kind in ('build','edit')),
  status                text not null default 'started' check (status in ('started','succeeded','failed','aborted','refused')),
  model                 text,
  client_expects_edit   boolean,
  previous_html_length  int,
  stage                 text,
  error_text            text,
  created_at            timestamptz default now(),
  finished_at           timestamptz
);
create index if not exists idx_generation_attempts_project on generation_attempts(project_id);
create index if not exists idx_generation_attempts_created on generation_attempts(created_at);

alter table generation_attempts enable row level security;
