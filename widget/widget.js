const widgetEl = document.getElementById('widget');
const gripEl = document.getElementById('grip');
const statusEl = document.getElementById('status');
const dot = document.getElementById('dot');
const timerEl = document.getElementById('timer');
const pauseBtn = document.getElementById('pauseBtn');
const screenshotBtn = document.getElementById('screenshotBtn');
const stopBtn = document.getElementById('stopBtn');
const bubbleBtn = document.getElementById('bubbleBtn');
const pipBtn = document.getElementById('pipBtn');
const bubblePanel = document.getElementById('bubblePanel');
const bubbleMap = document.getElementById('bubbleMap');
const bubbleMapWrap = document.getElementById('bubbleMapWrap');
const bubbleDot = document.getElementById('bubbleDot');
const liveBadge = document.getElementById('liveBadge');
const mapHint = document.querySelector('.map-hint');

const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5.5v13M16 5.5v13" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M8.5 5.5l10 6.5-10 6.5z" fill="currentColor"/></svg>';
const MAP_HINT_BUBBLE = 'Drag the dot, or click anywhere, to move the bubble';
const MAP_HINT_NO_BUBBLE = 'Live preview — webcam bubble is off for this recording';

let intervalId = null;
let paused = false;
let lastDims = { w: 1920, h: 1080 };
let lastBubble = null;
let hasBubble = false;
let previewSeen = false;
// Open Document Picture-in-Picture preview window (see togglePipPreview
// below). Same-origin, so the widget can mirror the live frame + bubble
// position into it and it can send MOVE_BUBBLE straight to the recorder.
let pipWindow = null;

// ---------- Auto-fade ----------
// The widget is a real window, so a full-screen recording captures it
// whenever it's visible. Fading it to a faint ghost after a couple of
// seconds of inactivity keeps it out of the footage except for the
// moments the user is actually touching it. It fades even while the
// bubble panel is open — just less aggressively (65% vs 45% opacity) so
// it stays usable but barely shows in the recording.
let fadeTimer = null;

function scheduleFade() {
  clearTimeout(fadeTimer);
  const isPanelOpen = !bubblePanel.classList.contains('hidden');
  // Generous idle windows: while a recording runs, the user is usually
  // watching the page being captured, not the widget — a 6s idle (4s
  // with the bubble panel open) is long enough that a fade reads as
  // deliberate, never as a flicker mid-interaction.
  const delay = isPanelOpen ? 4000 : 6000;
  fadeTimer = setTimeout(() => {
    widgetEl.classList.add('faded');
    widgetEl.classList.toggle('faded-panel', isPanelOpen);
  }, delay);
}

function wakeWidget() {
  widgetEl.classList.remove('faded');
  widgetEl.classList.remove('faded-panel');
  scheduleFade();
}

document.addEventListener('pointermove', wakeWidget, { passive: true });
document.addEventListener('pointerdown', wakeWidget);
scheduleFade();

// ---------- Dragging the whole widget window ----------
// This window was opened by chrome.windows.create (type 'popup'), so it
// counts as script-opened and window.moveTo/moveBy are allowed.
let dragging = false;
let dragPointerId = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

function bindDrag(el) {
  el.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    dragging = true;
    dragPointerId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    dragOffsetX = e.screenX - window.screenX;
    dragOffsetY = e.screenY - window.screenY;
    gripEl.classList.add('dragging');
    statusEl.classList.add('dragging');
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    window.moveTo(e.screenX - dragOffsetX, e.screenY - dragOffsetY);
  });

  const endDrag = (e) => {
    if (e.pointerId !== dragPointerId) return;
    dragging = false;
    dragPointerId = null;
    gripEl.classList.remove('dragging');
    statusEl.classList.remove('dragging');
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}
bindDrag(gripEl);
bindDrag(statusEl);

// ---------- Live timer ----------
async function renderTimer() {
  const { recordStartTime, totalPausedMs, pauseStartedAt, isPaused } =
    await chrome.storage.local.get(['recordStartTime', 'totalPausedMs', 'pauseStartedAt', 'isPaused']);
  if (!recordStartTime) return;
  const now = Date.now();
  const pausedSoFar = (totalPausedMs || 0) + (isPaused && pauseStartedAt ? now - pauseStartedAt : 0);
  const secs = Math.max(0, Math.floor((now - recordStartTime - pausedSoFar) / 1000));
  const mins = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  timerEl.textContent = `${mins}:${s}`;
}

function startTicking() {
  if (intervalId) return;
  renderTimer();
  intervalId = setInterval(renderTimer, 1000);
}

function stopTicking() {
  clearInterval(intervalId);
  intervalId = null;
}

function setPausedUI(isPaused) {
  paused = isPaused;
  dot.classList.toggle('paused', isPaused);
  pauseBtn.innerHTML = isPaused ? ICON_PLAY : ICON_PAUSE;
  renderTimer();
  if (isPaused) stopTicking();
  else startTicking();
}

(async () => {
  const { isPaused } = await chrome.storage.local.get('isPaused');
  setPausedUI(!!isPaused);
})();

// ---------- Bubble mini-map ----------
// Shows the whole recording frame with the bubble as a draggable dot.
// Click or drag anywhere to move the bubble to that spot in the
// recording (offscreen.js composites it there live).

function sendPlaceBubble(clientX, clientY) {
  const rect = bubbleMapWrap.getBoundingClientRect();
  if (!rect.width || !rect.height || !lastBubble) return;
  const d = lastBubble.d || 0;
  const x = Math.max(0, Math.min(((clientX - rect.left) / rect.width) * lastDims.w - d / 2, lastDims.w - d));
  const y = Math.max(0, Math.min(((clientY - rect.top) / rect.height) * lastDims.h - d / 2, lastDims.h - d));
  chrome.runtime.sendMessage({ action: 'MOVE_BUBBLE', x, y });
}

let bubbleDragging = false;
let bubblePointerId = null;

bubbleMapWrap.addEventListener('pointerdown', (e) => {
  if (!hasBubble) return;
  bubbleDragging = true;
  bubblePointerId = e.pointerId;
  bubbleMapWrap.setPointerCapture(e.pointerId);
  bubbleMapWrap.classList.add('placing');
  sendPlaceBubble(e.clientX, e.clientY);
  e.preventDefault();
});

bubbleMapWrap.addEventListener('pointermove', (e) => {
  if (!bubbleDragging || e.pointerId !== bubblePointerId) return;
  sendPlaceBubble(e.clientX, e.clientY);
});

const endBubbleDrag = (e) => {
  if (e.pointerId !== bubblePointerId) return;
  bubbleDragging = false;
  bubblePointerId = null;
  bubbleMapWrap.classList.remove('placing');
};
bubbleMapWrap.addEventListener('pointerup', endBubbleDrag);
bubbleMapWrap.addEventListener('pointercancel', endBubbleDrag);

function updateDot() {
  if (!lastBubble || !hasBubble) {
    bubbleDot.style.display = 'none';
    return;
  }
  bubbleDot.style.display = 'block';
  const cx = ((lastBubble.x + lastBubble.d / 2) / lastDims.w) * 100;
  const cy = ((lastBubble.y + lastBubble.d / 2) / lastDims.h) * 100;
  bubbleDot.style.left = `${cx}%`;
  bubbleDot.style.top = `${cy}%`;
}

bubbleBtn.addEventListener('click', () => {
  const open = !bubblePanel.classList.contains('hidden');
  bubblePanel.classList.toggle('hidden', open);
  bubbleBtn.classList.toggle('active-on', !open);
  resizeWidgetWindow(300, open ? 88 : 272);
  wakeWidget();
  updateDot();
});

// The live-preview panel is open by default: the moment a screen
// recording starts, the user wants to see the recording (and place the
// webcam bubble) right away, not click the bubble button first. It can
// still be collapsed with the bubble button as before.
(function openPreviewByDefault() {
  bubblePanel.classList.remove('hidden');
  bubbleBtn.classList.add('active-on');
  resizeWidgetWindow(300, 272);
  // Re-arm the auto-fade with the open-panel idle window (it was
  // scheduled at load while the panel was still hidden).
  scheduleFade();
})();

// Resizes the widget window. chrome.windows.update is the reliable
// path; window.resizeTo can be ignored by some window managers
// (notably on Linux), which made the bubble panel clip when it opened.
async function resizeWidgetWindow(width, height) {
  try {
    const win = await chrome.windows.getCurrent();
    if (win && win.id) {
      await chrome.windows.update(win.id, { width, height });
      return;
    }
  } catch (e) {
    // Fall through to the DOM API below.
  }
  try {
    window.resizeTo(width, height);
  } catch (e) {
    // Non-fatal: the panel just overlays without growing the window.
  }
}

// ---------- Floating PiP preview (drag-to-position the bubble) ----------
// The mini-map above already moves the bubble, but the widget window is
// not always on top. A Document Picture-in-Picture window IS — Chrome
// floats it above everything, and because it's same-origin it can host
// interactive DOM: the live preview with the draggable bubble marker,
// right in the floating window. requestWindow() needs the click's user
// activation, so it's called first, synchronously; the CSS, panel copy
// and drag script are populated after it resolves.

function pipSupported() {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// Populates a Document-PiP window with the live preview panel: injects
// the widget's stylesheet, clones the bubble panel (preview image +
// draggable marker), and injects the drag script that sends MOVE_BUBBLE
// from inside the floating window. Split from togglePipPreview so the
// probe can drive it with a stub window (requestWindow itself needs a
// real user click).
async function populatePipWindow(pip) {
  try {
    const css = await (await fetch('widget.css')).text();
    const style = pip.document.createElement('style');
    style.textContent = css;
    pip.document.head.appendChild(style);
  } catch (e) { /* cosmetic — the panel still works unstyled */ }
  const shell = pip.document.createElement('div');
  shell.id = 'pipShell';
  shell.appendChild(bubblePanel.cloneNode(true));
  pip.document.body.appendChild(shell);
  pip.document.title = 'Recording preview';
  // Listeners don't survive cloneNode — re-bind the drag interaction
  // inside the PiP window. The script reads the live dims/bubble state
  // the widget mirrors below and sends MOVE_BUBBLE straight to the
  // recorder, so dragging the marker in the floating window moves the
  // bubble in the recording (and the widget's own dot stays in sync via
  // the RECORDING_PREVIEW stream).
  const s = pip.document.createElement('script');
  s.textContent = '(' + function pipPanelScript() {
    const wrap = document.getElementById('bubbleMapWrap');
    const dot = document.getElementById('bubbleDot');
    if (!wrap || !dot) return;
    const dims = () => window.__srpDims || { w: 1920, h: 1080 };
    const bubble = () => window.__srpBubble || null;
    function place(clientX, clientY) {
      const b = bubble();
      if (!b) return;
      const rect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const d = b.d || 0;
      const dw = dims().w || 1920;
      const dh = dims().h || 1080;
      const x = Math.max(0, Math.min(((clientX - rect.left) / rect.width) * dw - d / 2, dw - d));
      const y = Math.max(0, Math.min(((clientY - rect.top) / rect.height) * dh - d / 2, dh - d));
      chrome.runtime.sendMessage({ action: 'MOVE_BUBBLE', x, y }).catch(() => {});
    }
    let dragging = false;
    let pointerId = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (!bubble()) return;
      dragging = true;
      pointerId = e.pointerId;
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('placing');
      place(e.clientX, e.clientY);
      e.preventDefault();
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== pointerId) return;
      place(e.clientX, e.clientY);
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
      wrap.classList.remove('placing');
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
  }.toString() + ')();';
  pip.document.body.appendChild(s);
}

async function togglePipPreview() {
  if (pipWindow) {
    closePipPreview();
    return;
  }
  if (!pipSupported()) {
    mapHint.textContent = 'Floating preview needs Chrome 116+ — use the dot here to move the bubble';
    wakeWidget();
    return;
  }
  let pip;
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 340, height: 300 });
  } catch (e) {
    return; // activation lost or refused — nothing to show
  }
  pipWindow = pip;
  pipBtn.classList.add('active-on');
  await populatePipWindow(pip);
  // If the user closes the floating window (X / Esc), forget it and
  // reset the button.
  const onPipGone = () => {
    pipWindow = null;
    pipBtn.classList.remove('active-on');
  };
  pip.addEventListener('pagehide', onPipGone);
  pip.addEventListener('close', onPipGone);
  // Push the current frame + bubble in immediately (the live message
  // stream keeps it fresh afterwards).
  mirrorPip({ dataUrl: bubbleMap.src, bubble: lastBubble, dims: lastDims });
  wakeWidget();
}

function closePipPreview() {
  if (!pipWindow) return;
  try { pipWindow.close(); } catch (e) {}
  pipWindow = null;
  pipBtn.classList.remove('active-on');
}

// Copies the latest preview frame + bubble position into the open PiP
// window. Called on every RECORDING_PREVIEW (and once at open). pip is
// the target PiP window (defaults to the open one) — injectable so the
// probe can drive mirroring with a stub window.
function mirrorPip(message, pip) {
  if (!pip) pip = pipWindow;
  if (!pip || pip.closed) return;
  try {
    pip.__srpDims = message.dims || lastDims;
    pip.__srpBubble = message.bubble || null;
    const img = pip.document.getElementById('bubbleMap');
    if (img && message.dataUrl) img.src = message.dataUrl;
    const dot = pip.document.getElementById('bubbleDot');
    if (!dot) return;
    const b = message.bubble;
    if (!b) {
      dot.style.display = 'none';
      return;
    }
    dot.style.display = 'block';
    const dw = (message.dims && message.dims.w) || lastDims.w || 1920;
    const dh = (message.dims && message.dims.h) || lastDims.h || 1080;
    dot.style.left = (((b.x + b.d / 2) / dw) * 100) + '%';
    dot.style.top = (((b.y + b.d / 2) / dh) * 100) + '%';
  } catch (e) { /* PiP window vanished mid-update — harmless */ }
}

pipBtn.addEventListener('click', togglePipPreview);
if (!pipSupported()) pipBtn.classList.add('unsupported');

// If the widget window closes (recording stopped / user closed it), the
// floating PiP must go with it.
window.addEventListener('pagehide', () => { closePipPreview(); });

// If no preview frames arrive shortly after this window opens, the
// recorder never started (or this is stale code) — say so instead of
// silent black.
setTimeout(() => {
  if (!previewSeen) bubbleMapWrap.classList.add('no-signal');
}, 10000);

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'RECORDING_PAUSED') setPausedUI(true);
  else if (message.action === 'RECORDING_RESUMED') setPausedUI(false);
  else if (message.action === 'RECORDING_PREVIEW') {
    if (!previewSeen) {
      previewSeen = true;
      bubbleMapWrap.classList.remove('no-signal');
      liveBadge.classList.add('show');
    }
    if (message.dims) lastDims = message.dims;
    if (message.bubble) {
      lastBubble = message.bubble;
      if (!hasBubble) {
        hasBubble = true;
        bubbleBtn.classList.remove('no-bubble');
        mapHint.textContent = MAP_HINT_BUBBLE;
      }
      updateDot();
    } else if (hasBubble) {
      hasBubble = false;
      bubbleBtn.classList.add('no-bubble');
      mapHint.textContent = MAP_HINT_NO_BUBBLE;
    }
    bubbleMap.src = message.dataUrl;
    mirrorPip(message);
  }
});

pauseBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: paused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING' });
});

screenshotBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'CAPTURE_SCREENSHOT' });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP_RECORDING' });
});
