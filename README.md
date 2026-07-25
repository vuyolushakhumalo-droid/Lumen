# Lumen backend

The engine behind Lumen: accounts, AI generation, usage limits, subscriptions.

**Start here → `RUNBOOK.md`** (step-by-step setup, written for non-developers).

## Stack
Next.js (App Router) · Supabase (Postgres + Auth) · Stripe · Anthropic API
Deployed on Vercel.

## Layout
```
supabase/schema.sql        database tables, RLS policies, helper functions
lib/plans.js               plan limits + model access  ← tune limits here
lib/usage.js               metering: daily allowance, top-ups, reset timing
lib/anthropic.js           Claude calls (server-only)
lib/render.js              JSON -> finished HTML page
lib/auth.js                auth guards + error handling
lib/supabase.js            database clients
app/api/…                  the endpoints
```

## Endpoints
| Method | Route | Purpose |
|---|---|---|
| POST | `/api/generate` | Build/edit a site. Enforces limits + model access. |
| GET | `/api/usage` | Allowance, builds left, reset time. |
| GET/POST | `/api/projects` | List / create projects. |
| PATCH/DELETE | `/api/projects/:id` | Rename, fork (`?fork=true`), delete. |
| GET | `/api/projects/:id/versions` | Version history. |
| POST | `/api/projects/:id/restore` | Restore a version (non-destructive). |
| POST | `/api/checkout` | Stripe Checkout with 30-day trial. |
| POST | `/api/portal` | Stripe billing portal. |
| POST | `/api/webhooks/stripe` | **The real access gate.** |
| GET | `/api/admin/stats` | Live ops numbers (admins only). |

## Rules baked in
- A failed generation **never** costs a build.
- Spend order: daily allowance → then top-up credits (which roll over).
- Fable/Opus are refused server-side unless the plan allows them.
- Every project/version query is filtered by `user_id` — IDs from the client are never trusted.
- The Anthropic key exists only on the server.

## Changing limits
Edit `lib/plans.js` and redeploy. No database migration needed.
