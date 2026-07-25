-- ============================================================
-- Migration 003 — conversation history
-- Chats now survive a refresh and follow the customer across devices.
--
-- Run in Supabase: SQL Editor -> New query -> paste -> Run
-- Safe to run on an existing database.
-- ============================================================

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  plan        jsonb,          -- how the build was approached
  model_used  text,
  created_at  timestamptz default now()
);

create index if not exists idx_messages_project
  on messages(project_id, created_at asc);

alter table messages enable row level security;

drop policy if exists "own messages" on messages;
create policy "own messages" on messages
  for select using (auth.uid() = user_id);
