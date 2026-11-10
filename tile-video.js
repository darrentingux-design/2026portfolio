/* Plays the homepage tile videos (Alerts, Positive Pay) only when they can be seen.
   Loaded by apply_patches.py (a <script> tag before </body>), so it survives re-exports.
   Plays while the tile is on screen; pauses when scrolled away, when a case study is open
   (the home page is covered), when the browser tab is hidden, or if the visitor prefers reduced motion. */
(() => {
  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const visible = new WeakMap();
  const bound = new WeakSet();

  const shouldPlay = (v) => visible.get(v) === true && !document.hidden && !location.hash && !reduce.matches;
  const update = (v) => {
    if (shouldPlay(v)) {
      if (v.paused) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    } else if (!v.paused) {
      v.pause();
    }
  };
  const updateAll = () => document.querySelectorAll('video[data-tile-video]').forEach(update);

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => { visible.set(e.target, e.isIntersecting); update(e.target); }), { threshold: 0.2 })
    : null;

  // The page can swap nodes when it re-renders, so look for new videos now and then.
  const scan = () => {
    document.querySelectorAll('video[data-tile-video]').forEach((v) => {
      if (bound.has(v)) return;
      bound.add(v);
      v.muted = true; v.loop = true; v.playsInline = true;
      if (io) io.observe(v); else { visible.set(v, true); update(v); }
    });
  };
  scan();
  // The page changes the address without firing hashchange, so re-check the state on a short timer.
  setInterval(() => { scan(); updateAll(); }, 500);
  document.addEventListener('visibilitychange', updateAll);
  window.addEventListener('hashchange', updateAll);
  if (reduce.addEventListener) reduce.addEventListener('change', updateAll);
})();
