/* ============================================================
   Lumen Voice — speak to build.

   Uses the browser's built-in speech recognition and synthesis.
   Nothing is recorded or stored by us; the browser handles it.

   Support: Chrome, Edge and most Chromium browsers handle this
   well. Safari is partial. Firefox does not support recognition,
   so we always keep typing available.
   ============================================================ */
(function () {
  if (window.LumenVoice) return;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var synth = window.speechSynthesis || null;

  var V = {
    supported: !!SR,
    canSpeak: !!synth,
    listening: false,
    speaking: false,
  };

  var rec = null;
  var handlers = {};

  function emit(name, payload) {
    (handlers[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[voice]', e); }
    });
  }

  V.on = function (name, fn) {
    (handlers[name] = handlers[name] || []).push(fn);
    return V;
  };

  // ---------- listening ----------
  V.listen = function (opts) {
    opts = opts || {};
    if (!SR) { emit('unsupported'); return false; }
    if (V.listening) return true;

    rec = new SR();
    rec.lang = opts.lang || 'en-GB';
    rec.continuous = !!opts.continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    var finalText = '';
    var lastInterim = '';
    var silenceTimer = null;

    function bestText() {
      var t = (finalText + ' ' + lastInterim).trim();
      return t.replace(/\s+/g, ' ');
    }

    rec.onstart = function () {
      V.listening = true;
      emit('start');
    };

    rec.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var chunk = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += chunk + ' ';
        else interim += chunk;
      }
      lastInterim = interim;
      emit('transcript', { final: finalText.trim(), interim: interim.trim(), text: bestText() });

      // Stop automatically after a pause, so people don't have to press anything.
      if (opts.autoStop !== false) {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(function () {
          if (V.listening) { try { rec.stop(); } catch (e) {} }
        }, opts.silenceMs || 2200);
      }
    };

    rec.onerror = function (ev) {
      V.listening = false;
      // 'no-speech' and 'aborted' are normal, not worth alarming anyone about
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        emit('denied');
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        emit('error', ev.error);
      }
    };

    rec.onend = function () {
      V.listening = false;
      clearTimeout(silenceTimer);
      // Use the final transcript if we got one, otherwise whatever was heard.
      emit('end', { text: bestText() });
    };

    try { rec.start(); } catch (e) { /* already running */ }
    return true;
  };

  V.stop = function () {
    if (rec && V.listening) {
      try { rec.stop(); } catch (e) {}
    }
  };

  V.abort = function () {
    if (rec) {
      try { rec.abort(); } catch (e) {}
    }
    V.listening = false;
  };

  // ---------- speaking ----------
  var preferredVoice = null;

  function pickVoice() {
    if (!synth) return null;
    var voices = synth.getVoices();
    if (!voices.length) return null;
    // A calm British voice suits Lumen; fall back sensibly.
    var order = ['Google UK English Female', 'Google UK English', 'Serena', 'Kate', 'Daniel', 'Samantha'];
    for (var i = 0; i < order.length; i++) {
      var found = voices.find(function (v) { return v.name === order[i]; });
      if (found) return found;
    }
    return voices.find(function (v) { return v.lang === 'en-GB'; }) ||
           voices.find(function (v) { return v.lang.indexOf('en') === 0; }) ||
           voices[0];
  }

  if (synth) {
    preferredVoice = pickVoice();
    synth.onvoiceschanged = function () { preferredVoice = pickVoice(); };
  }

  V.say = function (text, opts) {
    if (!synth || !text) return;
    opts = opts || {};
    try {
      synth.cancel();
      var u = new SpeechSynthesisUtterance(String(text).slice(0, 400));
      if (preferredVoice) u.voice = preferredVoice;
      u.lang = 'en-GB';
      u.rate = opts.rate || 1.0;
      u.pitch = opts.pitch || 1.0;
      u.volume = opts.volume == null ? 1 : opts.volume;
      u.onstart = function () { V.speaking = true; emit('speak-start'); };
      u.onend = function () { V.speaking = false; emit('speak-end'); };
      synth.speak(u);
    } catch (e) { /* speech is a nicety, never a blocker */ }
  };

  V.hush = function () {
    if (synth) { try { synth.cancel(); } catch (e) {} }
    V.speaking = false;
  };

  // Remember whether the person wants spoken replies.
  V.voiceReplies = function (set) {
    try {
      if (set === undefined) return localStorage.getItem('lumen_voice_replies') === '1';
      localStorage.setItem('lumen_voice_replies', set ? '1' : '0');
      return set;
    } catch (e) { return false; }
  };

  window.LumenVoice = V;
})();
