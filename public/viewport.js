// Keeps a full-height page inside the part of the screen you can actually see.
//
// On a phone `100vh` is the *large* viewport: it ignores the browser's own
// chrome and, worse, does not shrink when the on-screen keyboard opens. A
// bottom-anchored input on a `height:100vh` page therefore sits under the
// keyboard exactly when you are trying to type into it. visualViewport does
// report the real visible box, so publish it as --vh and let the pages use it.
(() => {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return; // 100dvh in the stylesheet is the fallback.

  let raf = 0;
  const apply = () => {
    raf = 0;
    root.style.setProperty('--vh', `${Math.round(vv.height)}px`);
    // Pinch-zoom and keyboard scroll can push the layout viewport up; nudge it
    // back so the bottom bar stays on screen rather than just off it.
    root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  };
  const schedule = () => { raf ||= requestAnimationFrame(apply); };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  apply();
})();
