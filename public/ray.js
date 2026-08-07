/* ============================================================
   Ray — Lintel's AI advisor.
   A floating chat widget. Drop <script src="/ray.js"></script>
   on any page and it appears bottom-right.
   ============================================================ */
(function () {
  if (window.__rayLoaded) return;
  window.__rayLoaded = true;

  var CONTACT_EMAIL = 'vuyolushakhumalo@gmail.com';   // <- your real address
  var BOOKING_URL = '/contact';                // where to book a call

  var css = `
  .ray-fab{position:fixed;right:22px;bottom:22px;z-index:940;display:flex;align-items:center;gap:10px;
    padding:13px 20px 13px 16px;border:none;border-radius:980px;cursor:pointer;
    background:#5FE0FF;color:#04141B;font-family:'Inter',system-ui,sans-serif;font-size:14.5px;font-weight:600;
    box-shadow:0 14px 40px -12px rgba(95,224,255,.6);transition:transform .2s,box-shadow .25s,padding .25s,gap .25s}
  .ray-fab:hover{transform:translateY(-2px);box-shadow:0 18px 50px -12px rgba(95,224,255,.75)}
  .ray-fab svg{width:19px;height:19px}
  .ray-fab.hide{display:none}
  .ray-fab-label{display:inline-block;max-width:200px;opacity:1;overflow:hidden;white-space:nowrap;
    transition:max-width .25s ease,opacity .15s ease,margin .25s ease}

  body.generating .ray-fab{padding:13px;gap:0}
  body.generating .ray-fab-label{max-width:0;opacity:0;margin:0}

  .ray-panel{position:fixed;right:22px;bottom:22px;z-index:950;width:min(400px,calc(100vw - 32px));
    height:min(600px,calc(100vh - 48px));display:none;flex-direction:column;overflow:hidden;
    background:rgba(10,14,21,.97);backdrop-filter:blur(20px);
    border:1px solid rgba(255,255,255,.12);border-radius:22px;
    box-shadow:0 40px 100px -30px rgba(0,0,0,.9);
    font-family:'Inter',system-ui,sans-serif;color:#F5F6F9}
  .ray-panel.open{display:flex;animation:rayIn .28s cubic-bezier(.2,.7,.2,1)}
  @keyframes rayIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}

  .ray-head{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.07);flex:none}
  .ray-orb{width:38px;height:38px;border-radius:50%;flex:none;position:relative;
    background:radial-gradient(circle,#EAFBFF,#8DEBFF 30%,#5FE0FF 60%,rgba(95,224,255,.2) 80%);
    box-shadow:0 0 26px -4px rgba(95,224,255,.7);animation:rayPulse 3.2s ease-in-out infinite}
  @keyframes rayPulse{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.07);opacity:1}}
  .ray-name{font-size:15.5px;font-weight:600;line-height:1.2}
  .ray-sub{font-size:12px;color:#96A0AD;margin-top:2px}
  .ray-close{margin-left:auto;width:32px;height:32px;border-radius:50%;border:none;background:transparent;
    color:#96A0AD;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.2s}
  .ray-close:hover{color:#F5F6F9;background:rgba(255,255,255,.07)}
  .ray-close svg{width:17px;height:17px}

  .ray-body{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:16px;min-height:0}
  .ray-body::-webkit-scrollbar{width:7px}
  .ray-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:8px}

  .ray-msg{max-width:88%;font-size:14.5px;line-height:1.6;padding:12px 15px;border-radius:16px;white-space:pre-wrap}
  .ray-msg.ai{align-self:flex-start;background:rgba(255,255,255,.05);color:#EAEDF2;border-bottom-left-radius:6px}
  .ray-msg.me{align-self:flex-end;background:#5FE0FF;color:#04141B;border-bottom-right-radius:6px;font-weight:500}
  .ray-typing{align-self:flex-start;display:flex;gap:5px;padding:14px 16px;background:rgba(255,255,255,.05);border-radius:16px;border-bottom-left-radius:6px}
  .ray-typing i{width:6px;height:6px;border-radius:50%;background:#5FE0FF;animation:rayDot 1.3s ease-in-out infinite}
  .ray-typing i:nth-child(2){animation-delay:.16s}
  .ray-typing i:nth-child(3){animation-delay:.32s}
  @keyframes rayDot{0%,100%{opacity:.3;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}

  .ray-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
  .ray-chip{font-size:12.5px;color:#96A0AD;border:1px solid rgba(255,255,255,.12);background:transparent;
    padding:8px 13px;border-radius:980px;cursor:pointer;transition:.2s;font-family:inherit}
  .ray-chip:hover{color:#F5F6F9;border-color:rgba(95,224,255,.45);background:rgba(95,224,255,.06)}

  .ray-handover{align-self:flex-start;width:100%;border:1px solid rgba(95,224,255,.25);background:rgba(95,224,255,.06);
    border-radius:16px;padding:16px}
  .ray-handover p{font-size:13.5px;color:#96A0AD;margin:0 0 12px;line-height:1.5}
  .ray-handover .row{display:flex;gap:9px;flex-wrap:wrap}
  .ray-handover a{flex:1;min-width:130px;text-align:center;text-decoration:none;font-size:13.5px;font-weight:600;
    padding:10px 14px;border-radius:980px;transition:.2s}
  .ray-handover .primary{background:#5FE0FF;color:#04141B}
  .ray-handover .ghost{background:rgba(255,255,255,.06);color:#F5F6F9;border:1px solid rgba(255,255,255,.12)}

  .ray-foot{flex:none;padding:14px 16px 16px;border-top:1px solid rgba(255,255,255,.07)}
  .ray-inputwrap{display:flex;align-items:flex-end;gap:9px;border:1px solid rgba(255,255,255,.12);
    border-radius:18px;background:rgba(255,255,255,.03);padding:6px 6px 6px 15px;transition:.25s}
  .ray-inputwrap:focus-within{border-color:rgba(95,224,255,.5);box-shadow:0 0 30px -14px rgba(95,224,255,.7)}
  .ray-input{flex:1;background:transparent;border:none;outline:none;resize:none;color:#F5F6F9;
    font-family:inherit;font-size:14.5px;line-height:1.5;padding:9px 0;max-height:110px}
  .ray-input::placeholder{color:#5D6875}
  .ray-send{width:34px;height:34px;flex:none;border-radius:50%;border:none;background:#5FE0FF;color:#04141B;
    cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s}
  .ray-send:hover{transform:translateY(-1px)}
  .ray-send:disabled{opacity:.4;transform:none;cursor:default}
  .ray-send svg{width:16px;height:16px}
  .ray-note{font-size:11px;color:#5D6875;text-align:center;margin-top:10px}

  @media(max-width:520px){
    .ray-panel{right:8px;left:8px;bottom:8px;width:auto;height:calc(100vh - 16px);border-radius:18px}
    .ray-fab{right:14px;bottom:14px}
  }`;

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var wrap = document.createElement('div');
  wrap.innerHTML = `
  <button class="ray-fab" id="rayFab" aria-label="Chat with Ray">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <span class="ray-fab-label">Ask Ray</span>
  </button>

  <div class="ray-panel" id="rayPanel" role="dialog" aria-label="Chat with Ray, the AI advisor">
    <div class="ray-head">
      <div class="ray-orb"></div>
      <div>
        <div class="ray-name">Ray</div>
        <div class="ray-sub">AI advisor · replies instantly</div>
      </div>
      <button class="ray-close" id="rayClose" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="ray-body" id="rayBody"></div>

    <div class="ray-foot">
      <div class="ray-inputwrap">
        <textarea class="ray-input" id="rayInput" rows="1" placeholder="Ask me anything about Lintel…"></textarea>
        <button class="ray-send" id="raySend" aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
      </div>
      <div class="ray-note">Ray is an AI. A human is one click away whenever you need one.</div>
    </div>
  </div>`;
  document.body.appendChild(wrap);

  var fab = document.getElementById('rayFab');
  var panel = document.getElementById('rayPanel');
  var body = document.getElementById('rayBody');
  var input = document.getElementById('rayInput');
  var sendBtn = document.getElementById('raySend');

  var history = [];
  var started = false;
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function addMsg(role, text) {
    var el = document.createElement('div');
    el.className = 'ray-msg ' + (role === 'user' ? 'me' : 'ai');
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function addTyping() {
    var el = document.createElement('div');
    el.className = 'ray-typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function addHandover() {
    var el = document.createElement('div');
    el.className = 'ray-handover';
    el.innerHTML =
      '<p>Happy to pass you to a person — they will pick this up from here.</p>' +
      '<div class="row">' +
      '<a class="primary" href="mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent('Question for the Lintel team') + '">Email the team</a>' +
      '<a class="ghost" href="' + BOOKING_URL + '">Book a call</a>' +
      '</div>';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  function addChips(items) {
    var row = document.createElement('div');
    row.className = 'ray-chips';
    items.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'ray-chip';
      b.textContent = t;
      b.addEventListener('click', function () {
        row.remove();
        input.value = t;
        send();
      });
      row.appendChild(b);
    });
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  function greet() {
    if (started) return;
    started = true;
    addMsg('assistant', "Hello — I'm Ray, Lintel's AI advisor. Ask me anything about plans, building, or your account, and I'll bring in a human whenever that's more useful.");
    addChips(['How do the daily builds work?', 'Which plan should I pick?', 'Can I use my own domain?', 'Talk to a human']);
  }

  async function send() {
    var text = input.value.trim();
    if (!text || busy) return;

    addMsg('user', text);
    history.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto';

    busy = true;
    sendBtn.disabled = true;
    var typing = addTyping();

    try {
      var res = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      var data = await res.json();
      typing.remove();

      if (!res.ok) {
        addMsg('assistant', data.error || "Something went wrong on my end.");
        addHandover();
      } else {
        addMsg('assistant', data.reply);
        history.push({ role: 'assistant', content: data.reply });
        if (data.handover) addHandover();
      }
    } catch (e) {
      typing.remove();
      addMsg('assistant', "I couldn't reach the server just then. You can email the team instead.");
      addHandover();
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  fab.addEventListener('click', function () {
    panel.classList.add('open');
    fab.classList.add('hide');
    greet();
    setTimeout(function () { input.focus(); }, 120);
  });

  document.getElementById('rayClose').addEventListener('click', function () {
    panel.classList.remove('open');
    fab.classList.remove('hide');
  });

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  });

  // Let any page open Ray directly: <a data-ray-open>Ask Ray</a>
  document.querySelectorAll('[data-ray-open]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); fab.click(); });
  });
})();
