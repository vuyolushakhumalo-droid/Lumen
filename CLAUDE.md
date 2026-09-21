# Lintel — CLAUDE.md

Lintel is a subscription website builder for UK small businesses. Next.js app on Vercel
(app/api routes + static marketing pages in public/*.html), Supabase (Postgres, Storage),
Stripe (LIVE mode), Resend, Sentry, Anthropic API for generation. Generated customer
sites are single self-contained HTML files served on {slug}.lintelsites.com.
Live site: https://www.lintelapp.co.uk (lintel.co.uk is an unrelated company — never touch it).

# Commands
- Build: `npm run build` — must pass before any commit
- Tests: `npm test` — run after every change to lib/, app/api/ or public/*.js
- Windows / PowerShell environment. Repo lives in OneDrive\Documents\Lumen-backend.

# Database
- Migrations live in supabase/migrations/NNNN_name.sql, mirrored in schema.sql. Number
  them from the highest existing file +1.
- NEVER run migrations. The owner applies them by hand in the Supabase SQL editor.
  Assume every committed migration is already applied except the one you just wrote —
  do not report older migrations as "unapplied".
- Never ask for, echo, or paste the service-role key or any secret. Never read .env files.

# Stripe (live money)
- Stripe is in LIVE mode. Never create, edit, or archive prices/products — write the
  env var name and suggested price in the PR description and the owner does it.
- Stripe prices can't be edited in place; a price change means a new price + archive old.
- One-off packs (clips, languages, top-ups) use payment-mode Checkout with adjustable
  quantity. There is NO recurring add-on bundle ("Lintel Plus" was dropped — don't reintroduce).
- Every subscription event hits /api/webhooks/stripe; changes to lib/stripe.js or the
  webhook route need a test asserting the unhandled-event path returns 200.

# Copy rules (enforced — customers and regulators read these)
- Never "credits". Say "builds", "clips", "languages", "build allowance".
  (Exception: public/blog-no-credits.html, whose subject is credit pricing.)
- Never "at cost", "no markup", "daily allowance".
- Never a number for Studio — it is "by enquiry", priced per project.
- Never claim customer counts, uptime %, or features that don't exist.
- Lintel NEVER converts money. Currency display is "approx." only; charges stay GBP.
- British English.

# Generated sites (what the model produces for customers)
- Single HTML file, inline CSS/JS, no external scripts/iframes except EMBED_ALLOWLIST
  in lib/publish.js. The abuse screen (findHardBlock) runs on publish AND edit; a
  change to the generator must not emit anything that trips it.
- Never invent external URLs, phone numbers, or addresses — only what the brief supplied.
- Motion for generated sites comes ONLY from lib/motion-kit.js (lk- classes).
  vendor/animmaster/ is gitignored and licensed for Lintel's own pages only — never
  reference or copy it into generated output or build prompts.
- EDIT_PROMPT must preserve existing style; design directions apply to builds only.

# Lintel's own pages (public/*.html)
- No Google Fonts — Inter is self-hosted from /fonts on every page. No third-party
  script or stylesheet on reset.html at all.
- Supabase JS is lazy-loaded; keep the homepage poster as the LCP element.
- 22 files share header/footer markup and colour tokens — a change to either must be
  applied to all of them, not just one. Check with grep before saying done.

# Workflow
- Small, single-purpose commits with descriptive messages. One PR per session.
- Before saying "done": build passes, tests pass, and paste the test output + the list
  of files changed. State any HAND STEPS (env vars, Stripe prices, migrations) at the
  top of the PR description in a checklist.
- Audit skill: .claude/skills/lintel-audit. Reports in audits/. Read the newest one
  before proposing any change to public/ pages.
- When compacting, always preserve: the list of modified files, pending hand steps,
  and the migration number in use.
