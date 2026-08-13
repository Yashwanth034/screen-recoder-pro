// Click ripple overlay — makes recordings look like a polished
// tutorial/course video: a quick golden ripple at every click.
//
// Both recording modes render the overlay as REAL page DOM (the same
// trick as the annotation system): getDisplayMedia captures the rendered
// tab, so anything on the page is automatically in the recording.
//
//   - Area mode: selector.js (injected together with this file) calls
//     SRPEffects.start() once recording begins.
//   - Screen mode: background.js injects this file alone into the active
//     tab and a small bootstrap calls start(). Effects only appear on
//     pages a content script can reach — clicks inside native apps can't
//     be detected by a browser extension, so they simply don't show. The
//     bootstrap also polls isRecording so effects tear down on stop (and
//     on crashes/reloads) without any extra message.
//
// The overlay's styles are injected by this module itself as a <style>
// tag — screen mode never loads selector.css, and without the rules the
// ripples would render as invisible unstyled divs (the bug that made
// click effects silently do nothing). The module is a no-op when the
// effect is disabled, and start() is idempotent so re-injection
// (repeated recordings on the same tab) is safe. Declared with var,
// matching the other shared modules.

var SRPEffects = (function () {
  'use strict';

  // Page-wide dedupe: effects.js can be injected into the SAME tab by
  // both modes (area mode bundles it with selector.js; screen mode
  // re-injects it fresh on every recording, and a quick stop→restart can
  // overlap the old instance's poll). Each raw script execution would
  // otherwise build a SECOND module with its own pointerdown listener,
  // so one physical click spawned TWO ripples at once (the
  // "double-click ripple" in the footage). Reusing one shared instance
  // per page guarantees exactly one listener regardless of how many
  // times the file runs. Node (unit tests) has no window, so the guard
  // is skipped there and each require() gets a fresh instance.
  if (typeof window !== 'undefined' && window.__SRP_EFFECTS_SINGLETON) {
    return window.__SRP_EFFECTS_SINGLETON;
  }

  let running = false;
  let overlay = null;
  const ripples = new Set();
  const listeners = [];
  const RIPPLE_MS = 700;

  // The ripple styles, injected once into the host page on first start.
  // Exported as a constant so the tests can pin the rules down — a
  // regression that drops the ripple CSS would silently make every
  // ripple invisible.
  const EFFECTS_CSS = `
#srp-effects-overlay {
  position: fixed !important;
  inset: 0 !important;
  pointer-events: none !important;
  z-index: 2147483645 !important;
  overflow: hidden !important;
}

.srp-click-ripple {
  position: absolute !important;
  width: 34px !important;
  height: 34px !important;
  margin-left: -17px !important;
  margin-top: -17px !important;
  border: 3px solid rgba(255, 224, 102, 0.95) !important;
  border-radius: 50% !important;
  background: radial-gradient(circle, rgba(255, 224, 102, 0.45) 0%, rgba(255, 224, 102, 0) 70%) !important;
  box-shadow: 0 0 12px rgba(255, 200, 60, 0.65) !important;
  animation: srp-ripple-pop 0.55s cubic-bezier(0.22, 0.8, 0.35, 1) forwards !important;
  pointer-events: none !important;
}

@keyframes srp-ripple-pop {
  0% {
    transform: scale(0.35);
    opacity: 1;
  }
  100% {
    transform: scale(1.9);
    opacity: 0;
  }
}
`;

  // A fixed, full-viewport, pointer-events:none layer holds every effect
  // element. clientX/clientY are viewport coordinates, so a fixed overlay
  // needs no math and is immune to the page's own positioning (a page
  // with a transformed/positioned ancestor would otherwise turn an
  // absolutely-positioned body child into a mis-anchored ripple).
  function ensureOverlay() {
    // The styles go in once (a <style> in <head>), regardless of how
    // many times start() runs or which mode injected this file.
    if (!document.getElementById('srp-effects-style')) {
      const style = document.createElement('style');
      style.id = 'srp-effects-style';
      style.textContent = EFFECTS_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    if (overlay && overlay.isConnected) return;
    overlay = document.createElement('div');
    // Deliberately NOT 'srp-overlay' — that id is the drag-to-select
    // surface in selector.js, and the effects CSS sets pointer-events:
    // none, which would silently break area selection if shared.
    overlay.id = 'srp-effects-overlay';
    document.body.appendChild(overlay);
  }

  function isOwnUi(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest(
      '#srp-widget, #srp-annotate-canvas, #srp-webcam-bubble, .srp-text-box, ' +
      '.srp-blur-surface, .srp-blur-stroke, #srp-effects-overlay, #srp-countdown, ' +
      '#srp-fatal, #srp-warning, .srp-click-ripple'
    );
  }

  function spawnRipple(x, y) {
    ensureOverlay();
    const el = document.createElement('div');
    el.className = 'srp-click-ripple';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    overlay.appendChild(el);
    ripples.add(el);
    const done = () => {
      ripples.delete(el);
      el.remove();
    };
    el.addEventListener('animationend', done);
    setTimeout(done, RIPPLE_MS + 50);
  }

  // Starts the overlay. opts: { clickEffects }. Idempotent; a no-op when
  // the effect is off.
  function start(opts) {
    if (running) return;
    opts = opts || {};
    const clickOn = opts.clickEffects !== false;
    if (!clickOn) return;
    running = true;
    const onDown = (e) => {
      // Primary button only — a right-click (context menu) would
      // otherwise leave a stray ripple in the footage.
      if (e.button !== 0) return;
      if (!isOwnUi(e.target)) spawnRipple(e.clientX, e.clientY);
    };
    window.addEventListener('pointerdown', onDown, true);
    listeners.push(() => window.removeEventListener('pointerdown', onDown, true));
    ensureOverlay();
  }

  function stop() {
    if (!running) return;
    running = false;
    listeners.forEach((fn) => fn());
    listeners.length = 0;
    ripples.forEach((el) => el.remove());
    ripples.clear();
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  // Explicit stop (background.js sends this on recording stop). The
  // polling bootstrap is the safety net; this makes teardown instant.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.action === 'SRP_EFFECTS_STOP') stop();
    });
  }

  const api = { start, stop, EFFECTS_CSS };
  // Re-injections return the SAME object, so window.SRPEffects (which the
  // bootstrap in background.js and selector.js both call) always refers
  // to the one live instance — and its single pointerdown listener.
  if (typeof window !== 'undefined') {
    window.__SRP_EFFECTS_SINGLETON = api;
  }
  return api;
})();

// Node test hook — the browser build never defines `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SRPEffects };
}
