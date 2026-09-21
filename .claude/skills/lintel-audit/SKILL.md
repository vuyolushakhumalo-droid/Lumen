---
name: lintel-audit
description: Audit Lintel's OWN website (www.lintelapp.co.uk marketing pages, builder, dashboard, help, reset) for speed, accessibility, responsiveness and copy-rule compliance, and write a ranked AUDIT report without changing any code. Use this whenever the user asks how well the Lintel site is built, wants a baseline or regression check, mentions Lighthouse, Core Web Vitals, LCP, WCAG, accessibility, "audit", "health check on our own site", or wants to compare the site before/after a session (B currency, C languages, D motion). Do NOT use it for customer-generated sites on lintelsites.com — that is the product's own health-check feature, not this.
---

# Lintel self-audit

Produce `audits/AUDIT-<YYYY-MM-DD>.md`: evidence-backed, ranked, read-only.
This skill measures; it never fixes. Fixing is a separate session so the report stays honest.

## Hard rules
- Modify nothing under `public/`, `app/`, `lib/`, or `supabase/`. The only files you
  create are under `audits/`. If `git status` shows anything else changed at the end,
  revert it and say so.
- Audit the LIVE site (https://www.lintelapp.co.uk) unless the user gives a preview URL.
  lintel.co.uk is a DIFFERENT company (Lintel Software Consultancy Ltd, an Informix
  consultancy). Never point Lighthouse, axe or a crawler at it.
  Never log in with real customer accounts; use the owner's test account only if the
  user supplies it, and never paste credentials into the report.
- Do not run `npm install` in the repo (no node_modules here). Use `npx` for tools;
  it fetches on demand. If a tool fails to install, record "not measured" and continue.
- Never send a form, start a checkout, or trigger any email on the live site.

## Workflow

### 1. Enumerate pages
List `public/*.html` and map each to its URL (`index.html` → `/`, `pricing.html` →
`/pricing`, etc. — confirm the mapping from `next.config` / `vercel.json` rewrites).
Note which pages require auth (builder, dashboard). Expect ~22 pages.
Write the list at the top of the report with a tick for each measured.

### 2. Objective checks — run for every page
Save raw output to `audits/raw/<date>/<page>.*` so numbers can be re-checked.

- **Lighthouse (mobile preset, 3 runs, take the median):**
  `npx lighthouse <url> --preset=perf --form-factor=mobile --output=json --output-path=<file> --chrome-flags="--headless" --quiet`
  Record: Performance, Accessibility, Best Practices, SEO scores; LCP, CLS, TBT, INP.
  Also run once with `--form-factor=desktop`.
- **Accessibility:** `npx @axe-core/cli <url> --save <file>`
  Record violation count by impact (critical / serious / moderate / minor) and the
  rule ids.
- **Screenshots:** Playwright (`npx playwright screenshot --full-page --viewport-size=WxH`)
  at 375×812, 768×1024, 1280×800. Save to `audits/raw/<date>/screenshots/`.
  Look at every screenshot. Note overflow, overlap, truncated text, tap targets that
  look under 44px, anything that differs from the desktop layout in a way that loses
  content.
- **Head & network:** `curl -sI <url>` — record cache headers, security headers
  (CSP, HSTS, X-Frame-Options, Referrer-Policy) and the response size. From the
  Lighthouse network log, list every third-party origin the page contacts.

### 3. Rubric checks — judgement, with evidence
Read `references/rubric.md` and score every item pass / fail / n-a. Every fail needs
evidence: a page + a line reference in the source file, or a screenshot filename.
No verdict without evidence.

### 4. Write the report
`audits/AUDIT-<date>.md` in this order:

1. **Scorecard** — one table: page, mobile Perf, A11y, LCP, CLS, axe critical+serious.
   Flag any page under 90 Perf/A11y or LCP over 2.5s.
2. **Issues** — grouped Critical / Major / Minor. Each issue: id (A-001…), pages
   affected, what's wrong, evidence, one-line suggested fix, estimated effort
   (S/M/L). Critical = blocks a user or breaks a rule in CLAUDE.md. Major = degrades
   the experience for many users or costs a Core Web Vital. Minor = polish.
3. **Rubric results** — the full pass/fail table.
4. **Third-party origins** — the deduplicated list across all pages, with which
   page loads each. Anything not in the known list (Supabase, Stripe, Sentry,
   Resend, Vercel, Plausible/analytics) is a Major issue until explained.
5. **Comparison** — if an earlier `audits/AUDIT-*.md` exists, a delta table:
   what got better, what got worse, new issues, resolved issues.
6. **Not measured** — anything skipped, and why.

Keep it factual. No praise paragraphs, no "overall the site is well built".

### 5. Stop condition
Done means all of: every enumerated page has Lighthouse (mobile + desktop), axe and
three screenshots recorded under `audits/raw/<date>/`; every rubric item has a verdict
with evidence; the report exists with all six sections; `git status` shows only
`audits/` changed. Paste the scorecard table into the conversation as the final message.

## Known context (so you don't re-discover it)
- Inter is self-hosted; the homepage poster image is intended as the LCP element
  (target ~1.6s mobile). Supabase JS is lazy-loaded on purpose.
- reset.html must load no third-party script at all — a strict rule, not a preference.
- 22 pages share header/footer markup, so a nav inconsistency is usually a
  copy-paste drift between files, and worth listing every affected file.
- Copy rules are in CLAUDE.md at the repo root; read it before the rubric pass.
