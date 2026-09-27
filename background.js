importScripts('shared/db.js', 'shared/webmRepair.js', 'shared/qualityPresets.js');

// Sensible defaults so the keyboard shortcut can start a recording even
// before the popup has ever been opened once (previously it silently did
// nothing until a config existed in storage).
const DEFAULT_RECORD_CONFIG = {
  mode: 'area',
  fps: 60,
  quality: '1080p',
  cursor: true,
  // Include the microphone by default. Older builds displayed Voice
  // Enhance as active while defaulting to system-only audio, so captions
  // could hear the mic even though the recorded track omitted it.
  audioSource: 'both',
  audioSourceTouched: false,
  webcam: false,
  webcamPosition: 'bottom-right',
  webcamShape: 'circle',
  annotate: true,
  countdown: true,
  // RNNoise voice cleanup stays on for microphone recordings. The
  // hard mute gate stays OFF: real-speech QA showed it can swallow quiet
  // words (and can mute almost everything before RNNoise is ready).
  // System-only / no-audio recordings are unaffected.
  noiseReduction: true,
  noiseGate: false,
  // WebM (VP8) output by default — it records cleanly with no H.264
  // macroblock-padding quirks (Chrome's OpenH264 pads non-16-aligned
  // frames and the MP4 shows the padding as a duplicated bottom strip),
  // and it needs no alignment resampling, so text stays pixel-perfect.
  // 'mp4' remains available in the popup for users who need a
  // universally-playable file.
  outputFormat: 'webm',
  // Tutorial effects: click ripples rendered as real page DOM so they're
  // captured with the tab (both modes).
  clickEffects: true,
  // Live captions: transcribe the mic with the Web Speech API and burn
  // the subtitle text into the recorded frames. Off by default (it
  // needs mic permission + network); captionsLang is the BCP-47 tag.
  captions: false,
  captionsLang: 'en-US',
  captionsSize: 'medium'
};

// Buffers for in-flight chunked recording uploads from selector.js (area
// mode). Keyed by transferId. A single recording's chunks all arrive in a
// fast, uninterrupted burst of messages, so keeping this in memory (rather
// than storage) is safe — unlike widgetWindowId below, there's no long idle
// gap here for the service worker to be recycled during.
const pendingTransfers = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((err) => {
      console.error('Background message handler error:', err);
      sendResponse({ ok: false, error: err.message });
    });
  return true; // keep the message channel open for the async response
});

// Mic enhancements + caption language are fixed behavior now, not user
// choices: every recording start (popup, area mode, keyboard shortcut)
// funnels its config through here so a stale stored config (from before
// the toggles were removed) can never sneak a disabled enhancement or a
// non-English caption language into a recording.
function normalizeRecordConfig(config) {
  const c = config || {};
  c.noiseReduction = true;
  c.noiseGate = false;
  c.captionsLang = 'en-US';
  return c;
}

async function handleMessage(request, sender) {
  switch (request.action) {
    case 'START_FULL_RECORDING': {
      // Guards against a second start request (double-click, keyboard
      // shortcut + popup, rapid re-testing) kicking off a second
      // getDisplayMedia call. Chrome ends an active screen capture when
      // a new getDisplayMedia starts, so the first recording would
      // otherwise die the instant the second one begins — which showed
      // up as the widget window flickering open and immediately
      // closing.
      const { isRecording } = await chrome.storage.local.get('isRecording');
      if (isRecording || screenRecordingStarting) {
        // screenRecordingStarting can be a genuine in-flight start (the
        // share picker is open) OR a stale flag: when the user cancels
        // the picker and starts again, the completion message can arrive
        // late or be lost, leaving the flag set for up to 60s and falsely
        // refusing every re-start. Ask the offscreen document whether a
        // start is REALLY mid-flight — if it isn't (or the document is
        // gone), the flag is stale: clear it and proceed.
        if (screenRecordingStarting) {
          const resp = await chrome.runtime.sendMessage({ action: 'RECORDER_ALIVE' }).catch(() => null);
          if (resp && resp.starting) {
            return { ok: false, error: 'A recording is already starting or in progress.' };
          }
          screenRecordingStarting = false;
        }
        // A stored isRecording flag can survive a crashed or lost
        // recording and would block every future start forever: verify a
        // recorder is ACTUALLY alive before refusing, and clear the stale
        // flag so the user can start again.
        if (isRecording) {
          const staleCleared = await clearStaleRecordingIfDead();
          if (!staleCleared) return { ok: false, error: 'A recording is already starting or in progress.' };
        }
      }
      // The recovery snapshot is NOT cleared here — only once the new
      // recording actually STARTS (RECORDING_STARTED). Setup can be
      // cancelled at the share dialog, and wiping a pending recoverable
      // snapshot for a recording that never began would lose it forever.
      // recordConfig is deliberately NOT written here: the popup persists
      // the raw settings itself (on every change and at start), and
      // writing the mode-forced request.config would clobber the raw
      // annotate preference (screen starts force annotate off).
      await startOffscreenRecording(normalizeRecordConfig(request.config));
      return;
    }

    // Sent by popup.js (and, for the keyboard-shortcut path, called
    // directly as a function below) to inject the area-selection UI into
    // a tab. Centralized here — rather than duplicated in popup.js — so
    // both entry points get identical error handling.
    case 'START_AREA_RECORDING': {
      // Normalize BEFORE persisting: the injected content script reads
      // recordConfig from storage, so it must see the enforced values.
      const config = normalizeRecordConfig(request.config);
      await chrome.storage.local.set({ recordConfig: config });
      const tabId = request.tabId ?? (sender.tab ? sender.tab.id : null);
      if (!tabId) return { ok: false, error: 'No active tab to record.' };
      return await startAreaRecording(tabId, config);
    }

    // --- Area-mode lifecycle (reported by the content script) ---
    // Fired the instant initiateAreaRecording begins — well before
    // mediaRecorder.start() — specifically so isRecording flips true
    // before any of the slow setup (display/webcam/mic prompts, then the
    // countdown) has a chance to run. Without this, isRecording stayed
    // false for that whole window and a second "Start Recording" click
    // could inject a second, parallel recording session onto the same
    // tab — duplicate webcam bubbles, duplicate widgets, two
    // MediaRecorders fighting each other.
    case 'AREA_RECORDING_STARTING':
      // The recovery snapshot is deliberately NOT cleared here — setup can
      // still be cancelled (share dialog dismissed), and wiping a pending
      // recoverable snapshot for a recording that never began would lose it
      // forever. The clear happens when the recording actually starts
      // (AREA_RECORDING_STARTED below).
      await chrome.storage.local.set({
        isRecording: true,
        isPaused: false,
        activeMode: request.mode || 'area',
        activeTabId: sender.tab ? sender.tab.id : null
      });
      setBadge('REC', '#ef4444');
      return;

    case 'AREA_RECORDING_STARTED':
      await chrome.storage.local.set({
        isRecording: true,
        isPaused: false,
        activeMode: request.mode || 'area',
        activeTabId: sender.tab ? sender.tab.id : null
      });
      setBadge('REC', '#ef4444');
      // This recording genuinely began — it supersedes any leftover
      // recovery snapshot from a previous recording.
      await SRPDB.recoveryClear();
      return;

    case 'AREA_RECORDING_STOPPED':
      await chrome.storage.local.set({
        isRecording: false,
        isPaused: false,
        activeMode: null,
        activeTabId: null
      });
      setBadge('', '#ef4444');
      // The crash-recovery snapshot is NOT cleared here: this message can
      // arrive while the final chunks are still being saved to History (or
      // while Chrome is shutting down), and clearing it here would destroy
      // the only copy of the footage if that save never lands.
      // handleRecordingChunk clears the snapshot once the transfer is
      // safely persisted, and any new recording clears it at start.
      return;

    // --- Generic controls used by the popup and both widgets ---
    case 'STOP_RECORDING':
      await routeToActiveRecorder('STOP_AREA_RECORDING', 'STOP_OFFSCREEN');
      return;

    case 'PAUSE_RECORDING':
      await routeToActiveRecorder('PAUSE_AREA_RECORDING', 'PAUSE_OFFSCREEN');
      await chrome.storage.local.set({ isPaused: true });
      setBadge('II', '#f59e0b');
      return;

    case 'RESUME_RECORDING':
      await routeToActiveRecorder('RESUME_AREA_RECORDING', 'RESUME_OFFSCREEN');
      await chrome.storage.local.set({ isPaused: false });
      setBadge('REC', '#ef4444');
      return;

    case 'CAPTURE_SCREENSHOT':
      await captureScreenshot();
      return;

    // Manual "stuck state" recovery: a previous recording may have
    // crashed (or the browser closed mid-recording) leaving isRecording
    // true in storage, which silently blocks every new start. Clears
    // everything and closes any orphaned widget window.
    case 'RESET_RECORDING_STATE':
      await chrome.storage.local.set({
        isRecording: false,
        isPaused: false,
        activeMode: null,
        activeTabId: null
      });
      setBadge('', '#ef4444');
      await closeWidgetWindow();
      await SRPDB.recoveryClear();
      return;

    // Sent by selector.js in fixed-size chunks (large recordings exceed
    // chrome.runtime.sendMessage's ~32MB size ceiling if sent as one
    // message — see handleRecordingChunk for the full explanation).
    case 'SAVE_RECORDING_CHUNK':
      await handleRecordingChunk(request);
      return;

    // --- Reported by offscreen.js (screen/tab mode) ---
    case 'RECORDING_STARTED':
      screenRecordingStarting = false;
      // The offscreen document can't rely on chrome.storage (unavailable
      // there on some Chrome versions), so it passes the start timestamp
      // along and we persist everything here — the widget's live timer
      // reads these same values.
      await chrome.storage.local.set({
        isRecording: true,
        isPaused: false,
        activeMode: 'screen',
        recordStartTime: request.recordStartTime || null,
        totalPausedMs: 0,
        pauseStartedAt: null
      });
      setBadge('REC', '#ef4444');
      // This recording genuinely began — it supersedes any leftover
      // recovery snapshot from a previous recording.
      await SRPDB.recoveryClear();
      // A separate popup is safe for tab/window capture because it is not
      // part of the selected surface. For an entire-monitor capture it
      // would be recorded too, creating the large recursive preview seen
      // in finished videos. Keep full-screen capture clean and rely on the
      // extension badge + keyboard shortcuts while the monitor is shared.
      if (request.surface === 'monitor') {
        await closeWidgetWindow();
      } else {
        await openWidgetWindow();
      }
      // Tutorial effects (click ripples) in screen mode: best-effort
      // injection into the active tab — the surface most users capture.
      // Never allowed to affect the recording.
      await injectScreenEffects().catch(() => {});
      return;

    case 'RECORDING_PAUSED':
      await chrome.storage.local.set({ isPaused: true, pauseStartedAt: request.pauseStartedAt || null });
      setBadge('II', '#f59e0b');
      return;

    case 'RECORDING_RESUMED':
      await chrome.storage.local.set({ isPaused: false, totalPausedMs: request.totalPausedMs || 0, pauseStartedAt: null });
      setBadge('REC', '#ef4444');
      return;

    case 'RECORDING_PROGRESS':
      // Diagnostic breadcrumb from offscreen.js (e.g. "picker resolved",
      // "frames flowing") — visible in the service worker console at
      // chrome://extensions so a stuck recording is easy to diagnose.
      console.log('[ScreenRecorder] offscreen:', request.step, request.detail || '');
      return;

    // The user asked for the webcam bubble but Chrome blocked the camera
    // (denied/dismissed). Recording continues without the bubble — but say
    // so explicitly, because a silently missing bubble reads as "the
    // feature is broken". Emphasize the permission belongs to the
    // EXTENSION ("Screen Recorder Pro"), not to whatever website is in
    // the active tab — users commonly grant the camera to the site and
    // the extension still can't see it.
    case 'WEBCAM_UNAVAILABLE':
      notifyUser(
        'Webcam bubble is off',
        "Screen Recorder Pro couldn't use the camera, so this recording has no webcam bubble. Allow Camera for \"Screen Recorder Pro\" (not the website) at chrome://settings/content/camera, then start again."
      );
      return;

    // Sent by the blank-frame watchdog in offscreen.js / selector.js when
    // the captured frames come out as one solid color (typically blue)
    // while recording fullscreen video. Root cause: Chrome's
    // hardware-accelerated video decode presents the video through a GPU
    // overlay that screen capture can't see — no recorder can capture it.
    // The only real fix is disabling hardware acceleration, so say that
    // explicitly and early, instead of the user finding a blue file.
    // Sent by offscreen.js when the config asked for system audio but the
    // capture came back with none: the user missed the "Share audio"
    // checkbox in the picker, or (Linux) Chrome doesn't support system
    // audio for window/entire-screen capture at all. The recording
    // continues — but silently losing all sound reads as broken, so say
    // so and point at the fix.
    case 'MICROPHONE_UNAVAILABLE':
      notifyUser(
        'Microphone audio is off',
        request.audioSource === 'both'
          ? `Screen Recorder Pro couldn't access your microphone. The recording will continue with system audio only if Chrome supplied it. Allow Microphone for "Screen Recorder Pro", then record again.`
          : `Screen Recorder Pro couldn't access your microphone, so this recording has no voice audio. Allow Microphone for "Screen Recorder Pro", then record again.`
      );
      return;

    case 'SYSTEM_AUDIO_MISSING':
      notifyUser(
        'No system audio captured',
        request.surface === 'browser'
          ? "Chrome didn't capture the tab's audio — tick \"Share tab audio\" in the share picker and record again."
          : "Chrome didn't capture system audio. On Windows, tick \"Share audio\" in the picker; on Linux, system audio isn't supported for window/entire-screen capture — pick \"This Tab\" or use Microphone for voice."
      );
      return;

    case 'BLANK_CAPTURE_DETECTED':
      notifyUser(
        'Recording is coming out BLANK',
        "The captured frames are a solid blue/black — Chrome's hardware acceleration can't capture fullscreen video. Fix: open chrome://settings/system, turn OFF \"Use graphics acceleration when available\", restart Chrome, then record again. This recording will likely be blank."
      );
      return;

    // Sent by offscreen.js / selector.js when live captions were enabled
    // but the Web Speech API can't run — mic permission denied, no
    // network for the recognition service, or the browser doesn't expose
    // the API at all. The recording continues (captions are an overlay,
    // never the recording itself), so the user just gets a heads-up on
    // why the subtitle text is missing.
    case 'CAPTIONS_UNAVAILABLE': {
      const reason = request.reason;
      let message;
      if (reason === 'not-allowed' || reason === 'service-not-allowed') {
        message = "Screen Recorder Pro couldn't access the microphone, so live captions are off for this recording. Allow Microphone for \"Screen Recorder Pro\" (not the website) at chrome://settings/content/microphone, then start again.";
      } else if (reason === 'unsupported') {
        message = 'This browser does not support speech recognition, so live captions are off. The recording itself is unaffected.';
      } else if (reason === 'language-not-supported') {
        message = 'Live captions are set to English (US), which Chrome does not support on this device. Captions are off for this recording — the recording itself is unaffected.';
      } else {
        message = 'Speech recognition stopped (likely a network issue), so live captions are off for this recording. The recording itself is unaffected.';
      }
      notifyUser('Live captions unavailable', message);
      return;
    }

    case 'RECORDING_STOPPED':
      await chrome.storage.local.set({
        isRecording: false,
        isPaused: false,
        activeMode: null,
        activeTabId: null,
        totalPausedMs: 0,
        pauseStartedAt: null
      });
      setBadge('', '#ef4444');
      await closeWidgetWindow();
      // The crash-recovery snapshot is deliberately NOT cleared here. When
      // Chrome shuts down (or the share ends) mid-recording, this stop path
      // can run while the final save/download is still landing — clearing
      // the snapshot then would destroy the only copy of the footage.
      // offscreen.js sends RECOVERY_CLEAR only AFTER its History save
      // succeeds, and any new recording clears the snapshot at start.
      // If Chrome itself ended the capture (the shared tab/window stopped
      // being shared — nothing the user clicked), say so instead of the
      // widget silently vanishing.
      if (request.reason === 'track-ended') {
        notifyUser('Recording stopped', 'Chrome ended the share — the shared tab or window stopped being shared, so the recording stopped. The file was saved to Downloads.');
      }
      return;

    case 'RECORDING_FAILED':
      screenRecordingStarting = false;
      await chrome.storage.local.set({
        isRecording: false,
        isPaused: false,
        activeMode: null,
        activeTabId: null,
        totalPausedMs: 0,
        pauseStartedAt: null
      });
      setBadge('', '#ef4444');
      await closeWidgetWindow();
      await SRPDB.recoveryClear();
      // Skip the alert for plain user cancellation (closing the native
      // picker) — that's not a failure, it's declining to start. Anything
      // else (permissions policy, no display server, etc.) previously
      // failed with zero visible feedback: the popup had already closed
      // itself and the offscreen document has no visible surface of its
      // own to show an error on.
      console.error('[ScreenRecorder] RECORDING_FAILED:', request.errorName, request.error);
      // Surface the failure clearly — including the exact error name and
      // message — so a report from the user contains enough to diagnose
      // the next round.
      if (request.errorName !== 'NotAllowedError') {
        notifyUser('Recording failed to start', request.error || 'An unknown error occurred.');
      }
      return;

    // The recorder appends ~5s deltas of the recorded-so-far bytes during
    // recording. If Chrome crashes or the extension reloads, the surviving
    // IndexedDB snapshot is reassembled and offered back (recoverFromCrash).
    case 'RECOVERY_APPEND': {
      const { isRecording } = await chrome.storage.local.get('isRecording');
      // A late checkpoint from a recording that already stopped would
      // otherwise leave a stale snapshot behind — drop it instead.
      if (!isRecording) {
        await SRPDB.recoveryClear();
        return;
      }
      const part = srpBase64ToArrayBuffer(request.chunk);
      if (!(part instanceof ArrayBuffer) || part.byteLength === 0) return;
      await SRPDB.recoveryAppend(part, { mode: request.mode, resolution: request.resolution, mimeType: request.mimeType });
      return;
    }

    // Sent by offscreen.js once a recording's final bytes are safely in
    // History — the save that makes the checkpoint snapshot obsolete. The
    // snapshot is NOT cleared at stop time (stop can race a shutdown-killed
    // save); clearing it here, after success, keeps the snapshot as the
    // backup until the data is actually durable, and no longer.
    case 'RECOVERY_CLEAR':
      await SRPDB.recoveryClear();
      return;

    // Sent while a recording is paused (no bytes to append): refreshes the
    // snapshot's timestamp so a merely-paused recording is never mistaken
    // for a crashed one.
    case 'RECOVERY_HEARTBEAT':
      await SRPDB.recoveryHeartbeat();
      return;

    default:
      return;
  }
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}

// Briefly flashes a green checkmark over whatever badge state is current,
// then restores it — the only feedback a screenshot press gets today
// (chrome.tabs.captureVisibleTab has no UI of its own to confirm success).
async function flashBadgeSuccess() {
  const { isRecording, isPaused } = await chrome.storage.local.get(['isRecording', 'isPaused']);
  chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  chrome.action.setBadgeText({ text: '\u2713' });
  setTimeout(() => {
    if (isRecording) {
      setBadge(isPaused ? 'II' : 'REC', isPaused ? '#f59e0b' : '#ef4444');
    } else {
      setBadge('', '#ef4444');
    }
  }, 1200);
}

function notifyUser(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'assets/icon128.png',
    title,
    message
  });
}

// Tracks an in-flight chrome.offscreen.createDocument() call so a second,
// near-simultaneous "start recording" request awaits the same promise
// instead of calling createDocument() again — Chrome only permits one
// offscreen document per extension at a time and rejects a second
// concurrent creation call outright. That rejection was previously
// uncaught, so the recording just silently never started with nothing
// shown to the user — most likely to happen exactly when re-testing
// quickly after a previous recording just ended.
let creatingOffscreenDocument = null;

// The offscreen document registers its chrome.runtime.onMessage listener
// asynchronously, after the document has been created. chrome.offscreen
// .createDocument() resolves before that happens, so a START_CAPTURE sent
// immediately could arrive before the listener exists and be silently
// dropped — the recording then never starts at all (or, worse, starts on
// a retry while a previous attempt's getDisplayMedia was still resolving,
// killing that capture). offscreen.js signals OFFSCREEN_READY once its
// listener is live; we wait for that signal before sending START_CAPTURE.
let offscreenReady = false;

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'OFFSCREEN_READY') {
    offscreenReady = true;
    console.log('[ScreenRecorder] offscreen document is ready', request.version ? `(code v${request.version})` : '');
  }
});

function waitForOffscreenReady(timeoutMs = 4000) {
  if (offscreenReady) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = setInterval(() => {
      if (offscreenReady || Date.now() - start > timeoutMs) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) {
    // Chrome can keep an offscreen document alive across extension
    // reloads — running the OLD code forever (its load-time message
    // listener only exists in the previous build). If this service
    // worker session has seen a fresh OFFSCREEN_READY handshake, the
    // document is current code and safe to reuse. If not, it's stale:
    // close it and create a fresh one below — UNLESS a recording is
    // currently in progress inside it (closing it then would kill the
    // recording; the next ensure call after it stops will clean up).
    if (offscreenReady) return;
    const { isRecording } = await chrome.storage.local.get('isRecording');
    if (isRecording) return;
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // Already closed — nothing to do.
    }
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  offscreenReady = false;
  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // Both reasons are required, not just one: DISPLAY_MEDIA covers the
    // getDisplayMedia() call that captures the screen/window/tab itself,
    // USER_MEDIA covers the separate getUserMedia() call for the
    // optional webcam/mic. Chrome enforces this per-API.
    reasons: ['DISPLAY_MEDIA', 'USER_MEDIA'],
    justification: 'Offscreen MediaRecording for full screen/tab capture, webcam overlay, and mic mixing'
  });
  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

// Dedupes concurrent startOffscreenRecording calls the same way
// creatingOffscreenDocument dedupes document creation: if two start
// requests race, they both await one shared pipeline instead of sending
// two START_CAPTURE messages (two getDisplayMedia calls end each other).
let startingOffscreenRecording = null;

// True from the moment a screen-mode start is accepted until the
// recording actually begins (or fails). isRecording alone can't guard
// this window: while the native share picker is open, RECORDING_STARTED
// hasn't fired yet, so a second "Start Recording" (double-click, extra
// retries) would otherwise pass the isRecording check and send a second
// START_CAPTURE. The offscreen guard ignores those, but this keeps the
// whole system single-start from the popup's perspective.
let screenRecordingStarting = false;

async function startOffscreenRecording(config) {
  if (startingOffscreenRecording) {
    await startingOffscreenRecording;
    return;
  }

  startingOffscreenRecording = (async () => {
    screenRecordingStarting = true;
    // Safety net: if the offscreen document dies silently while the
    // share picker is open (user abandons it, Chrome kills the doc),
    // neither RECORDING_STARTED nor RECORDING_FAILED will ever arrive to
    // clear this flag — without this it would stay true and block every
    // future start. The timer self-heals the state.
    const startingTimeout = setTimeout(() => {
      screenRecordingStarting = false;
    }, 60000);
    try {
      await ensureOffscreenDocument();
      // Wait for the offscreen document to have its message listener
      // registered before sending START_CAPTURE, so the message is
      // never dropped.
      await waitForOffscreenReady();
      // The offscreen document ACKs receipt of START_CAPTURE; if the
      // ACK never comes back (message lost for any reason), retry once
      // after a short delay so a single dropped message can never leave
      // the user staring at nothing.
      const ack = await chrome.runtime.sendMessage({ action: 'START_CAPTURE', config })
        .catch(() => null);
      console.log('[ScreenRecorder] START_CAPTURE delivered:', ack ? 'ack' : 'no ack', ack);
      if (!ack || !ack.received) {
        await new Promise((r) => setTimeout(r, 500));
        const retryAck = await chrome.runtime.sendMessage({ action: 'START_CAPTURE', config })
          .catch(() => null);
        if (!retryAck || !retryAck.received) {
          // The offscreen document exists but never answered — a broken
          // or half-loaded recorder. Fail loudly instead of leaving the
          // user staring at a closed popup and no picker.
          console.error('[ScreenRecorder] START_CAPTURE was never delivered to the offscreen document');
          screenRecordingStarting = false;
          await chrome.storage.local.set({ isRecording: false, isPaused: false, activeMode: null });
          setBadge('', '#ef4444');
          notifyUser('Recording not started', "The recorder didn't respond. Reload the extension at chrome://extensions, then try again.");
        }
      }
    } catch (err) {
      console.error('[ScreenRecorder] Could not set up the offscreen recorder:', err);
      screenRecordingStarting = false;
      await chrome.storage.local.set({ isRecording: false, isPaused: false, activeMode: null });
      setBadge('', '#ef4444');
      notifyUser('Recording failed to start', "Couldn't set up the screen recorder — please try again.");
    } finally {
      clearTimeout(startingTimeout);
      startingOffscreenRecording = null;
    }
  })();

  await startingOffscreenRecording;
}

// Injects the area-selection overlay into a tab. Used both by popup.js
// (via the START_AREA_RECORDING message) and directly by the
// toggle-recording keyboard shortcut below. Centralizing this means a
// restricted page (chrome://, the Web Store, a not-yet-loaded tab, etc.)
// is handled identically — and visibly — from either entry point, instead
// of failing silently the way an un-caught injection error used to.
async function startAreaRecording(tabId, config) {
  const { isRecording } = await chrome.storage.local.get('isRecording');
  if (isRecording) {
    // Refuse only while a recorder is genuinely live — a stale flag from
    // a crashed/lost recording must not block area starts forever.
    if (!(await clearStaleRecordingIfDead())) {
      return { ok: false, error: 'A recording is already in progress.' };
    }
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['selector/selector.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      // Order matters: qualityPresets.js and audioMixer.js declare
      // globals (SRP_QUALITY_PRESETS, srpMixAudioTracks) that
      // selector.js relies on; files injected together share one
      // execution world, so they only need to load first. The vendored
      // RNNoise WASM must precede audioMixer.js (it reads
      // self.SRPRnnoise for the mic denoise engine). effects.js declares
      // SRPEffects (click ripples), which selector.js starts for area
      // mode.
      files: ['shared/vendor/rnnoise.js', 'shared/qualityPresets.js', 'shared/audioMixer.js', 'shared/effects.js', 'shared/captions.js', 'selector/selector.js']
    });
    return { ok: true };
  } catch (err) {
    console.error('Could not start area recording on this tab:', err);
    return { ok: false, error: "Can't record this page — try a regular webpage tab." };
  }
}

// --- Tutorial effects in screen mode ---
// Injects shared/effects.js plus a small bootstrap into the active tab
// when a screen-mode recording starts. The overlay is real page DOM, so
// it only shows when the tab itself is being captured (screen / this-tab
// picks — native-app windows can't be reached by a content script). The
// bootstrap reads the persisted recordConfig, starts the click-ripple
// effect if enabled, then polls isRecording so it tears down on stop
// (and on crashes/reloads) without any extra message.
async function injectScreenEffects() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['shared/effects.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      chrome.storage.local.get('recordConfig').then(({ recordConfig }) => {
        const cfg = recordConfig || {};
        if (cfg.clickEffects === false) return;
        if (!window.SRPEffects || typeof window.SRPEffects.start !== 'function') return;
        window.SRPEffects.start({ clickEffects: true });
        const poll = setInterval(() => {
          chrome.storage.local.get('isRecording').then(({ isRecording: rec }) => {
            if (!rec) {
              clearInterval(poll);
              if (window.SRPEffects) window.SRPEffects.stop();
            }
          }).catch(() => clearInterval(poll));
        }, 1000);
      }).catch(() => {});
    }
  });
}

// Sends the right stop/pause/resume message depending on whether the
// active recording is happening inside a tab's content script (area
// mode — needs chrome.tabs.sendMessage) or the offscreen document
// (screen/tab mode — reachable via a runtime broadcast).
async function routeToActiveRecorder(areaAction, offscreenAction) {
  const { activeMode, activeTabId } = await chrome.storage.local.get(['activeMode', 'activeTabId']);
  if (activeMode === 'area' && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: areaAction }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({ action: offscreenAction }).catch(() => {});
  }
}

// Resolves "the tab the user actually wants" for a screenshot, explicitly
// excluding popup/panel-type extension windows. Without this, currentWindow
// (which really means "whatever window last had OS focus") can resolve to
// the tiny floating recording-controls widget the instant its own
// Screenshot button is clicked — capturing the 300×272 widget itself
// instead of the page being recorded.
async function resolveScreenshotTab() {
  try {
    const normalWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
    const activeTab = normalWindow?.tabs?.find((t) => t.active);
    if (activeTab) return activeTab;
  } catch (err) {
    // Fall through to the simpler query below.
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function captureScreenshot() {
  // In area mode the on-page toolbar is real page DOM, so a full-viewport
  // screenshot (captureVisibleTab) would bake it — and any open
  // blur/color popup — into the PNG. Ask the content script to hide it
  // for the capture, then reveal it once the file is safely downloaded.
  // Handled here (not in selector.js) so the keyboard-shortcut path
  // gets the same clean screenshot as the toolbar's 📷 button.
  const { activeMode, activeTabId } = await chrome.storage.local.get(['activeMode', 'activeTabId']);
  const areaRecorder = activeMode === 'area' && activeTabId;
  if (areaRecorder) {
    chrome.tabs.sendMessage(activeTabId, { action: 'PRE_SCREENSHOT' }).catch(() => {});
    // Give the browser a frame or two to actually paint the widget away
    // before captureVisibleTab grabs the compositor's current state.
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    const tab = await resolveScreenshotTab();
    if (!tab) return;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    await chrome.downloads.download({
      url: dataUrl,
      filename: `screenshot-${Date.now()}.png`,
      saveAs: false
    });
    flashBadgeSuccess();
  } catch (err) {
    console.error('Screenshot failed:', err);
  } finally {
    if (areaRecorder) {
      chrome.tabs.sendMessage(activeTabId, { action: 'POST_SCREENSHOT' }).catch(() => {});
    }
  }
}

// Reassembles a recording that selector.js sent in fixed-size chunks.
// chrome.runtime.sendMessage has an internal size ceiling (observed around
// ~32MB) — a full recording's ArrayBuffer sent as a single message throws
// "Message length exceeded maximum allowed length" past that point, which
// for a screen recording is easily under a minute of footage. The file
// still downloads fine either way (that happens before this message is
// sent), so the only symptom was recordings silently never showing up in
// History. Chunking below the ceiling avoids the failure entirely.
async function handleRecordingChunk({ transferId, chunkIndex, totalChunks, chunk, meta }) {
  cleanupStaleTransfers();

  if (!pendingTransfers.has(transferId)) {
    // .fill(undefined) matters here: new Array(n) alone creates a sparse
    // array with holes, and Array.prototype.every() silently skips holes
    // rather than treating them as undefined — so the completeness check
    // below would otherwise pass right after the *first* chunk arrived,
    // saving a truncated recording instead of waiting for all of them.
    pendingTransfers.set(transferId, { parts: new Array(totalChunks).fill(undefined), meta: null, startedAt: Date.now() });
  }
  const transfer = pendingTransfers.get(transferId);
  // Chrome's extension messaging JSON-serializes message payloads, so a
  // binary chunk arrives as an empty {} — selector.js base64-encodes
  // chunks (see srpArrayBufferToBase64 there) and we decode them here. If
  // a future Chrome ever preserves ArrayBuffers again, pass them through
  // untouched.
  const chunkPart = (typeof chunk === 'string') ? srpBase64ToArrayBuffer(chunk) : chunk;
  if (!(chunkPart instanceof ArrayBuffer)) {
    // Neither a base64 string nor an ArrayBuffer — the chunk was mangled
    // in transit (the empty-{} form the old broken path produced). Bail
    // out of this transfer instead of silently storing a corrupt 0-byte
    // entry in History.
    console.warn('[ScreenRecorder] recording chunk arrived mangled — skipped history save');
    pendingTransfers.delete(transferId);
    return;
  }
  transfer.parts[chunkIndex] = chunkPart;
  if (meta) transfer.meta = meta;

  const isComplete = transfer.parts.every((part) => part !== undefined);
  if (!isComplete) return;

  pendingTransfers.delete(transferId);

  const totalBytes = transfer.parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of transfer.parts) {
    merged.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }

  const meta_ = transfer.meta || {};
  await SRPDB.addRecording({
    buffer: merged.buffer,
    mimeType: meta_.mimeType || 'video/webm',
    thumbnail: meta_.thumbnail || null,
    mode: meta_.mode || 'area',
    duration: meta_.duration || 0,
    resolution: meta_.resolution || null
  });
  await SRPDB.pruneOldest(20);
  // The full recording is now in History — the checkpoint snapshot is
  // obsolete (it would otherwise be recovered as a duplicate on the next
  // service-worker start). Clearing here, after success, keeps the
  // snapshot as the backup until the data is actually durable.
  await SRPDB.recoveryClear();
}

// Decodes a base64 chunk sent by selector.js (see handleRecordingChunk
// for why chunks travel as base64 strings).
function srpBase64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Encodes an ArrayBuffer as base64 for the chunked offscreen download
// (see downloadRecoveredViaOffscreen). Mirror of selector.js's
// srpArrayBufferToBase64; chunked iteration avoids stack blow-ups.
function srpArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

// Guards against a transfer that never completes (e.g. the tab closed
// mid-upload) permanently holding its partial chunks in memory.
function cleanupStaleTransfers() {
  const staleAfterMs = 60000;
  const now = Date.now();
  for (const [id, transfer] of pendingTransfers) {
    if (now - transfer.startedAt > staleAfterMs) pendingTransfers.delete(id);
  }
}

// --- Floating control widget window (screen/tab mode only) ---
//
// Its window ID used to live in a plain module-level variable. That's
// unsafe: MV3 recycles the service worker after ~30s with no events, which
// happens during almost any real recording (nothing messages the
// background script while footage is just being captured). The variable
// would reset to null on restart, so the eventual RECORDING_STOPPED message
// could no longer find the window to close it — and a later recording
// could open a second widget on top of an orphaned first one. Persisting
// the ID in chrome.storage.session (in-memory, but survives service worker
// restarts within the same browser session) fixes both.

async function getWidgetWindowId() {
  const { widgetWindowId } = await chrome.storage.session.get('widgetWindowId');
  return widgetWindowId ?? null;
}

async function openWidgetWindow() {
  const existingId = await getWidgetWindowId();
  if (existingId !== null) {
    try {
      await chrome.windows.get(existingId);
      return; // still genuinely open — nothing to do
    } catch {
      // Stale ID (e.g. the user closed it manually) — fall through and
      // open a fresh one.
    }
  }

  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    const left = primary ? primary.workArea.left + 24 : 24;
    const top = primary ? primary.workArea.top + 24 : 24;

    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('widget/widget.html'),
      type: 'popup',
      // Sized for the capsule control bar PLUS the live-preview panel,
      // which is open by default (the preview and webcam-bubble
      // placement are the first thing users want to see); the window
      // shrinks (resizeTo) when the user collapses the panel. The OS
      // title bar sits above — unavoidable for script-created popup
      // windows.
      width: 300,
      height: 272,
      left,
      top,
      focused: false
    });
    await chrome.storage.session.set({ widgetWindowId: win.id });
  } catch (err) {
    console.error('Could not open control widget window:', err);
  }
}

async function closeWidgetWindow() {
  const existingId = await getWidgetWindowId();
  if (existingId !== null) {
    chrome.windows.remove(existingId).catch(() => {});
    await chrome.storage.session.remove('widgetWindowId');
  }
}

// --- Crash recovery ---
// The recorders append small recovery checkpoints to IndexedDB every ~5s
// (RECOVERY_APPEND) and heartbeat while paused. If Chrome crashes or the
// extension is reloaded mid-recording, the surviving snapshot is stale
// (nothing is touching it) the next time this service worker starts —
// recover it: save to History, download it, and clear the stuck
// recording state so a new recording can start.

// Returns true when a recorder is still alive. Used by recoverFromCrash
// to avoid misfiring on a live-but-throttled recording: an area-mode tab
// that has been hidden for a while has its content-script timers
// throttled (up to ~1/min, sometimes worse), so the checkpoint/heartbeat
// cadence can stretch well past the 90s staleness threshold — without
// this ping, a perfectly live recording could be "recovered" (cleared,
// downloaded as a partial, and flagged with a false notification).
async function liveRecorderResponds() {
  try {
    const { activeMode, activeTabId } = await chrome.storage.local.get(['activeMode', 'activeTabId']);
    if (activeMode === 'area' && activeTabId) {
      // The area-mode content script answers RECOVERY_PING synchronously.
      const resp = await chrome.tabs.sendMessage(activeTabId, { action: 'RECOVERY_PING' });
      return !!(resp && resp.alive);
    }
    if (activeMode === 'screen') {
      // The offscreen document answers RECORDER_ALIVE synchronously; a
      // missing/closed document rejects the sendMessage (caught below).
      const resp = await chrome.runtime.sendMessage({ action: 'RECORDER_ALIVE' }).catch(() => null);
      return !!(resp && resp.alive);
    }
    return false;
  } catch (e) {
    // No response = no live recorder (tab closed, script dead, reloaded).
    return false;
  }
}

// Clears a stale in-progress flag when no recorder is genuinely alive.
// The stored isRecording flag can survive a crashed recording (the
// browser killed the recorder before its stop message, the tab navigated
// mid-setup, a message was lost) and would otherwise block every future
// start with "already starting or in progress". Returns true when the
// stale state was cleared; false when a recorder answered the liveness
// probe (still live — the caller must refuse the start).
async function clearStaleRecordingIfDead() {
  const { isRecording } = await chrome.storage.local.get('isRecording');
  if (!isRecording) return false;
  if (await liveRecorderResponds()) return false;
  await chrome.storage.local.set({
    isRecording: false,
    isPaused: false,
    activeMode: null,
    activeTabId: null,
    totalPausedMs: 0,
    pauseStartedAt: null
  });
  setBadge('', '#ef4444');
  await closeWidgetWindow();
  return true;
}

async function recoverFromCrash() {
  try {
    const status = await SRPDB.recoveryStatus();
    if (!status) return;
    // 90s is comfortably above both the 5s checkpoint cadence and
    // Chrome's 1-minute timer throttling for backgrounded tabs, so a
    // live recording (even paused or in a background tab) is never
    // misread as crashed — unless it's throttled even harder, in which
    // case the live-recorder ping below is the final arbiter.
    if (Date.now() - status.lastUpdatedAt < 90000) {
      // Fresh snapshot — two possibilities: (a) a live recording is still
      // checkpointing (its next append keeps it fresh), or (b) the browser
      // was restarted within the freshness window and the recorder is
      // actually dead with no more appends coming. Re-check shortly: a live
      // recording stays fresh and the retry keeps skipping; a dead one ages
      // past 90s and gets recovered.
      scheduleRecoveryRecheck();
      return;
    }
    if (await liveRecorderResponds()) return;
    let buffer = await SRPDB.recoveryAssemble();
    if (!buffer || buffer.byteLength === 0) {
      await SRPDB.recoveryClear();
      return;
    }
    // A crash-cut MediaRecorder WebM lacks its container finalization
    // (duration, cues) and usually ends mid-cluster with a broken tail,
    // which Chrome's player rejects as "unrecognized format". Repair it
    // (trim the broken tail, inject a duration) before saving, so the
    // recovered file actually plays. The EBML repair only applies to WebM
    // — a crashed MP4 (fragmented ISOBMFF) is left untouched and is
    // usually still partially playable.
    const recoveredMime = status.mimeType || 'video/webm';
    if (!srpIsMp4Mime(recoveredMime)) {
      buffer = srpRepairWebM(buffer);
    }
    // Save to History BEFORE clearing the snapshot: if the service worker
    // were killed between a clear and the save, the recovered bytes would
    // be lost from both stores — the exact failure recovery exists to
    // protect against. Clearing last keeps the snapshot as the backup
    // until the recording is safely persisted.
    await SRPDB.addRecording({
      buffer,
      mimeType: recoveredMime,
      thumbnail: null,
      mode: status.mode || 'unknown',
      // The true duration died with the recorder; give a rough estimate
      // from file size (~1MB/s at typical settings) so History doesn't
      // show a recovered file as 00:00.
      duration: Math.max(1, Math.round(buffer.byteLength / 1000000)),
      resolution: status.resolution || null
    });
    await SRPDB.pruneOldest(20);
    await SRPDB.recoveryClear();
    // Tell the user first (so the notification is never blocked by the
    // slower best-effort download below), then clear the stuck state.
    notifyUser(
      '⚠ Recording recovered',
      'Chrome crashed or the extension reloaded mid-recording. The footage up to the last save point was recovered — saved to Recording History and Downloads.'
    );
    await chrome.storage.local.set({ isRecording: false, isPaused: false, activeMode: null, activeTabId: null });
    setBadge('', '#ef4444');
    await closeWidgetWindow();
    // Best-effort download. URL.createObjectURL is NOT available in
    // service workers (verified: TypeError), so the bytes travel to the
    // offscreen document as base64 chunks and it performs the save.
    await downloadRecoveredViaOffscreen(buffer, recoveredMime);
    console.log('[ScreenRecorder] recovered a partial recording after a crash');
  } catch (e) {
    console.error('[ScreenRecorder] Recovery check failed:', e);
  }
}

// Sends the recovered buffer to the offscreen document, which has real
// URL.createObjectURL and performs the actual file download. Sent in
// base64 chunks (Chrome's messaging JSON-serializes binary payloads, and
// a whole recording can exceed the ~32MB message ceiling). The file is
// also in Recording History, so a failed download never loses data.
async function downloadRecoveredViaOffscreen(buffer, mimeType) {
  try {
    await ensureOffscreenDocument();
    await waitForOffscreenReady();
    const id = 'recover_' + Date.now();
    const recoveredMime = mimeType || 'video/webm';
    const filename = `recovered-recording-${Date.now()}.${srpMimeExtension(recoveredMime)}`;
    const CHUNK_SIZE = 4 * 1024 * 1024;
    const total = Math.max(1, Math.ceil(buffer.byteLength / CHUNK_SIZE));
    for (let i = 0; i < total; i++) {
      const part = buffer.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, buffer.byteLength));
      await chrome.runtime.sendMessage({
        action: 'DOWNLOAD_BUFFER_CHUNK',
        id,
        index: i,
        totalChunks: total,
        base64: srpArrayBufferToBase64(part),
        filename,
        mimeType: recoveredMime
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[ScreenRecorder] recovery download failed (file remains in History):', e);
  }
}

// Runs on every service-worker start. Idempotent: it no-ops when there's
// no snapshot, when the snapshot is fresh (a live recording), after a
// live recorder answers the ping, or after a recovery has already
// cleared the snapshot.
recoverFromCrash();

// Also run it when the BROWSER starts. The service worker is created
// lazily, so if the user closes Chrome mid-recording and reopens it
// without touching the extension, the top-level call above never runs —
// this listener is what wakes recovery for that exact scenario.
chrome.runtime.onStartup.addListener(() => {
  recoverFromCrash();
});

// One-shot recheck scheduled when a snapshot looks fresh at service-worker
// start (see recoverFromCrash). Best-effort: a live recording keeps
// appending and the retry keeps skipping; a dead one ages past the
// freshness window and gets recovered. If the service worker idles out
// before the timer fires, the next browser start (onStartup above) still
// catches it — the snapshot is never cleared early anymore, so the data
// can't be lost, only recovered later.
let recoveryRecheckTimer = null;
function scheduleRecoveryRecheck(ms = 90000) {
  if (recoveryRecheckTimer !== null) return;
  recoveryRecheckTimer = setTimeout(() => {
    recoveryRecheckTimer = null;
    recoverFromCrash();
  }, ms);
}

// If the tab being recorded (area mode) closes unexpectedly — mid
// recording, or even mid setup, e.g. the native share dialog was left
// open and never resolved — nothing else would ever reset isRecording,
// permanently blocking any future recording from starting.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeMode, activeTabId } = await chrome.storage.local.get(['activeMode', 'activeTabId']);
  if (activeMode === 'area' && activeTabId === tabId) {
    await chrome.storage.local.set({ isRecording: false, isPaused: false, activeMode: null, activeTabId: null });
    setBadge('', '#ef4444');
  }
});

// Keyboard shortcuts (chrome://extensions/shortcuts). These work even
// when neither the popup nor the widget window is focused.
chrome.commands.onCommand.addListener(async (command) => {
  const { isRecording, isPaused, recordConfig } =
    await chrome.storage.local.get(['isRecording', 'isPaused', 'recordConfig']);

  if (command === 'toggle-recording') {
    if (isRecording) {
      // A stale isRecording flag from a crashed/lost recording would
      // otherwise try to stop a dead recorder and never start — clear it
      // first, and stop only if a recorder is genuinely live.
      if (!(await clearStaleRecordingIfDead())) {
        await routeToActiveRecorder('STOP_AREA_RECORDING', 'STOP_OFFSCREEN');
        return;
      }
    }
    const config = normalizeRecordConfig({ ...DEFAULT_RECORD_CONFIG, ...(recordConfig || {}) });
    if (!config.audioSourceTouched && config.audioSource === 'system') {
      config.audioSource = 'both';
      config.audioSourceTouched = true;
      await chrome.storage.local.set({ recordConfig: config });
    }
    if (config.mode === 'screen') {
      await startOffscreenRecording(config);
    } else {
      // Area mode needs a content script in the active tab. The extension
      // already holds <all_urls> host permissions, so — unlike activeTab
      // alone — that injection doesn't require the gesture to originate
      // from a popup click; it works just as well from here. (Previously
      // this branch did nothing at all for area mode, which is the
      // default mode, so the shortcut only ever worked for "screen".)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        // Persist the resolved config so the injected content script (which
        // reads recordConfig from storage when its flow starts) sees the
        // same settings — otherwise the shortcut path could hand the
        // recorder a stale or missing config.
        await chrome.storage.local.set({ recordConfig: config });
        const result = await startAreaRecording(tab.id, config);
        if (!result.ok) {
          notifyUser('Recording not started', result.error);
        }
      }
    }
  } else if (command === 'toggle-pause') {
    if (!isRecording) return;
    if (isPaused) {
      await routeToActiveRecorder('RESUME_AREA_RECORDING', 'RESUME_OFFSCREEN');
      await chrome.storage.local.set({ isPaused: false });
      setBadge('REC', '#ef4444');
    } else {
      await routeToActiveRecorder('PAUSE_AREA_RECORDING', 'PAUSE_OFFSCREEN');
      await chrome.storage.local.set({ isPaused: true });
      setBadge('II', '#f59e0b');
    }
  } else if (command === 'take-screenshot') {
    await captureScreenshot();
  }
});
