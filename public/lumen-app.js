/* ============================================================
   Lumen — shared browser helpers
   Loaded by every page. Handles:
     - connecting to Supabase (auth), fetched only when needed
     - knowing who is signed in
     - calling your API with the right token
   ============================================================ */
(function () {
  const Lumen = {};
  let supabase = null;
  let readyPromise = null;
  let configPromise = null;
  let libraryPromise = null;

  // supabase-js is ~55 KB from a CDN. It used to be a render-blocking tag on
  // every page; now it is fetched the first time a page actually needs auth,
  // so signed-out visitors to marketing pages never download it.
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

  // ---------- error monitoring ----------
  // Loaded from Sentry's CDN rather than bundled: these pages have no
  // build step. Entirely best-effort — a blocked or failed CDN must
  // never stop the app loading, so nothing here is awaited.
  let monitoringStarted = false;
  function startErrorMonitoring(dsn) {
    // A page can opt out entirely: reset.html must load nothing third-party,
    // so it sets this before including us. Checked here rather than at the
    // call site so no path can reach the CDN.
    if (window.__lumenNoMonitoring) return;
    if (!dsn || monitoringStarted) return;
    monitoringStarted = true;
    try {
      const s = document.createElement('script');
      s.src = 'https://browser.sentry-cdn.com/10.73.0/bundle.min.js';
      s.crossOrigin = 'anonymous';
      s.onload = function () {
        try {
          window.Sentry.init({
            dsn,
            sampleRate: 1.0,
            tracesSampleRate: 0,
            sendDefaultPii: false,
            // The page the customer is on is a URL, not content, but a
            // builder brief or an enquiry never leaves the browser.
            beforeSend(event) {
              try {
                if (event.request) { delete event.request.data; delete event.request.cookies; }
                if (event.user) event.user = undefined;
                const strip = (t) => String(t || '')
                  .replace(/\b[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}\b/gi, '[email removed]');
                if (event.message) event.message = strip(event.message);
                (event.exception && event.exception.values || []).forEach((ex) => {
                  if (ex.value) ex.value = strip(ex.value);
                });
                return event;
              } catch (e) { return null; }
            },
          });
        } catch (e) { /* never break the page over monitoring */ }
      };
      document.head.appendChild(s);
    } catch (e) { /* same */ }
  }

  // ---------- setup ----------
  // Our own pages are plain HTML in /public, not part of the Next build, so
  // @sentry/nextjs's client instrumentation never sees them. The browser SDK
  // starts here instead, off the same config call auth needs.
  function loadConfig() {
    if (!configPromise) {
      configPromise = fetch('/api/config')
        .then((res) => res.json())
        .then((cfg) => { startErrorMonitoring(cfg.sentryDsn); return cfg; });
    }
    return configPromise;
  }

  function loadSupabaseLibrary() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (!libraryPromise) {
      libraryPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SUPABASE_JS;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          libraryPromise = null;
          reject(new Error('Could not load sign-in — check your connection and try again.'));
        };
        document.head.appendChild(s);
      });
    }
    return libraryPromise;
  }

  // Runs a task on the visitor's first interaction, or a few seconds after the
  // page has loaded, whichever comes first. Keeps non-essential work out of the
  // window where the page's loading speed (LCP) is measured.
  function afterInteractionOrDelay(fn, delay = 6000) {
    let done = false;
    const events = ['pointermove', 'pointerdown', 'wheel', 'touchstart', 'scroll', 'keydown'];
    const run = () => {
      if (done) return;
      done = true;
      events.forEach((e) => window.removeEventListener(e, run));
      fn();
    };
    const arm = () => {
      events.forEach((e) => window.addEventListener(e, run, { passive: true }));
      setTimeout(run, delay);
    };
    if (document.readyState === 'complete') arm();
    else window.addEventListener('load', arm, { once: true });
  }

  Lumen.init = function () {
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      // Config and library in parallel: on pages that need auth, this is
      // the only wait between the page and knowing who is signed in.
      const [cfg] = await Promise.all([loadConfig(), loadSupabaseLibrary()]);
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        console.error('[lumen] Supabase config missing — check environment variables');
        return null;
      }
      supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      Lumen.supabase = supabase;
      return supabase;
    })();

    return readyPromise;
  };

  // Supabase keeps a session in localStorage under sb-<project>-auth-token
  // (plus a code verifier during an OAuth round trip). With neither, and no
  // auth tokens in the URL, nobody is signed in on this browser, so pages can
  // skip loading auth entirely. A false positive only means we check properly.
  Lumen.mightBeSignedIn = function () {
    try {
      if (/access_token=|[?&]code=/.test(window.location.hash + window.location.search)) return true;
      for (let i = 0; i < localStorage.length; i++) {
        if (/^sb-.+-auth-token/.test(localStorage.key(i) || '')) return true;
      }
      return false;
    } catch (e) {
      return true; // storage unavailable: ask Supabase rather than guess
    }
  };

  // ---------- who's signed in ----------
  Lumen.session = async function () {
    await Lumen.init();
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session || null;
  };

  Lumen.user = async function () {
    const s = await Lumen.session();
    return s ? s.user : null;
  };

  // Send people to sign-up if they aren't signed in.
  Lumen.requireAuth = async function (redirectTo) {
    const s = await Lumen.session();
    if (!s) {
      window.location.href = redirectTo || '/start';
      return null;
    }
    return s;
  };

  // ---------- auth actions ----------
  Lumen.signUp = async function (email, password, name) {
    await Lumen.init();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name: name || '' } },
    });
    if (error) throw new Error(friendly(error.message));
    return data;
  };

  Lumen.signIn = async function (email, password) {
    await Lumen.init();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendly(error.message));
    return data;
  };

  Lumen.signOut = async function () {
    await Lumen.init();
    await supabase.auth.signOut();
    window.location.href = '/';
  };

  // ---------- calling your API ----------
  Lumen.api = async function (path, options = {}) {
    const session = await Lumen.session();
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );
    if (session) headers['Authorization'] = 'Bearer ' + session.access_token;

    const res = await fetch(path, Object.assign({}, options, { headers }));
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }

    if (!res.ok) {
      const err = new Error((body && body.error) || 'Something went wrong');
      err.status = res.status;
      err.data = body || {};
      throw err;
    }
    return body;
  };

  // ---------- small helpers ----------
  function friendly(msg) {
    const m = String(msg || '');
    if (m.includes('already registered')) return 'That email already has an account — try signing in.';
    if (m.includes('Invalid login')) return "That email and password don't match.";
    if (m.includes('at least 6')) return 'Password needs to be at least 6 characters.';
    if (m.includes('valid email')) return 'That email address looks incomplete.';
    return m;
  }

  // Reflects the real signed-in state across every page.
  Lumen.paintNav = async function () {
    let s = null;
    if (Lumen.mightBeSignedIn()) {
      try { s = await Lumen.session(); } catch (e) { /* offline etc. */ }
    } else {
      // Signed out: there is nothing to look up. Error monitoring still
      // starts, just after the page has finished loading and been used.
      afterInteractionOrDelay(() => { loadConfig().catch(() => {}); });
    }

    document.querySelectorAll('.signin').forEach((el) => {
      if (s) {
        el.textContent = 'Dashboard';
        el.setAttribute('href', '/dashboard');
      } else {
        el.textContent = 'Sign in';
        el.setAttribute('href', '/start');
      }
    });

    // "Start building" buttons route by auth state — checked again on click,
    // so a stale page never sends a signed-in person back to sign-up.
    document.querySelectorAll('[data-gate="build"]').forEach((el) => {
      el.setAttribute('href', s ? '/builder' : '/start');
      if (el.dataset.gateBound) return;
      el.dataset.gateBound = '1';
      el.addEventListener('click', async (ev) => {
        ev.preventDefault();
        let live = null;
        if (Lumen.mightBeSignedIn()) {
          try { live = await Lumen.session(); } catch (e) { /* treat as signed out */ }
        }
        window.location.href = live ? '/builder' : '/start';
      });
    });

    // Plan buttons: signed-in people go straight to checkout, no re-registering.
    document.querySelectorAll('a[href*="/start?plan="]').forEach((el) => {
      if (s) {
        const url = new URL(el.getAttribute('href'), window.location.origin);
        const plan = url.searchParams.get('plan');
        const billing = url.searchParams.get('billing');
        el.setAttribute('href', '/start?plan=' + plan + (billing ? '&billing=' + billing : ''));
      }
    });

    // Show who's signed in, so it's obvious the session is live.
    if (s && s.user) {
      document.querySelectorAll('.whoami').forEach((el) => {
        el.textContent = s.user.email;
      });
      document.body.classList.add('is-signed-in');
    } else {
      document.body.classList.add('is-signed-out');
    }
  };

  window.Lumen = Lumen;

  // Paint the nav as soon as the page is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Lumen.paintNav());
  } else {
    Lumen.paintNav();
  }
})();
