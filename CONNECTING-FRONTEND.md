# Connecting your existing site to the backend

Your current pages keep everything in `localStorage`. This maps each of those
to the real endpoint that replaces it. Give this to whoever does the wiring
(or work through it a piece at a time).

**Base URL:** your Vercel address, e.g. `https://lumen-backend.vercel.app`

Every protected call needs the signed-in user's token:

```js
const { data: { session } } = await supabase.auth.getSession();
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${session.access_token}`
};
```

---

## 1. Sign up / sign in (replaces the fake session)

Add the Supabase client to the page:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
  const supabase = window.supabase.createClient(
    'YOUR_NEXT_PUBLIC_SUPABASE_URL',
    'YOUR_NEXT_PUBLIC_SUPABASE_ANON_KEY'
  );
</script>
```

Sign up / sign in:

```js
await supabase.auth.signUp({ email, password });
await supabase.auth.signInWithPassword({ email, password });
const { data: { session } } = await supabase.auth.getSession(); // null = signed out
```

**Replaces:** `localStorage.lumen_session` everywhere, including the
`data-gate="build"` check on "Start building".

---

## 2. Checkout (replaces the Payment Link redirect)

```js
const res = await fetch(`${API}/api/checkout`, {
  method: 'POST', headers,
  body: JSON.stringify({ plan: 'pro', interval: 'month' })
});
const { url } = await res.json();
window.location.href = url;
```

**Replaces:** the `STRIPE_LINKS` map in `start.html`.
Advantage: the subscription is now tied to a real account, so access is enforced.

---

## 3. Generating a site (replaces the browser call to Anthropic)

```js
const res = await fetch(`${API}/api/generate`, {
  method: 'POST', headers,
  body: JSON.stringify({ projectId, brief, model: 'sonnet' })
});

if (res.status === 429) {
  const { resetsAt } = await res.json();
  // show the "you've used today's builds" panel with the countdown + top-up
  return;
}
if (res.status === 402) { /* no active subscription -> send to pricing */ return; }

const { code, projectId: id, buildsLeft, previewUrl } = await res.json();
iframe.srcdoc = code;
```

**Replaces:** the `fetch('https://api.anthropic.com/…')` call in
`lumen-builder.html` — which is the change that makes generation actually work
on your live domain, because the key now lives on the server.

---

## 4. Projects & tabs (replaces `localStorage.lumen_projects`)

```js
const { projects } = await (await fetch(`${API}/api/projects`, { headers })).json();
await fetch(`${API}/api/projects`, { method:'POST', headers, body: JSON.stringify({ name }) });
await fetch(`${API}/api/projects/${id}`, { method:'PATCH', headers, body: JSON.stringify({ name }) });
await fetch(`${API}/api/projects/${id}?fork=true`, { method:'PATCH', headers });
await fetch(`${API}/api/projects/${id}`, { method:'DELETE', headers });
```

Now projects follow the customer across devices.

---

## 5. Version history

```js
const { versions } = await (await fetch(`${API}/api/projects/${id}/versions`, { headers })).json();
await fetch(`${API}/api/projects/${id}/restore`, {
  method:'POST', headers, body: JSON.stringify({ versionId })
});
```

---

## 6. Usage meter (replaces `localStorage.lumen_usage`)

```js
const u = await (await fetch(`${API}/api/usage`, { headers })).json();
// { plan, dailyLimit, used, buildsLeft, topupCredits, resetsAt, allowedModels, canBuild }
```

Use it for the dashboard meter, the builder's allowance pill, and to decide
which models appear in the picker (`u.allowedModels`).

---

## 7. Billing portal

```js
const { url } = await (await fetch(`${API}/api/portal`, { method:'POST', headers })).json();
window.location.href = url;
```

**Replaces:** the placeholder alert on `dashboard.html`.

---

## 8. Admin page

```js
const stats = await (await fetch(`${API}/api/admin/stats`, { headers })).json();
```

Returns `activeSubscribers`, `trialing`, `mrr`, `buildsToday`,
`estimatedAiCostToday`, `totalProjects`, `recentSubscribers`.
Only works for profiles with `is_admin = true`.

---

## One deployment note

Your site (Netlify) and backend (Vercel) are on different domains, so the
browser will block requests unless the backend allows them. Add CORS headers —
either in `next.config.js` or a `middleware.js` — permitting your Netlify
domain and your custom domain.

Simplest long-term fix: host the whole thing on Vercel so they share a domain
and the problem disappears.
