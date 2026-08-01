-- ============================================================
-- Claude token usage log — input/output tokens per build or edit.
-- Internal telemetry only: RLS enabled with no policies, so it's
-- readable only via the service-role key.
-- ============================================================
create table if not exists usage_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references profiles(id) on delete cascade,
  project_id     uuid not null references projects(id) on delete cascade,
  model          text not null,
  input_tokens   int not null default 0,
  output_tokens  int not null default 0,
  kind           text not null check (kind in ('build','edit')),
  created_at     timestamptz default now()
);
create index if not exists idx_usage_events_user_created on usage_events(user_id, created_at);
create index if not exists idx_usage_events_project on usage_events(project_id);

alter table usage_events enable row level security;
