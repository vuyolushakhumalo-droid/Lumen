// ============================================================
// Unit checks. Run with `npm test`.
//
// Plain node:test — no framework, no config, nothing to install.
// Everything here is pure and offline: no Supabase, no Stripe API,
// no network. A check that needs a live service does not belong in
// this file.
//
// Two things make this work against the app's own modules:
//  - lib/*.js use `import`/`export` while package.json is CommonJS,
//    so Node reparses them as ES modules by syntax detection. The
//    npm script silences the warning that reparsing prints.
//  - app/api routes import through the "@/..." alias, which only
//    Next.js resolves. The hook below teaches plain Node the same
//    mapping so the webhook route can be imported and called.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) {
      let target = path.join(ROOT, spec.slice(2));
      if (!path.extname(target)) target += '.js';
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

// Dummy values only. These are never real credentials and nothing here
// reaches a network: the webhook check below exercises the unhandled
// branch, which touches no service. Set before the route is imported.
process.env.STRIPE_SECRET_KEY ||= 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'not-a-real-service-role-key';

const { slugify } = await load('lib/render.js');
const { decodeHtmlEntities } = await load('lib/text.js');
const { chooseModel } = await load('lib/routing.js');
const { planFor } = await load('lib/plans.js');
const { packForPrice, PACKS, SELLABLE_PACKS } = await load('lib/packs.js');
const { makeSlug, findHardBlock, findInlineRequest, normalizeEmbeds, hardBlockHost } =
  await load('lib/publish.js');
const { isMissingResource } = await load('lib/stripe.js');

// ---------- slugs and text ----------

test('slugify strips punctuation and falls back to "site"', () => {
  assert.equal(slugify("Joe's Cafe & Bar"), 'joescafebar');
  assert.equal(slugify(''), 'site');
  assert.equal(slugify(null), 'site');
  assert.equal(slugify('a'.repeat(50)).length, 30, 'caps at 30 characters');
});

test('makeSlug decodes entities before slugifying, and hyphenates words', () => {
  assert.equal(makeSlug('Joe&amp;s  Cafe!!'), 'joes-cafe');
  assert.equal(makeSlug('  --Hello--World--  '), 'hello-world');
  assert.equal(makeSlug('a'.repeat(60)).length, 40, 'caps at 40 characters');
});

test('decodeHtmlEntities can never emit a raw angle bracket', () => {
  assert.equal(decodeHtmlEntities('Tom &amp; Jerry'), 'Tom & Jerry');
  // Numeric entities decode to < and > and must then be stripped: this is
  // what stops a project name holding a bracket whatever renders it later.
  assert.equal(decodeHtmlEntities('&#60;b&#62;hi'), 'bhi');
  assert.equal(decodeHtmlEntities('&#x3c;script&#x3e;'), 'script');
  assert.equal(decodeHtmlEntities('a<b>c'), 'abc');
});

// ---------- model routing ----------

test('chooseModel gives each plan the best model it guarantees', () => {
  // Frontier is pinned to Fable, so Fable is its default, not an upgrade.
  assert.deepEqual(chooseModel({ isEdit: false, requested: null, allowedModels: ['fable'] }),
    { model: 'fable', reason: 'new site' });
  // Opus wins by default even where Fable is permitted.
  assert.deepEqual(chooseModel({ isEdit: true, requested: null, allowedModels: ['opus', 'fable'] }),
    { model: 'opus', reason: 'edit' });
});

test('chooseModel honours an explicit Fable request only where the plan allows it', () => {
  assert.deepEqual(chooseModel({ isEdit: false, requested: 'fable', allowedModels: ['opus', 'fable'] }),
    { model: 'fable', reason: 'requested' });
  // Standard/Pro permit Opus only: asking for Fable must not grant it.
  assert.deepEqual(chooseModel({ isEdit: true, requested: 'fable', allowedModels: ['opus'] }),
    { model: 'opus', reason: 'edit' });
});

test('chooseModel throws rather than silently picking an unlisted model', () => {
  assert.throws(() => chooseModel({ isEdit: false, requested: null, allowedModels: [] }),
    /No permitted model/);
});

// ---------- plan gating ----------

test('planFor grants a plan only on an active or trialing subscription', () => {
  assert.equal(planFor({ status: 'active', plan: 'pro' }).label, 'Pro');
  assert.equal(planFor({ status: 'trialing', plan: 'pro' }).label, 'Pro');
  assert.equal(planFor(null), null);
  assert.equal(planFor({ status: 'canceled', plan: 'pro' }), null);
  assert.equal(planFor({ status: 'past_due', plan: 'pro' }), null);
  assert.equal(planFor({ status: 'active', plan: 'no_such_plan' }), null);
});

// ---------- packs ----------

test('packForPrice maps a configured price to its pack and nothing else', () => {
  const previous = process.env.STRIPE_PRICE_CLIP;
  process.env.STRIPE_PRICE_CLIP = 'price_test_clip';
  try {
    assert.equal(packForPrice('price_test_clip'), 'motion');
    assert.equal(packForPrice('price_something_else'), null);
    assert.equal(packForPrice(null), null);
    assert.equal(packForPrice(undefined), null);
  } finally {
    if (previous === undefined) delete process.env.STRIPE_PRICE_CLIP;
    else process.env.STRIPE_PRICE_CLIP = previous;
  }
});

test('only the one-off packs are sellable; Lintel Plus is not', () => {
  assert.deepEqual(SELLABLE_PACKS, ['motion', 'languages']);
  // Plus was dropped and must not come back as something with a price.
  assert.equal(PACKS.plus.priceEnv, null);
  assert.equal(PACKS.forms_pro.priceEnv, null);
});

// ---------- the abuse screen on generated sites ----------

test('findHardBlock passes a clean page', () => {
  assert.equal(findHardBlock('<html><body><h1>Hi</h1><p>We open at nine.</p></body></html>'), null);
});

test('findHardBlock blocks password inputs and off-site form actions', () => {
  assert.equal(findHardBlock('<input type="password" name="p">').id, 'password_input');
  assert.equal(findHardBlock('<form action="https://evil.example.com/p"><input name="a"></form>').id,
    'external_form_action');
  // A form posting back to the site itself is the normal case.
  assert.equal(findHardBlock('<form action="/submit"><input name="a"></form>'), null);
});

test('findHardBlock allows only allowlisted embed hosts', () => {
  assert.equal(findHardBlock('<script src="https://js.stripe.com/v3/"></script>'), null);
  assert.equal(findHardBlock('<script src="https://evil.example.com/x.js"></script>').id,
    'external_script');
  assert.equal(findHardBlock('<iframe src="https://evil.example.com/x"></iframe>').id,
    'external_iframe');
});

test('findHardBlock takes YouTube only in its no-cookie form', () => {
  // Deliberate: www.youtube.com is absent from the allowlist so an embed
  // cannot set cookies on a customer's visitors. normalizeEmbeds is what
  // gets a customer there; the screen itself stays strict.
  assert.equal(findHardBlock('<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>'), null);
  assert.equal(findHardBlock('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>').id,
    'external_iframe');
});

// ---------- YouTube normalisation ----------

const iframe = (src) => `<iframe src="${src}" width="560" height="315" allowfullscreen></iframe>`;
const srcOf = (html) => html.match(/src="([^"]*)"/)[1];
const ID = 'dQw4w9WgXcQ';

test('normalizeEmbeds rewrites every YouTube embed form to the no-cookie host', () => {
  const cases = [
    // What YouTube's own Share -> Embed hands out.
    [`https://www.youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
    [`http://www.youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
    // A watch page or a short link pasted into an iframe: meant as an
    // embed, and broken as one until it is converted.
    [`https://www.youtube.com/watch?v=${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://m.youtube.com/watch?v=${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://youtu.be/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
    // Right host, missing www. -- the allowlist would refuse it.
    [`https://youtube-nocookie.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(srcOf(normalizeEmbeds(iframe(input))), expected, `from ${input}`);
  }
});

test('normalizeEmbeds keeps query parameters, and the rest of the tag', () => {
  assert.equal(srcOf(normalizeEmbeds(iframe(`https://www.youtube.com/embed/${ID}?start=30&rel=0`))),
    `https://www.youtube-nocookie.com/embed/${ID}?start=30&rel=0`);
  // On a watch URL, v= becomes the path and the other params survive.
  assert.equal(srcOf(normalizeEmbeds(iframe(`https://www.youtube.com/watch?v=${ID}&t=42`))),
    `https://www.youtube-nocookie.com/embed/${ID}?t=42`);
  // &amp; in the attribute stays escaped on the way out.
  assert.equal(srcOf(normalizeEmbeds(iframe(`https://www.youtube.com/embed/${ID}?start=30&amp;rel=0`))),
    `https://www.youtube-nocookie.com/embed/${ID}?start=30&amp;rel=0`);
  // Protocol-relative stays protocol-relative.
  assert.equal(srcOf(normalizeEmbeds(iframe(`//www.youtube.com/embed/${ID}`))),
    `//www.youtube-nocookie.com/embed/${ID}`);
  // Everything around the src is untouched.
  assert.match(normalizeEmbeds(iframe(`https://youtu.be/${ID}`)),
    /width="560" height="315" allowfullscreen/);
});

test('normalizeEmbeds leaves YouTube URLs that are not embeds alone', () => {
  const untouched = [
    'https://www.youtube.com/channel/UCabcdefghijklmnop',
    'https://www.youtube.com/playlist?list=PLabcdefghij',
    'https://www.youtube.com/results?search_query=cafe',
    'https://www.youtube.com/',
    'https://www.youtube.com/@somechannel',
  ];
  for (const src of untouched) {
    assert.equal(srcOf(normalizeEmbeds(iframe(src))), src, `should not rewrite ${src}`);
  }
});

test('normalizeEmbeds touches no other host, and no anchor', () => {
  for (const src of ['https://vimeo.com/video/123456', 'https://evil.example.com/embed/dQw4w9WgXcQ',
    'https://notyoutube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com.evil.test/embed/dQw4w9WgXcQ']) {
    assert.equal(srcOf(normalizeEmbeds(iframe(src))), src, `should not rewrite ${src}`);
  }
  // A link to a video is a link, not an embed: rewriting it to /embed/
  // would send the visitor to a bare player instead of the video page.
  const anchor = `<a href="https://youtu.be/${ID}">Watch our film</a>`;
  assert.equal(normalizeEmbeds(anchor), anchor);
});

test('normalised YouTube output passes the screen; an unknown host still fails', () => {
  // The whole point: the customer's own snippet publishes after this.
  const page = `<html><body>${iframe(`https://www.youtube.com/watch?v=${ID}`)}</body></html>`;
  assert.equal(findHardBlock(page).id, 'external_iframe', 'blocked before normalisation');
  assert.equal(findHardBlock(normalizeEmbeds(page)), null, 'passes after normalisation');

  // Normalisation must not become a way in for anything else.
  const bad = `<html><body>${iframe('https://evil.example.com/embed/x')}</body></html>`;
  assert.equal(findHardBlock(normalizeEmbeds(bad)).id, 'external_iframe');
});

test('a blocked embed reports the host that was refused', () => {
  const hit = findHardBlock(iframe('https://evil.example.com/thing'));
  assert.equal(hardBlockHost(hit), 'evil.example.com');
  // A rule with no URL behind it has no host to name.
  assert.equal(hardBlockHost(findHardBlock('<input type="password" name="p">')), null);
  assert.equal(hardBlockHost(null), null);
});

test('findHardBlock holds Google to the maps-embed path', () => {
  assert.equal(findHardBlock('<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>'), null);
  assert.equal(findHardBlock('<iframe src="https://www.google.com/search?q=x"></iframe>').id,
    'external_iframe');
});

test('findInlineRequest reports off-site calls from inline scripts only', () => {
  assert.equal(findInlineRequest('<script>fetch("https://evil.example.com/collect")</script>'),
    'https://evil.example.com/collect');
  // Same-origin and relative calls are how the site talks to us.
  assert.equal(findInlineRequest('<script>fetch("/api/forms")</script>'), null);
  assert.equal(findInlineRequest('<p>no script here</p>'), null);
});

// ---------- Stripe ----------

test('isMissingResource recognises a deleted object, not any error', () => {
  assert.equal(isMissingResource({ code: 'resource_missing' }), true);
  assert.equal(isMissingResource({ message: 'A similar object exists in test mode' }), true);
  assert.equal(isMissingResource({ code: 'card_declined' }), false);
  assert.equal(isMissingResource(null), false);
  assert.equal(isMissingResource(undefined), false);
});

// ---------- the webhook ----------
// CLAUDE.md: a change to lib/stripe.js or this route needs a check that
// the unhandled-event path returns 200. An event we do not handle must be
// acknowledged, or Stripe retries it forever.

function stripeSignature(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function webhookRequest(body, signature) {
  return new Request('https://lintelapp.co.uk/api/webhooks/stripe', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
  });
}

test('the webhook acknowledges an event it does not handle with 200', async () => {
  const { POST } = await load('app/api/webhooks/stripe/route.js');
  const body = JSON.stringify({
    id: 'evt_test_unhandled',
    type: 'customer.discount.created',   // nothing in the switch handles this
    data: { object: {} },
  });

  const res = await POST(webhookRequest(body, stripeSignature(body, process.env.STRIPE_WEBHOOK_SECRET)));

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
});

test('the webhook rejects an unsigned or mis-signed event with 400', async () => {
  const { POST } = await load('app/api/webhooks/stripe/route.js');
  const body = JSON.stringify({ id: 'evt_test_bad', type: 'customer.discount.created', data: { object: {} } });

  // Signed with the wrong secret: verification must fail closed.
  const wrong = await POST(webhookRequest(body, stripeSignature(body, 'whsec_a_different_secret')));
  assert.equal(wrong.status, 400);

  const garbage = await POST(webhookRequest(body, 't=1,v1=deadbeef'));
  assert.equal(garbage.status, 400);
});
