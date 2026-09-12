// ============================================================
// Lintel Motion Kit v0.1 — the CSS and JS every new build includes
// verbatim, so sites get their movement from one tested library rather
// than animation code the model improvises each time.
//
// This file is the source of truth. public/kit/lintel-motion-kit.html
// (served at /kit) is the demo and embeds these same two strings: edit
// them here, then run `node scripts/build-kit-demo.mjs`.
//
// When editing: no backticks or ${ (these are template literals), no
// "</style" or "</script" (they are pasted inside those tags), and no
// network calls of any kind — lib/publish.js hard-blocks those. Colours
// come from currentColor so the kit reads on light and dark sites alike.
// ============================================================

export const MOTION_KIT_CSS = `/* Lintel Motion Kit v0.1 — CSS. All motion is off under prefers-reduced-motion. */
:root{--lk-dur:600ms;--lk-ease:cubic-bezier(.2,.7,.2,1);--lk-accent:#4fd1e6}

/* 1) REVEAL — fade + rise once on entering the viewport. Hidden only once the kit script has run. */
.lk-js .lk-reveal{opacity:0;transform:translateY(16px);transition:opacity var(--lk-dur) var(--lk-ease),transform var(--lk-dur) var(--lk-ease)}
.lk-js .lk-reveal.is-in{opacity:1;transform:none}

/* 2) HERO DRIFT — zoom-settle on load, then a slow endless drift. Pair the image with lk-parallax. */
.lk-hero{position:relative;overflow:hidden;aspect-ratio:16/8;border-radius:16px;background:#111}
.lk-hero-img{position:absolute;inset:-6%;width:112%;height:112%;object-fit:cover;transform-origin:center;animation:lk-settle 1.6s var(--lk-ease) both,lk-drift 24s ease-in-out 1.6s infinite alternate;will-change:transform}
@keyframes lk-settle{from{scale:1.08}to{scale:1}}
@keyframes lk-drift{from{translate:0 0}to{translate:-1.5% 1%}}
.lk-hero-copy{position:absolute;left:6%;bottom:8%;color:#fff;max-width:26ch;text-shadow:0 2px 24px rgba(0,0,0,.5)}

/* 3) TILT — leans toward the cursor on desktop; static on touch. */
.lk-tilt{transform:perspective(900px) rotateX(var(--lk-rx,0deg)) rotateY(var(--lk-ry,0deg));transition:transform 300ms var(--lk-ease);will-change:transform}
.lk-tilt:hover{transition-duration:80ms}

/* 4) MARQUEE — seamless loop, pauses on hover. Items are written twice inside .lk-track. */
.lk-marquee{overflow:hidden;-webkit-mask:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.lk-track{display:flex;width:max-content;animation:lk-scroll 28s linear infinite}
.lk-track>*{flex:none;white-space:nowrap;margin-right:40px}
.lk-marquee:hover .lk-track{animation-play-state:paused}
@keyframes lk-scroll{to{transform:translateX(-50%)}}

/* 5) BENTO — six-column grid, first tile featured, hover lift; one column on phones. */
.lk-bento{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
.lk-bento>*{background:color-mix(in srgb,currentColor 5%,transparent);border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:14px;padding:22px;min-height:150px;transition:transform 260ms var(--lk-ease),box-shadow 260ms var(--lk-ease)}
.lk-bento>*:hover{transform:translateY(-6px);box-shadow:0 24px 40px -24px rgba(0,0,0,.45)}
.lk-bento>*:nth-child(1){grid-column:span 4;grid-row:span 2;background:color-mix(in srgb,currentColor 12%,transparent)}
.lk-bento>*:nth-child(n+2){grid-column:span 2}
@media (max-width:720px){.lk-bento>*{grid-column:span 6!important;grid-row:auto!important}}

/* 6) COUNT-UP — counts from 0 when seen. The real number stays in the markup. */
.lk-count{font-variant-numeric:tabular-nums}

/* 7) COMPARE — before/after slider on a native range input, so it works by keyboard and touch. */
.lk-compare{position:relative;aspect-ratio:16/9;overflow:hidden;border-radius:14px}
.lk-compare img,.lk-compare .before,.lk-compare .after{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.lk-compare .after{clip-path:inset(0 0 0 var(--lk-cut,50%))}
.lk-compare input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:ew-resize;margin:0}
.lk-compare .bar{position:absolute;top:0;bottom:0;left:var(--lk-cut,50%);width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.2);pointer-events:none}
.lk-compare .bar::after{content:"◀ ▶";position:absolute;top:50%;left:50%;translate:-50% -50%;background:#fff;color:#0f1318;font-size:11px;padding:6px 8px;border-radius:999px}
.lk-compare:has(input:focus-visible) .bar::after{outline:2px solid var(--lk-accent);outline-offset:2px}
.lk-compare .lbl{position:absolute;top:12px;padding:4px 10px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;pointer-events:none}

/* 8) ACCORDION — native details/summary; opens smoothly where the browser supports it. */
.lk-acc details{border-top:1px solid color-mix(in srgb,currentColor 18%,transparent)}
.lk-acc details:last-child{border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent)}
.lk-acc summary{cursor:pointer;list-style:none;padding:18px 0;font-weight:600;display:flex;justify-content:space-between;gap:16px}
.lk-acc summary::-webkit-details-marker{display:none}
.lk-acc summary::after{content:"+";transition:transform 300ms var(--lk-ease)}
.lk-acc details[open] summary::after{transform:rotate(45deg)}
.lk-acc .body{display:grid;grid-template-rows:0fr;transition:grid-template-rows 300ms var(--lk-ease)}
.lk-acc details[open] .body{grid-template-rows:1fr}
.lk-acc .body>div{overflow:hidden;padding-bottom:0;transition:padding 300ms}
.lk-acc details[open] .body>div{padding-bottom:18px}

/* Reduced motion: everything becomes static. */
@media (prefers-reduced-motion:reduce){
.lk-js .lk-reveal{opacity:1;transform:none;transition:none}
.lk-hero-img{animation:none;inset:0;width:100%;height:100%}
.lk-tilt{transform:none!important}
.lk-track{animation:none}
.lk-bento>*,.lk-acc .body,.lk-acc .body>div,.lk-acc summary::after{transition:none}
}`;

export const MOTION_KIT_JS = `/* Lintel Motion Kit v0.1 — JS. Every pattern checks prefers-reduced-motion first. */
/* ---- Reveal ---- */
(()=>{ if(matchMedia('(prefers-reduced-motion: reduce)').matches||!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('lk-js');
  const io=new IntersectionObserver(es=>es.forEach(e=>{ if(e.isIntersecting){ const d=+e.target.dataset.delay||0; setTimeout(()=>e.target.classList.add('is-in'),d); io.unobserve(e.target);} }),{threshold:.15});
  document.querySelectorAll('.lk-reveal').forEach(el=>io.observe(el)); })();

/* ---- Parallax (transform only, rAF-throttled) ---- */
(()=>{ if(matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const els=[...document.querySelectorAll('.lk-parallax')]; if(!els.length) return; let t=false;
  const run=()=>{ t=false; const vh=innerHeight; els.forEach(el=>{ const r=el.parentElement.getBoundingClientRect(); if(!r.height) return; const p=(r.top+r.height/2-vh/2)/vh; const s=+el.dataset.speed||0.6; el.style.transform='translateY('+(p*(1-s)*-80)+'px)'; }); };
  const queue=()=>{ if(!t){t=true;requestAnimationFrame(run);} };
  addEventListener('scroll',queue,{passive:true}); addEventListener('resize',queue); run(); })();

/* ---- Tilt ---- */
(()=>{ if(matchMedia('(prefers-reduced-motion: reduce)').matches||!matchMedia('(hover:hover)').matches) return;
  document.querySelectorAll('.lk-tilt').forEach(el=>{ el.addEventListener('pointermove',e=>{ const r=el.getBoundingClientRect(); const x=(e.clientX-r.left)/r.width-.5, y=(e.clientY-r.top)/r.height-.5; el.style.setProperty('--lk-ry',(x*12)+'deg'); el.style.setProperty('--lk-rx',(-y*12)+'deg'); });
    el.addEventListener('pointerleave',()=>{ el.style.setProperty('--lk-rx','0deg'); el.style.setProperty('--lk-ry','0deg'); }); }); })();

/* ---- Count-up (years: add data-plain; decimals follow data-to) ---- */
(()=>{ const els=document.querySelectorAll('.lk-count'); if(!els.length||matchMedia('(prefers-reduced-motion: reduce)').matches||!('IntersectionObserver' in window)) return;
  const fmt=(el,v,dp)=>el.hasAttribute('data-plain')?v.toFixed(dp):v.toLocaleString(undefined,{minimumFractionDigits:dp,maximumFractionDigits:dp});
  const io=new IntersectionObserver(es=>es.forEach(e=>{ if(!e.isIntersecting) return; const el=e.target, to=+el.dataset.to, dp=(el.dataset.to.split('.')[1]||'').length; io.unobserve(el);
    const t0=performance.now(), d=1400; const step=n=>{ const k=Math.max(0,Math.min(1,(n-t0)/d)), v=to*(1-Math.pow(1-k,3)); el.textContent=fmt(el,k<1?+v.toFixed(dp):to,dp); if(k<1) requestAnimationFrame(step); }; requestAnimationFrame(step); }),{threshold:.6});
  els.forEach(el=>{ if(!el.dataset.to||!isFinite(+el.dataset.to)) return; el.textContent=fmt(el,0,(el.dataset.to.split('.')[1]||'').length); io.observe(el); }); })();

/* ---- Compare ---- */
document.querySelectorAll('.lk-compare input').forEach(r=>{ const set=()=>r.parentElement.style.setProperty('--lk-cut',r.value+'%'); r.addEventListener('input',set); set(); });`;
