// lib/analytics.js
//
// Injects the analytics beacon into published site HTML at SERVE time,
// exactly like lib/forms.js does for forms. Same two consequences: the
// model never writes the endpoint, and already-published sites start
// reporting without being regenerated.
//
// The beacon is cookieless -- it sets nothing, stores nothing on the
// device, and sends only the section, the referrer's host, and nothing
// else. Everything identifying is derived server-side and hashed.

/**
 * @param {string} html    the stored current_code
 * @param {string} siteId  sites.id — used to build the endpoint
 * @param {string} [origin] absolute origin; falls back to a same-origin path
 */
export function injectAnalytics(html, siteId, origin) {
  if (!html || !siteId) return html;

  const endpoint = `${origin ? origin.replace(/\/$/, '') : ''}/api/a/${siteId}`;
  const script = `<script>${beacon(endpoint)}</script>`;

  return html.includes('</body>')
    ? html.replace('</body>', `${script}</body>`)
    : html + script;
}

function beacon(endpoint) {
  return `
(function(){
  // Honour the opt-outs here as well as server-side, so a visitor who
  // has asked not to be tracked doesn't even generate a request.
  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' ||
        navigator.msDoNotTrack === '1' || navigator.globalPrivacyControl) return;
  } catch (e) {}

  if (!navigator.sendBeacon) return;

  var EP = ${JSON.stringify(endpoint)};

  // The referrer's HOST only -- never the full URL, which can carry
  // search terms or private paths. Same-site navigation isn't a referral.
  var ref = '';
  try {
    if (document.referrer) {
      var h = new URL(document.referrer).host;
      if (h && h !== location.host) ref = h;
    }
  } catch (e) {}

  // Generated sites are single-file with #anchor section navigation, so
  // the hash is the page the visitor is actually looking at.
  function section(){
    var s = (location.hash || '').replace(/^#/, '').slice(0, 60);
    return s || 'home';
  }

  var last = null;
  function send(){
    var s = section();
    if (s === last) return;          // hashchange can fire twice for one move
    last = s;
    try { navigator.sendBeacon(EP, JSON.stringify({ s: s, r: ref })); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', send);
  } else {
    send();
  }
  window.addEventListener('hashchange', send);
})();`;
}
