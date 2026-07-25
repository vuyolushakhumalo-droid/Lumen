# Lumen backend — setup runbook

Written for someone who isn't a developer. Follow it in order. Nothing here is
dangerous — the worst case is an error message you can paste back to me.

**Time:** about 2 hours the first time.
**Cost:** £0 to start (all free tiers), plus Anthropic usage.

---

## What this backend does

It's the engine behind your site. It handles:

- real accounts (sign up, sign in)
- generating websites with Claude — **with your API key kept safely on the server**
- counting builds and enforcing daily limits
- Stripe subscriptions that actually control access
- saving projects and version history
- real numbers for your admin page

---

## Part 1 — Install the tools (one time, ~15 min)

You need two things on your computer.

### 1.1 Node.js
Go to **https://nodejs.org** and download the **LTS** version. Install it,
accepting the defaults.

Check it worked. Open **Terminal** (Mac: ⌘+Space, type "Terminal") or
**PowerShell** (Windows: Start menu, type "PowerShell"), then type:

```bash
node --version
```

You should see something like `v20.x.x`. If you see "command not found",
restart your computer and try again.

### 1.2 A code editor
Download **VS Code** from https://code.visualstudio.com — it's free. You'll use
it to paste values into files.

---

## Part 2 — Create your accounts (~20 min)

You need three. All have free tiers.

| Service | What for | Sign up at |
|---|---|---|
| **Supabase** | Database + logins | supabase.com |
| **Anthropic** | The AI that builds sites | console.anthropic.com |
| **Vercel** | Runs the backend | vercel.com |

(You already have Stripe and Netlify.)

### 2.1 Supabase
1. Sign up → **New project**.
2. Name it `lumen`. Choose a region near you (London).
3. Set a database password — **save it somewhere safe**.
4. Wait ~2 minutes while it builds.

### 2.2 Anthropic
1. Sign up at console.anthropic.com.
2. Go to **API keys** → **Create key**. Name it `lumen-backend`.
3. **Copy it now** — you can't see it again. It starts `sk-ant-`.
4. Add billing (**Plans & billing**) — set a low monthly spend limit at first,
   e.g. £50, so nothing can run away.

---

## Part 3 — Set up the database (~10 min)

1. In Supabase, click **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Open the file `supabase/schema.sql` from this folder, select all, copy.
4. Paste into the Supabase query box.
5. Click **Run** (bottom right).

You should see "Success. No rows returned." That's correct.

**Check it worked:** click **Table Editor** in the sidebar. You should see
`profiles`, `subscriptions`, `projects`, `versions`, `usage_daily`, `topups`,
`sites`, `audit_log`.

---

## Part 4 — Configure the project (~15 min)

### 4.1 Open the folder
In VS Code: **File → Open Folder** → select this `lumen-backend` folder.

### 4.2 Make your settings file
In VS Code's file list, find `.env.example`. Right-click → **Copy**, then
right-click in empty space → **Paste**. Rename the copy to exactly:

```
.env.local
```

### 4.3 Fill it in
Open `.env.local` and replace each placeholder.

**Supabase values** — in Supabase: **Project Settings → API**
- `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` → the "Project URL"
- `SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` → the `anon public` key
- `SUPABASE_SERVICE_ROLE_KEY` → the `service_role` key
  ⚠️ **This one is a master key. Never share it or put it in a website.**

**Anthropic**
- `ANTHROPIC_API_KEY` → the `sk-ant-...` key you copied

**Stripe** — in Stripe: **Developers → API keys**
- `STRIPE_SECRET_KEY` → the **Secret key** (use the **test** one for now)
- Leave `STRIPE_WEBHOOK_SECRET` blank for the moment (Part 6)

**Stripe price IDs** — in Stripe: **Product catalogue** → click a product →
click the price → copy the ID (starts `price_`). Do this for each plan and
interval.

Save the file (⌘S / Ctrl+S).

---

## Part 5 — Run it on your own computer (~10 min)

In VS Code: **Terminal → New Terminal**. Then type these one at a time:

```bash
npm install
```
(Takes a minute or two. Downloads the code libraries.)

```bash
npm run dev
```

You should see `ready - started server on http://localhost:3000`.

**Leave this running.** It's your backend, live on your own machine.

**Test it:** open a browser to
`http://localhost:3000/api/usage`
You should see `{"error":"Not signed in"}` — that's **correct**. It means the
endpoint is alive and correctly refusing anonymous access.

To stop the server later: click the terminal and press `Ctrl+C`.

---

## Part 6 — Connect Stripe webhooks (~15 min)

Webhooks are how Stripe tells your backend "this person paid". Without this,
subscriptions won't grant access.

### 6.1 For local testing
1. Install the Stripe CLI: https://docs.stripe.com/stripe-cli
2. In a **new** terminal window:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

3. It prints a signing secret starting `whsec_...`. Copy it into `.env.local`
   as `STRIPE_WEBHOOK_SECRET`.
4. Stop and restart `npm run dev` so it picks up the change.

### 6.2 Test a payment
In another terminal:

```bash
stripe trigger customer.subscription.created
```

Then check Supabase → **Table Editor → subscriptions**. A row should appear.
That's the whole system working: Stripe → your backend → your database.

---

## Part 7 — Put it on the internet (~20 min)

**Good news:** your website is already inside this project, in the `public`
folder. So one deploy publishes the site AND the backend together, on one
domain. You won't need Netlify any more once this is live.

### 7.1 Deploy to Vercel
In your terminal, from inside the project folder:

```bash
npm install -g vercel
vercel login
vercel
```

Answer the prompts (accept the defaults; "Link to existing project?" -> No).
It gives you a URL like `lumen-abc123.vercel.app`. Visit it — you should see
your actual Lumen homepage.

### 7.2 Add your settings to Vercel
Your `.env.local` stays on your computer, so Vercel needs its own copy.

1. vercel.com -> your project -> **Settings -> Environment Variables**
2. Add every line from `.env.local`, one at a time (name on the left, value on
   the right)
3. Set `APP_URL` to your Vercel URL (e.g. `https://lumen-abc123.vercel.app`)

### 7.3 Deploy for real
```bash
vercel --prod
```

### 7.4 Point Stripe at it
1. Stripe -> **Developers -> Webhooks -> Add endpoint**
2. URL: `https://YOUR-VERCEL-URL/api/webhooks/stripe`
3. Select these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Save, copy the **Signing secret** (`whsec_...`)
5. Add it to Vercel's environment variables as `STRIPE_WEBHOOK_SECRET`
6. Redeploy: `vercel --prod`

### 7.5 Your custom domain
When you have your domain, add it in Vercel: **Settings -> Domains**. Vercel
tells you which DNS records to set at your registrar, and handles SSL
automatically.

**Then you can retire the Netlify site** — everything lives in one place.

## Part 8 — Make yourself an admin

1. Sign up on your own site (once the front end is connected).
2. Supabase → **Table Editor → profiles** → find your row.
3. Set `is_admin` to `true`. Save.

Now `/api/admin/stats` returns real numbers for your admin page.

---

## What's left after this

This backend is the engine. Two jobs remain:

1. **Connect the front end** — your existing pages need to call these endpoints
   instead of using `localStorage`. That's the next piece of work.
2. **Publishing customer sites** — deploying a customer's site to their own
   subdomain (Phase 3).

---

## If something goes wrong

**"command not found: npm"** → Node.js didn't install properly. Reinstall,
restart your computer.

**"Invalid API key"** → a value in `.env.local` has a typo, or you pasted a
test key while using live mode (or vice versa). They must match.

**"Not signed in" everywhere** → correct behaviour until the front end sends a
login token.

**Webhook says "Invalid signature"** → `STRIPE_WEBHOOK_SECRET` doesn't match the
endpoint you're using. Local CLI and hosted endpoint have *different* secrets.

**Anything else** → copy the exact error message and send it to me. Error text
is genuinely the most useful thing you can share.

---

## Safety rules

- **Never** put `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, or
  `STRIPE_SECRET_KEY` into any file inside your Netlify site. They belong only
  in `.env.local` and Vercel's environment variables.
- **Never** commit `.env.local` to GitHub (`.gitignore` already blocks it).
- Keep a spend limit set on your Anthropic account.
- Use Stripe **test** keys until everything works end to end.
