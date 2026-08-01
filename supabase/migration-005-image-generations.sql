-- ============================================================
-- Image generation log + monthly allowance tracking.
-- One row per real OpenAI image-generation attempt (success or
-- failed) — never for placeholders skipped due to the per-build cap
-- or an exhausted monthly allowance, since nothing was attempted.
-- ============================================================
create table if not exists image_generations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  model       text not null,
  quality     text not null,
  status      text not null check (status in ('success','failed')),
  created_at  timestamptz default now()
);
create index if not exists idx_image_generations_user_month on image_generations(user_id, created_at);
