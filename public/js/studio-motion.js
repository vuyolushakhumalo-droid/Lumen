// Homepage motion: the hero film band, the showcase billboard's headlines
// and the Studio section.
//
// Adapted from licensed Animmaster components — Text Animations/14 (masked
// word reveal), Background Animations/10 (dot grid), Mouse Effects/18
// (cursor-ease layers), Hover Effects/1 (mouse-scale gallery) — plus the
// scroll parallax from Lintel's own motion kit (lib/motion-kit.js). This is
// for Lintel's marketing pages only and must never be sent to generated
// customer sites.
//
// Needs gsap + SplitText (public/js/gsap/) for the text reveals; the rest is
// plain JS. Nothing is hidden before this script runs, and every effect is
// skipped under prefers-reduced-motion.
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var hasSplit = !!(window.gsap && window.SplitText);
  if (hasSplit) gsap.registerPlugin(SplitText);

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // ---- Masked word reveal (Text Animations/14) ------------------------
  // Words rise from behind a mask. The split is reverted afterwards, so the
  // heading ends as the same plain text it started as.
  function riseWords(split, delay) {
    return gsap.to(split.words, {
      yPercent: 0, duration: 0.95, ease: 'expo.out', stagger: 0.065, delay: delay || 0,
      onComplete: function () { split.revert(); },
    });
  }

  function revealOnLoad(el) {
    var split = SplitText.create(el, { type: 'words', mask: 'words', wordsClass: 'sw' });
    gsap.set(split.words, { yPercent: 105 });
    riseWords(split, 0.05);
  }

  // Masks only once the heading is still below the fold, so it never
  // disappears in front of someone who is already looking at it.
  function revealOnScroll(el) {
    var r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return revealOnLoad(el);
    if (!('IntersectionObserver' in window)) return;
    var split = SplitText.create(el, { type: 'words', mask: 'words', wordsClass: 'sw' });
    gsap.set(split.words, { yPercent: 105 });
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      riseWords(split);
    }, { rootMargin: '0px 0px -12% 0px' });
    io.observe(el);
  }

  // ---- Dot grid background (Background Animations/10) -----------------
  // Dots light up near the cursor and scatter on click or tap, then spring
  // back. Draws only while on screen and while something is moving; DPR is
  // capped at 2. Under reduced motion it is one static frame.
  function dotGrid(root) {
    var canvas = root.querySelector('canvas');
    var ctx = canvas && canvas.getContext('2d');
    if (!ctx) return;

    var DOT = 3, GAP = 22, PROX = 130, SHOCK_RADIUS = 220, SHOCK = 5;
    var RETURN = 1.5, RESIST = 750, SPEED_TRIGGER = 100, MAX_SPEED = 5000;
    var BASE = [34, 45, 60], ACTIVE = [95, 224, 255];
    var BASE_STYLE = 'rgb(' + BASE.join(',') + ')';

    var dots = [], w = 0, h = 0, raf = 0, last = 0, visible = false, dirty = false;
    var pointer = { x: -9999, y: -9999, lastX: 0, lastY: 0, lastTime: 0 };

    function build() {
      var r = root.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width; h = r.height;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var cell = DOT + GAP;
      var cols = Math.floor((w + GAP) / cell), rows = Math.floor((h + GAP) / cell);
      var sx = (w - (cell * cols - GAP)) / 2 + DOT / 2, sy = (h - (cell * rows - GAP)) / 2 + DOT / 2;
      dots = [];
      for (var y = 0; y < rows; y++) {
        for (var x = 0; x < cols; x++) dots.push({ cx: sx + x * cell, cy: sy + y * cell, ox: 0, oy: 0, vx: 0, vy: 0 });
      }
      draw(0);
    }

    // One physics step and one render. Returns whether any dot is still moving.
    function draw(dtMs) {
      var dt = dtMs / 1000, omega = 8 / RETURN, k = omega * omega, c = 2 * omega;
      var drag = Math.exp(-dtMs / RESIST), prox2 = PROX * PROX, moving = false;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      var lit = [];
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        if (dtMs) {
          d.vx += (-k * d.ox - c * d.vx) * dt; d.vy += (-k * d.oy - c * d.vy) * dt;
          d.vx *= drag; d.vy *= drag;
          d.ox += d.vx * dt; d.oy += d.vy * dt;
          if (Math.abs(d.ox) > 0.05 || Math.abs(d.oy) > 0.05 || Math.abs(d.vx) > 0.5 || Math.abs(d.vy) > 0.5) moving = true;
        }
        var dx = d.cx - pointer.x, dy = d.cy - pointer.y, dsq = dx * dx + dy * dy;
        if (dsq < prox2) { lit.push(d, 1 - Math.sqrt(dsq) / PROX); continue; }
        ctx.moveTo(d.cx + d.ox + DOT / 2, d.cy + d.oy);
        ctx.arc(d.cx + d.ox, d.cy + d.oy, DOT / 2, 0, 6.2832);
      }
      ctx.fillStyle = BASE_STYLE;
      ctx.fill();
      for (var j = 0; j < lit.length; j += 2) {
        var p = lit[j], t = lit[j + 1];
        ctx.fillStyle = 'rgb(' + Math.round(BASE[0] + (ACTIVE[0] - BASE[0]) * t) + ',' +
          Math.round(BASE[1] + (ACTIVE[1] - BASE[1]) * t) + ',' + Math.round(BASE[2] + (ACTIVE[2] - BASE[2]) * t) + ')';
        ctx.beginPath();
        ctx.arc(p.cx + p.ox, p.cy + p.oy, DOT / 2 + t, 0, 6.2832);
        ctx.fill();
      }
      return moving;
    }

    function frame(now) {
      raf = 0;
      var dtMs = Math.min(32, now - last);
      last = now;
      var moving = draw(dtMs);
      if (visible && (moving || dirty)) raf = requestAnimationFrame(frame);
      dirty = false;
    }
    function wake() {
      if (raf || !visible || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function sleep() { if (raf) cancelAnimationFrame(raf); raf = 0; }

    build();
    var pending = 0;
    new ResizeObserver(function () {
      if (pending) return;
      pending = requestAnimationFrame(function () { pending = 0; build(); });
    }).observe(root);
    if (reduce) return;

    function local(e) {
      var r = root.getBoundingClientRect();
      pointer.x = e.clientX - r.left; pointer.y = e.clientY - r.top;
    }
    function push(cx, cy, radius, scale, vx, vy) {
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i], dist = Math.hypot(d.cx - cx, d.cy - cy);
        if (dist >= radius) continue;
        var fall = 1 - dist / radius;
        d.vx += (d.cx - cx + vx * 0.01) * fall * scale;
        d.vy += (d.cy - cy + vy * 0.01) * fall * scale;
      }
    }

    root.addEventListener('mousemove', function (e) {
      var now = performance.now();
      var dt = pointer.lastTime ? Math.max(1, now - pointer.lastTime) : 16;
      if (now - pointer.lastTime < 16) { local(e); dirty = true; return wake(); }
      var vx = ((e.clientX - pointer.lastX) / dt) * 1000, vy = ((e.clientY - pointer.lastY) / dt) * 1000;
      var sp = Math.hypot(vx, vy);
      if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; sp = MAX_SPEED; }
      pointer.lastTime = now; pointer.lastX = e.clientX; pointer.lastY = e.clientY;
      local(e);
      if (sp > SPEED_TRIGGER) push(pointer.x, pointer.y, PROX, 12, vx, vy);
      dirty = true;
      wake();
    }, { passive: true });
    root.addEventListener('mouseleave', function () { pointer.x = pointer.y = -9999; dirty = true; wake(); });
    root.addEventListener('click', function (e) {
      local(e);
      push(pointer.x, pointer.y, SHOCK_RADIUS, SHOCK * 18, 0, 0);
      dirty = true;
      wake();
    });

    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) { dirty = true; wake(); } else sleep();
    }).observe(root);
    document.addEventListener('visibilitychange', function () { if (document.hidden) sleep(); else wake(); });
  }

  // ---- Card layers ease toward the cursor (Mouse Effects/18) ----------
  // Each layer follows a delayed copy of the cursor, so the card separates
  // into depth as it moves. Runs only while the cursor is in the zone or
  // the layers are still settling.
  function cursorLayers(card) {
    var layers = [].slice.call(card.querySelectorAll('[data-layer]'));
    if (!layers.length) return;
    var zone = card.closest('[data-cursor-zone]') || card;
    var SENSITIVITY = 0.05, LERP = 0.08, STAGGER = 6;
    var mouse = { x: 0, y: 0 }, trail = [], raf = 0, active = false;
    var state = layers.map(function (el, i) {
      return { el: el, delay: (layers.length - 1 - i) * STAGGER, depth: Number(el.getAttribute('data-layer')) || 1, x: 0, y: 0 };
    });

    function tick() {
      raf = 0;
      var r = card.getBoundingClientRect();
      trail.push({ x: mouse.x * r.width * SENSITIVITY, y: mouse.y * r.height * SENSITIVITY });
      if (trail.length > layers.length * STAGGER + 1) trail.shift();
      var newest = trail[trail.length - 1];
      var busy = trail[0].x !== newest.x || trail[0].y !== newest.y;
      state.forEach(function (s) {
        var t = trail[Math.max(0, trail.length - 1 - s.delay)];
        var tx = t.x * s.depth, ty = t.y * s.depth;
        s.x += (tx - s.x) * LERP; s.y += (ty - s.y) * LERP;
        if (Math.abs(tx - s.x) > 0.1 || Math.abs(ty - s.y) > 0.1) busy = true;
        s.el.style.transform = 'translate3d(' + s.x.toFixed(2) + 'px,' + s.y.toFixed(2) + 'px,0)';
      });
      if (busy || active) raf = requestAnimationFrame(tick);
    }
    function start() { if (!raf) raf = requestAnimationFrame(tick); }

    zone.addEventListener('mousemove', function (e) {
      var r = zone.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
      mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
      active = true;
      start();
    }, { passive: true });
    zone.addEventListener('mouseleave', function () { mouse.x = 0; mouse.y = 0; active = false; start(); });
  }

  // ---- Scroll parallax on touch (Lintel motion kit, lk-parallax) ------
  // The media drifts more slowly than the page. Listens to scroll only
  // while the card is near the viewport.
  function scrollParallax(el) {
    var ticking = false, listening = false;
    function run() {
      ticking = false;
      var r = el.parentElement.getBoundingClientRect();
      if (!r.height) return;
      var p = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
      var s = Number(el.getAttribute('data-speed')) || 0.6;
      el.style.transform = 'translate3d(0,' + (p * (1 - s) * -80).toFixed(2) + 'px,0)';
    }
    function queue() { if (!ticking) { ticking = true; requestAnimationFrame(run); } }
    function listen(on) {
      if (on === listening) return;
      listening = on;
      window[on ? 'addEventListener' : 'removeEventListener']('scroll', queue, { passive: true });
      if (on) queue();
    }
    if (!('IntersectionObserver' in window)) return listen(true);
    new IntersectionObserver(function (entries) { listen(entries[0].isIntersecting); }, { rootMargin: '25% 0px' })
      .observe(el.parentElement);
    window.addEventListener('resize', queue);
  }

  // ---- Two-tile gallery: one side widens (Hover Effects/1) -----------
  // Tiles rest at equal halves. With a mouse, the split follows the cursor
  // and eases back to 50/50 when it leaves. On touch, tapping a tile widens it
  // with the same easing; after 4s without a tap the tiles slowly trade width
  // on an 8s cycle, only while the row is on screen and never under reduced
  // motion, where a tap switches the widths without easing.
  function scaleGallery(row) {
    var a = row.children[0], b = row.children[1];
    if (!a || !b) return;
    var target = 50, current = 50, raf = 0, SPEED = 0.15, SPREAD = 12;
    function paint() {
      a.style.flexGrow = current.toFixed(3);
      b.style.flexGrow = (100 - current).toFixed(3);
    }
    function frame() {
      raf = 0;
      current += (target - current) * SPEED;
      if (Math.abs(target - current) < 0.05) current = target;
      else raf = requestAnimationFrame(frame);
      paint();
    }
    function go(t) { target = t; if (!raf) raf = requestAnimationFrame(frame); }

    if (finePointer) {
      if (reduce) return;
      row.addEventListener('mousemove', function (e) {
        var r = row.getBoundingClientRect();
        go(50 + SPREAD - ((e.clientX - r.left) / r.width) * SPREAD * 2);
      }, { passive: true });
      row.addEventListener('mouseleave', function () { go(50); });
      return;
    }

    var IDLE = 4000, CYCLE = 8000;
    var visible = false, idle = 0, cycling = false, cycleRaf = 0, cycleStart = 0, phase = 0;
    function stopCycle() {
      cycling = false;
      if (cycleRaf) cancelAnimationFrame(cycleRaf);
      cycleRaf = 0;
    }
    function cycle(now) {
      cycleRaf = 0;
      if (!cycling) return;
      go(50 + SPREAD * Math.sin(phase + ((now - cycleStart) / CYCLE) * 2 * Math.PI));
      cycleRaf = requestAnimationFrame(cycle);
    }
    function startCycle() {
      idle = 0;
      if (reduce || !visible || cycling) return;
      // Pick up from wherever the tiles are, so the cycle never jumps.
      phase = Math.asin(Math.max(-1, Math.min(1, (current - 50) / SPREAD)));
      cycleStart = performance.now();
      cycling = true;
      cycleRaf = requestAnimationFrame(cycle);
    }
    function waitForIdle() {
      clearTimeout(idle);
      idle = 0;
      if (!reduce && visible) idle = setTimeout(startCycle, IDLE);
    }
    [a, b].forEach(function (tile, i) {
      tile.addEventListener('click', function () {
        stopCycle();
        var t = 50 + (i === 0 ? SPREAD : -SPREAD);
        if (reduce) { target = current = t; paint(); } else go(t);
        waitForIdle();
      });
    });
    if (!('IntersectionObserver' in window)) { visible = true; return waitForIdle(); }
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) waitForIdle();
      else {
        clearTimeout(idle);
        idle = 0;
        stopCycle();
        // Freeze where it is; the cycle picks up from here when it comes back.
        if (raf) { cancelAnimationFrame(raf); raf = 0; target = current; }
      }
    }).observe(row);
  }

  // ---- Hero film band: scroll parallax on every device (motion kit) ---
  // The kit's lk-parallax formula (drift = distance scrolled x (1 - speed) x
  // 80px per viewport), anchored at the top of the page. This script arrives
  // on the first interaction, and the plain formula already offsets a band
  // that starts on screen, which would make it jump when it loads. The drift
  // stops growing after 60% of a viewport, so the band never reaches the
  // billboard below it.
  function bandParallax(el) {
    var s = Number(el.getAttribute('data-speed')) || 0.5;
    var ticking = false, listening = false;
    function run() {
      ticking = false;
      var vh = window.innerHeight || 1, y = Math.min(Math.max(0, window.scrollY), vh * 0.6);
      el.style.transform = y ? 'translate3d(0,' + ((y / vh) * (1 - s) * 80).toFixed(2) + 'px,0)' : '';
    }
    function queue() { if (!ticking) { ticking = true; requestAnimationFrame(run); } }
    function listen(on) {
      if (on === listening) return;
      listening = on;
      window[on ? 'addEventListener' : 'removeEventListener']('scroll', queue, { passive: true });
      if (on) queue();
    }
    window.addEventListener('resize', queue);
    if (!('IntersectionObserver' in window)) return listen(true);
    new IntersectionObserver(function (entries) { listen(entries[0].isIntersecting); }, { rootMargin: '25% 0px' })
      .observe(el);
  }

  // ---- Showcase billboard: headline words rise on every slide ----------
  // The carousel (cross-fade, timing, dots, Ken Burns, chat card) is CSS and
  // the inline script in index.html, so it runs before this has loaded; this
  // adds Text Animations/14 each time a slide comes in. The splits stay in
  // place so the rise can replay.
  function showcaseHeadlines(wrap) {
    var splits = [].map.call(wrap.querySelectorAll('.sc-slide'), function (slide) {
      var h = slide.querySelector('.sc-head');
      return h ? SplitText.create(h, { type: 'words', mask: 'words', wordsClass: 'sw' }) : null;
    });
    wrap.addEventListener('showcase:change', function (e) {
      var split = splits[e.detail && e.detail.index];
      if (!split) return;
      gsap.killTweensOf(split.words);
      gsap.fromTo(split.words, { yPercent: 105 }, { yPercent: 0, duration: 0.95, ease: 'expo.out', stagger: 0.065 });
    });
  }

  // ---- Studio card video ----------------------------------------------
  // Downloads and plays only once the card is near the viewport, and never
  // under reduced motion or Save-Data: the poster image stays instead.
  function lazyVideo(video) {
    var saveData = navigator.connection && navigator.connection.saveData;
    if (reduce || saveData) return;
    function start() {
      video.querySelectorAll('source[data-src]').forEach(function (s) {
        s.src = s.getAttribute('data-src');
        s.removeAttribute('data-src');
      });
      // The still image underneath stays visible until frames are actually playing.
      video.addEventListener('playing', function () { video.classList.add('is-playing'); }, { once: true });
      video.load();
      var played = video.play();
      if (played && played.catch) played.catch(function () {});
    }
    if (!('IntersectionObserver' in window)) return start();
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      start();
    }, { rootMargin: '300px 0px' });
    io.observe(video);
  }

  ready(function () {
    if (hasSplit && !reduce) {
      document.querySelectorAll('[data-reveal="load"]').forEach(revealOnLoad);
      document.querySelectorAll('[data-reveal="scroll"]').forEach(revealOnScroll);
      document.querySelectorAll('[data-showcase]').forEach(showcaseHeadlines);
    }
    document.querySelectorAll('[data-dot-grid]').forEach(dotGrid);
    document.querySelectorAll('video[data-lazy-video]').forEach(lazyVideo);
    // The gallery handles reduced motion itself (on touch a tap still switches widths).
    document.querySelectorAll('[data-scale-gallery]').forEach(scaleGallery);
    if (reduce) return;
    document.querySelectorAll('[data-band-parallax]').forEach(bandParallax);
    if (finePointer) {
      document.querySelectorAll('[data-cursor-layers]').forEach(cursorLayers);
    } else {
      document.querySelectorAll('[data-touch-parallax]').forEach(scrollParallax);
    }
  });
})();
