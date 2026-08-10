// lib/forms.js
//
// Wires up forms in published site HTML at SERVE time, not generate time.
// Two consequences worth keeping in mind:
//   - the model never writes an endpoint URL, so it can't hallucinate one
//   - already-published sites get working forms with no regeneration
//
// Called from app/s/[slug]/page.js and app/d/[host]/page.js, where the
// site row is already loaded.

const HONEYPOT = 'company_website';

// Matches an opening <form ...> tag carrying data-lintel-form.
const FORM_TAG = /<form\b([^>]*\bdata-lintel-form\b[^>]*)>/gi;

/**
 * @param {string} html      the stored current_code
 * @param {string} siteId    sites.id — used to build the endpoint
 * @param {string} [origin]  absolute origin for the endpoint; falls back
 *                           to a same-origin relative path
 */
export function injectForms(html, siteId, origin) {
  if (!html || !siteId) return html;
  if (!FORM_TAG.test(html)) return html;      // nothing to do
  FORM_TAG.lastIndex = 0;                      // regex is /g, reset after test

  const endpoint = `${origin ? origin.replace(/\/$/, '') : ''}/api/f/${siteId}`;

  // 1. Honeypot goes in server-side so the model can't omit it.
  const withHoneypot = html.replace(FORM_TAG, (m, attrs) =>
    `<form${attrs}>` +
    `<div aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden">` +
    `<label>Website<input type="text" name="${HONEYPOT}" tabindex="-1" autocomplete="off"></label>` +
    `</div>`
  );

  // 2. Handler before </body>, or appended if the model omitted one.
  const script = `<script>${handler(endpoint)}</script>`;
  return withHoneypot.includes('</body>')
    ? withHoneypot.replace('</body>', `${script}</body>`)
    : withHoneypot + script;
}

function handler(endpoint) {
  return `
(function(){
  var EP = ${JSON.stringify(endpoint)};
  function busy(f, on){
    var b = f.querySelector('[type=submit], button:not([type=button])');
    if (!b) return;
    if (on) { b.dataset.lintelLabel = b.textContent; b.disabled = true; b.textContent = 'Sending…'; }
    else { b.disabled = false; if (b.dataset.lintelLabel) b.textContent = b.dataset.lintelLabel; }
  }
  function note(f, msg, ok){
    var n = f.querySelector('.lintel-form-note');
    if (!n) {
      n = document.createElement('p');
      n.className = 'lintel-form-note';
      n.setAttribute('role', 'status');
      n.style.marginTop = '12px';
      f.appendChild(n);
    }
    n.textContent = msg;
    n.style.opacity = ok ? '1' : '.85';
  }
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (!f || !f.matches || !f.matches('[data-lintel-form]')) return;
    e.preventDefault();
    if (f.dataset.lintelSending === '1') return;

    var data = {};
    new FormData(f).forEach(function(v, k){ data[k] = typeof v === 'string' ? v : ''; });
    var kind = f.getAttribute('data-lintel-form');
    if (kind === 'list_signup' || kind === 'newsletter') data.__kind = 'list_signup';

    f.dataset.lintelSending = '1';
    busy(f, true);

    fetch(EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        return { status: r.status, body: j };
      });
    }).then(function(res){
      f.dataset.lintelSending = '';
      busy(f, false);
      if (res.status === 200) {
        f.reset();
        note(f, f.getAttribute('data-lintel-thanks') || 'Thanks — we have your message and will be in touch.', true);
      } else if (res.status === 429) {
        note(f, 'Too many messages just now. Please try again shortly.', false);
      } else {
        note(f, 'Something went wrong sending that. Please try again.', false);
      }
    }).catch(function(){
      f.dataset.lintelSending = '';
      busy(f, false);
      note(f, 'Could not send just now — please check your connection and try again.', false);
    });
  }, true);
})();
`.trim();
}

export { HONEYPOT };
