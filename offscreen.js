// Handles "screen" mode recording (entire monitor / a window / a tab
// chosen from Chrome's native picker) inside a hidden offscreen
// document. Unlike area mode, this document has no visible surface of
// its own, so its floating controls live in a separate small extension
// window (widget/widget.html) that background.js opens/closes for it.
//
// Recording happens via one of two pipelines:
//   - DIRECT (webcam off — the common case): the MediaRecorder consumes
//     the raw getDisplayMedia stream. No <video> element, no canvas, no
//     render loop. This is the most robust path in a hidden offscreen
//     document — the media pipeline stays completely untouched, which is
//     important because video elements/canvas compositing in a hidden
//     document have proven fragile (stalled frames, hang-ups).
//   - CANVAS (webcam on): the display stream is played into a <video>
//     element, drawn (with the webcam bubble) onto a canvas, and the
//     canvas stream is recorded.

let mediaRecorder = null;
let recordedChunks = [];
let activeStreams = [];
let renderLoopActive = false;
let isPaused = false;
let recordStartTime = 0;
let totalPausedMs = 0;
let pauseStartedAt = 0;
let currentConfig = null;
let startingCapture = false;
// Crash-recovery checkpoint state (see startRecording): the interval
// appends recorded-so-far deltas to the background's IndexedDB snapshot
// every ~5s so a crash/reload mid-recording doesn't lose everything.
let recoveryTimer = null;
let recoverySentChunks = 0;
// Base64-chunk accumulator for background.js's recovered-file download
// (DOWNLOAD_BUFFER_CHUNK). The service worker has no
// URL.createObjectURL, so the actual save happens here.
let pendingDownload = null;
// Why the current recording stopped: 'user' (widget/popup/shortcut) vs
// 'track-ended' (Chrome ended the share on its own). Included in the
// RECORDING_STOPPED message so background.js can tell the user WHY.
let stopReason = 'user';

// Live-caption overlay state (config.captions): captionEngine owns the
// Web Speech API recognition lifecycle (shared/captions.js), and
// captionText is the current subtitle line — written by the engine's
// onCaption callback, read by every canvas render loop so the text is
// burned into the recorded pixels. When captions are off both stay null.
let captionEngine = null;
let captionText = '';

// Live webcam-bubble state for screen mode (canvas path). Module-level
// (rather than local to startRecording) so the MOVE_BUBBLE message from
// the widget can reposition the bubble while recording, and the preview
// stream can report its location so the widget can zoom in on it.
let screenBubble = null; // { x, y, d } in canvas pixels
let screenDims = null;   // { w, h } recording resolution

// Lets background.js know the message listener below is registered and
// the document is ready to receive START_CAPTURE. Without this, a
// START_CAPTURE sent right after chrome.offscreen.createDocument()
// resolves can arrive before this listener exists and be dropped
// silently — the recording never starts, with no error anywhere.
// version lets background.js detect a STALE document (one that predates
// an extension reload but survived it) so it can be recreated with the
// current code instead of silently running the old build forever.
chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY', version: 3 }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'START_CAPTURE':
      // ACK receipt so background.js can retry if the message was ever
      // lost (it waits for OFFSCREEN_READY first, but this makes the
      // handshake airtight).
      sendResponse({ received: true });
      startRecording(message.config);
      break;
    case 'STOP_OFFSCREEN':
      stopRecording();
      break;
    case 'PAUSE_OFFSCREEN':
      pauseRecording();
      break;
    case 'RESUME_OFFSCREEN':
      resumeRecording();
      break;
    case 'MOVE_BUBBLE':
      // Absolute target ({x, y} — clicks/drag on the widget's mini-map)
      // takes precedence over a delta ({dx, dy} — nudge).
      if (typeof message.x === 'number' && typeof message.y === 'number') {
        setScreenBubble(message.x, message.y);
      } else {
        moveScreenBubble(message.dx || 0, message.dy || 0);
      }
      break;
    case 'RECORDER_ALIVE':
      // Liveness probe for the background start guards: a start is only
      // refused while a recorder is genuinely live — not because a stale
      // isRecording flag survived a crash (which previously blocked every
      // future start with "already starting or in progress"). starting
      // reports whether a START_CAPTURE is still mid-flight here (the
      // share picker is open); when the user cancelled the picker and
      // the completion message got lost, the guard uses it to clear the
      // stale flag instead of refusing.
      sendResponse({
        alive: !!(mediaRecorder && mediaRecorder.state !== 'inactive'),
        starting: !!startingCapture
      });
      break;
    case 'DOWNLOAD_BUFFER_CHUNK':
      handleDownloadChunk(message);
      break;
  }
});

// Sends a diagnostic breadcrumb to the service worker (which logs it in
// the console reachable from chrome://extensions). The offscreen
// document's own console is not inspectable by the user, so the only way
// to see where a stuck recording is stopping is via these messages.
function reportProgress(step, detail) {
  chrome.runtime.sendMessage({ action: 'RECORDING_PROGRESS', step, detail }).catch(() => {});
}

// Reassembles the base64 chunks of a crash-recovered file and downloads
// it from this real document context (URL.createObjectURL works here,
// unlike in the service worker). The document then closes itself — it
// was created only for this download, and a fresh one is created (with
// current code) the next time it's needed.
function handleDownloadChunk(message) {
  if (!pendingDownload || pendingDownload.id !== message.id) {
    pendingDownload = {
      id: message.id,
      parts: new Array(message.totalChunks || 1).fill(undefined),
      filename: message.filename || `recovered-${Date.now()}.webm`,
      mimeType: message.mimeType || 'video/webm'
    };
  }
  pendingDownload.parts[message.index] = message.base64;
  if (pendingDownload.parts.every((p) => p !== undefined)) {
    const full = pendingDownload.parts.join('');
    pendingDownload = null;
    try {
      const binary = atob(full);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: message.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = message.filename || `recovered-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      reportProgress('recovery-downloaded', a.download);
    } catch (e) {
      console.warn('[ScreenRecorder] recovery download failed:', e);
    }
    // Only self-close if this document is NOT the live recorder. Recovery
    // only runs when no recording is believed alive, but screen-mode
    // protection rests on checkpoint freshness alone (the offscreen doc
    // never answers a liveness ping), so a misfire must never be able to
    // kill an actual recording via this close. The guard also shrinks the
    // race where a fresh START_CAPTURE reuses this doc within the delay.
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);
    }
  }
}

// Chrome's extension messaging JSON-serializes payloads (binary arrives
// as an empty {}), so recovery checkpoints travel as base64 strings —
// the same reason area-mode chunks are base64-encoded in selector.js.
// Chunked iteration avoids blowing the call stack on multi-MB buffers.
function srpRecoveryToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

// --- Live picture-in-picture preview ---
//
// In screen mode the recording (and the webcam bubble) happens inside
// this hidden document — the user can't see it on the real screen, only
// in the finished file. The floating widget window shows a live preview
// instead: this document encodes a small JPEG a few times per second and
// messages it to the widget, so the user sees exactly what's being
// recorded (webcam bubble included) in real time. Best-effort: if a
// frame can't be produced, the preview just keeps its last frame — the
// recording itself is never affected.
let previewInterval = null;
// Blank-frame watchdog state (see startPreview): counts consecutive
// near-uniform frames and remembers whether we've already alerted, so
// the notification fires at most once per recording.
let blankStreak = 0;
let blankAlerted = false;
// Luminance mean of the previous blank-check sample, for the stability
// requirement: a dead capture is one solid color for seconds on end, so
// a color that keeps changing (real content) must reset the streak.
let blankPrevMean = null;

function startPreview(source, emitPreview = true) {
  const pv = document.createElement('canvas');
  // 448x252 (16:9): big enough that the widget's live preview — and the
  // floating PiP window it can open — actually looks like the recording
  // instead of a blurry thumbnail, while staying cheap to JPEG-encode a
  // few times per second.
  pv.width = 448;
  pv.height = 252;
  // willReadFrequently: the blank-frame watchdog reads this canvas back
  // every preview tick — telling Chrome up front avoids its Canvas2D
  // readback warning. The preview is small and cosmetic, so the software
  // path costs nothing.
  const pctx = pv.getContext('2d', { willReadFrequently: true });
  previewInterval = setInterval(() => {
    try {
      if (source.canvas) {
        pctx.drawImage(source.canvas, 0, 0, pv.width, pv.height);
      } else if (source.video && source.video.readyState >= source.video.HAVE_CURRENT_DATA) {
        pctx.drawImage(source.video, 0, 0, pv.width, pv.height);
      } else {
        return;
      }
      // --- Blank-frame watchdog (blue-screen detection) ---
      // Chrome's hardware-accelerated video decode can present fullscreen
      // video (e.g. a YouTube video) through a GPU overlay that
      // getDisplayMedia cannot capture — the captured frames come out as
      // one solid color (typically blue). No recorder can capture that
      // overlay, but a stuck capture is trivially detectable: real content
      // is never a perfectly uniform color. Sampling the preview frame
      // (the preview draws from the exact frames being recorded) for a
      // near-zero color variance flags the problem in real time, so the
      // user is told the cause + fix while it's still happening instead of
      // discovering a blue file after stopping.
      if (mediaRecorder && mediaRecorder.state === 'recording' && !blankAlerted && Date.now() - recordStartTime > 5000) {
        const stats = srpFrameStats(pctx, 0, 0, pv.width, pv.height);
        if (stats) {
          // Uniform AND not legitimately black/white content AND the same
          // color as the previous sample — a dead capture stays one color
          // for seconds; real (even static) content eventually changes.
          const stable = blankPrevMean === null || Math.abs(stats.mean - blankPrevMean) < 3;
          blankPrevMean = stats.mean;
          blankStreak = (
            stats.variance < SRP_BLANK_VARIANCE &&
            stats.mean > SRP_BLANK_MIN_MEAN &&
            stats.mean < SRP_BLANK_MAX_MEAN &&
            stable
          ) ? blankStreak + 1 : 0;
          if (blankStreak >= 8) {
            blankAlerted = true;
            chrome.runtime.sendMessage({ action: 'BLANK_CAPTURE_DETECTED' }).catch(() => {});
          }
        }
      }
      if (emitPreview) {
        chrome.runtime.sendMessage({
          action: 'RECORDING_PREVIEW',
          dataUrl: pv.toDataURL('image/jpeg', 0.4),
          // Bubble position + recording dimensions so the widget can zoom
          // its view onto the bubble and map drags to recording pixels.
          bubble: screenBubble ? { x: screenBubble.x, y: screenBubble.y, d: screenBubble.d } : null,
          dims: screenDims
        }).catch(() => {});
      }
    } catch (e) {
      // Preview is cosmetic — never let it interfere with recording.
    }
  }, emitPreview ? 200 : 1000);
}

function stopPreview() {
  if (previewInterval) {
    clearInterval(previewInterval);
    previewInterval = null;
  }
}

// Moves the live webcam bubble (screen mode) by a canvas-pixel delta,
// clamped to the frame. Driven by the widget's bubble panel — the user
// drags or nudges there and both the preview and the finished recording
// reflect the new position immediately.
function moveScreenBubble(dx, dy) {
  if (!screenBubble || !screenDims) return;
  setScreenBubble(screenBubble.x + dx, screenBubble.y + dy);
}

// Places the bubble at an absolute canvas-pixel position (top-left of
// the bubble), clamped to the frame.
function setScreenBubble(x, y) {
  if (!screenBubble || !screenDims) return;
  screenBubble.x = Math.max(0, Math.min(x, screenDims.w - screenBubble.d));
  screenBubble.y = Math.max(0, Math.min(y, screenDims.h - screenBubble.d));
}

// Waits until the video element has real decodable frames. Uses a
// short-poll instead of requestAnimationFrame: the offscreen document is
// a hidden page, and rAF is not guaranteed to tick there — if it never
// fires, the recording would hang forever before ever starting.
function waitForVideoData(video, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = setInterval(() => {
      if (video.readyState >= video.HAVE_CURRENT_DATA || Date.now() - start > timeoutMs) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
}

// Waits for stream metadata (dimensions etc.) with a hard timeout.
// waiting on the loadedmetadata event alone turned out to be the exact
// place screen/tab recordings stalled forever: in a hidden offscreen
// document the media pipeline occasionally never fires it, so the await
// below never resolved and the recording silently never started even
// though the user had already shared their screen/window. Polling (with
// a fallback timeout) cannot hang.
function waitForMetadata(video, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (video.videoWidth > 0 || video.readyState >= video.HAVE_METADATA) return resolve();
    const start = Date.now();
    const poll = setInterval(() => {
      if (
        video.videoWidth > 0 ||
        video.readyState >= video.HAVE_METADATA ||
        Date.now() - start > timeoutMs
      ) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
}

// Adds the mixed audio track (system + mic) to a stream that doesn't
// already contain it. Any audio tracks already on the stream (the raw
// system track in the direct path) are stripped FIRST: a MediaRecorder
// handed two audio tracks (the original system track AND the system+mic
// mix) picks one arbitrarily, which could silently drop the microphone
// in "System + Microphone" mode. options flows through to
// srpMixAudioTracks (noise reduction on the mic track).
function attachMixedAudio(stream, tracks, options) {
  const mixed = srpMixAudioTracks(tracks, options);
  if (!mixed) return;
  stream.getAudioTracks().forEach((t) => stream.removeTrack(t));
  if (!stream.getAudioTracks().includes(mixed)) {
    stream.addTrack(mixed);
  }
}

// Screen/window recordings should keep the capture's native geometry.
// Canvas compositing is only needed when we actually add pixels (webcam
// or captions). If a canvas is required, clip at most one odd edge so the
// encoder receives even dimensions without padding a 1920x1080 monitor to
// 1920x1088 or scaling the whole desktop.
function screenCanvasSize(width, height) {
  const sourceW = Math.max(2, Math.round(width || 1280));
  const sourceH = Math.max(2, Math.round(height || 720));
  const w = Math.max(2, sourceW - (sourceW % 2));
  const h = Math.max(2, sourceH - (sourceH % 2));
  return {
    w,
    h,
    drawW: sourceW,
    drawH: sourceH,
    clipped: w !== sourceW || h !== sourceH
  };
}

async function startRecording(config) {
  // A second START_CAPTURE while the first is still starting (or
  // actively recording) must be ignored: calling getDisplayMedia again
  // would terminate the first capture in Chrome, ending the recording
  // the moment it began (the widget flashing open then closing).
  if (startingCapture || (mediaRecorder && mediaRecorder.state !== 'inactive')) {
    return;
  }
  startingCapture = true;
  // Fresh-session state. Most importantly stopReason: it defaults to
  // 'user' but a previous recording that ended via 'track-ended' (Chrome
  // stopped the share) would otherwise leak into the NEXT recording,
  // making an ordinary user-stop report "Chrome ended the share".
  stopReason = 'user';
  blankStreak = 0;
  blankAlerted = false;
  blankPrevMean = null;
  // WebCodecs readers bypass hidden-document <video> presentation
  // throttling. The display reader feeds the main canvas in webcam mode;
  // the webcam reader feeds the bubble. Video elements remain fallbacks.
  // Function scope lets onstop/catch clean every live frame deterministically.
  let displayReader = null;
  let latestDisplayFrame = null;
  let displayFrameSeq = 0;
  let webcamReader = null;
  let latestWebcamFrame = null;
  let webcamFrameSeq = 0;
  try {
    currentConfig = config;

    // Deliberately NO displaySurface constraint: Chrome treats it as an
    // enforceable constraint in some versions, and a picker selection
    // that doesn't match (e.g. sharing a WINDOW while 'monitor' was
    // requested) made the whole promise reject — which surfaced exactly
    // as "I shared my window and nothing happened". With the constraint
    // omitted, any surface the user picks is accepted and the native
    // picker still pre-selects the whole screen.
    const preset = srpGetPreset(config.quality);
    reportProgress('picker-opening', 'getDisplayMedia called');
    const wantsSystemAudio = config.audioSource === 'system' || config.audioSource === 'both';
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: config.cursor ? 'always' : 'never',
        // Ideal, not exact: a bare number would be treated as an exact
        // frameRate constraint, and rejecting (OverconstrainedError) a
        // perfectly good capture because it can only sustain 50fps
        // instead of the requested 60 was a real failure mode.
        frameRate: { ideal: config.fps || 60 },
        width: { ideal: preset.width },
        height: { ideal: preset.height }
      },
      audio: wantsSystemAudio ? { suppressLocalAudioPlayback: false } : false,
      // Chrome 105+ / 140+ hints. They do not manufacture audio on Linux,
      // but on platforms that support desktop/window audio they make the
      // intended source explicit instead of relying on browser defaults.
      systemAudio: wantsSystemAudio ? 'include' : 'exclude',
      windowAudio: wantsSystemAudio ? 'system' : 'exclude'
    });
    activeStreams.push(displayStream);

    let webcamStream = null;
    if (config.webcam) {
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 320 }
        });
        activeStreams.push(webcamStream);
      } catch (e) {
        // A silently missing bubble looks like a broken feature — tell the
        // user the camera was blocked and how to fix it (background.js
        // shows this as a notification).
        console.warn('Webcam unavailable, continuing without it:', e.message);
        reportProgress('webcam-unavailable', 'recording without webcam overlay');
        chrome.runtime.sendMessage({ action: 'WEBCAM_UNAVAILABLE', reason: e.name }).catch(() => {});
      }
    }

    let micStream = null;
    if (config.audioSource === 'mic' || config.audioSource === 'both') {
      try {
        // Echo cancellation keeps the speaker sound out of the mic;
        // browser input AGC raises low-sensitivity microphones before
        // RNNoise; the custom DSP then performs slower output leveling.
        // System audio is never processed. Chrome's own noiseSuppression
        // is deliberately NOT requested: RNNoise (below) does the noise
        // removal, and Chrome's built-in suppression is an aggressive
        // "cancellation" that has erased soft laptop-mic voices outright
        // on some platforms — the exact failure this recorder must never
        // have (captions still heard the voice; the recording was silent).
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
        });
        activeStreams.push(micStream);
      } catch (e) {
        // Some platforms/devices reject the processing-constraint combo
        // (OverconstrainedError). Fall back to a plain mic so noise
        // reduction degrades to unprocessed audio — never to NO mic.
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          activeStreams.push(micStream);
        } catch (e2) {
          console.warn('Microphone unavailable, continuing without it:', e2.message);
          chrome.runtime.sendMessage({
            action: 'MICROPHONE_UNAVAILABLE',
            reason: e2.name,
            audioSource: config.audioSource
          }).catch(() => {});
        }
      }
    }

    const displayVideoTrack = displayStream.getVideoTracks()[0];
    const trackSettings = displayVideoTrack.getSettings();
    const emitFloatingPreview = trackSettings.displaySurface !== 'monitor';
    reportProgress('picker-resolved', (trackSettings.displaySurface || 'surface') + ' ' + (trackSettings.width || '?') + 'x' + (trackSettings.height || '?'));

    const systemAudioTrack = displayStream.getAudioTracks()[0] || null;
    // The user asked for system audio but Chrome delivered none — the
    // "Share audio" checkbox wasn't ticked in the picker, or (on Linux)
    // the platform doesn't support system audio for window/entire-screen
    // capture at all. Say so instead of the recording silently coming out
    // without sound.
    if ((config.audioSource === 'system' || config.audioSource === 'both') && !systemAudioTrack) {
      chrome.runtime.sendMessage({
        action: 'SYSTEM_AUDIO_MISSING',
        surface: trackSettings.displaySurface || 'unknown'
      }).catch(() => {});
    }
    const micTrack = micStream ? micStream.getAudioTracks()[0] : null;

    // --- Recording pipeline selection ---
    // Screen/window mode preserves the browser's native capture geometry.
    // Canvas compositing is used only when we actually need to add pixels
    // (webcam or captions), never just to force codec macroblock sizing.
    let compositeStream;
    let canvas = null; // only set in the canvas (webcam) path
    let drawTimer = null;

    if (webcamStream) {
      // Canvas path: play the display into a <video>, draw it (plus the
      // webcam bubble) onto a canvas, record the canvas stream. Only
      // used when a webcam overlay is actually requested.
      const video = document.createElement('video');
      video.srcObject = displayStream;
      video.muted = true;
      video.playsInline = true;
      await waitForMetadata(video);
      video.play().catch(() => {});
      await waitForVideoData(video);

      // --- Display frame source ---
      // A hidden offscreen document may present a <video> element at a much
      // lower cadence than the captured track. Read VideoFrames directly
      // from the display track so webcam compositing follows the source
      // cadence instead of the hidden element's presentation cadence.
      if (typeof MediaStreamTrackProcessor !== 'undefined') {
        try {
          const displayProcessor = new MediaStreamTrackProcessor({ track: displayVideoTrack });
          displayReader = displayProcessor.readable.getReader();
          (async () => {
            try {
              while (true) {
                const { value, done } = await displayReader.read();
                if (done) {
                  if (value) value.close();
                  break;
                }
                if (latestDisplayFrame) latestDisplayFrame.close();
                latestDisplayFrame = value;
                displayFrameSeq += 1;
              }
            } catch (e) {
              if (latestDisplayFrame) {
                try { latestDisplayFrame.close(); } catch (e2) {}
                latestDisplayFrame = null;
              }
              displayReader = null;
            }
          })();
        } catch (e) {
          displayReader = null;
        }
      }

      // --- Webcam frame source ---
      // Chrome throttles <video> element frame presentation in hidden
      // documents, which froze the bubble's content for 1-2s at a time
      // (most visible exactly while dragging it — redraws only happened on
      // display-frame changes or bubble moves, so the stale camera frame
      // was only ever noticed mid-drag). Reading frames straight off the
      // track with WebCodecs bypasses the element's presentation pipeline
      // entirely, so the bubble always gets fresh camera frames at full
      // rate. Falls back to the video element when WebCodecs is
      // unavailable or the reader fails.
      let webcamVideo = null;
      if (typeof MediaStreamTrackProcessor !== 'undefined') {
        try {
          const processor = new MediaStreamTrackProcessor({
            track: webcamStream.getVideoTracks()[0]
          });
          webcamReader = processor.readable.getReader();
          (async () => {
            try {
              while (true) {
                const { value, done } = await webcamReader.read();
                if (done) {
                  if (value) value.close();
                  break;
                }
                if (latestWebcamFrame) latestWebcamFrame.close();
                latestWebcamFrame = value;
                webcamFrameSeq += 1;
              }
            } catch (e) {
              // Reader failure — e.g. the camera was unplugged or denied
              // mid-recording. Drop the stale frame and fall back to the
              // video element so the bubble keeps working (or degrades to
              // nothing) instead of showing a frozen face. Never affects
              // the recording itself; during shutdown just bail out.
              if (latestWebcamFrame) {
                try { latestWebcamFrame.close(); } catch (e2) {}
                latestWebcamFrame = null;
              }
              if (!renderLoopActive) return;
              webcamReader = null;
              if (!webcamVideo) {
                try {
                  webcamVideo = document.createElement('video');
                  webcamVideo.srcObject = webcamStream;
                  webcamVideo.muted = true;
                  webcamVideo.playsInline = true;
                  webcamVideo.play().catch(() => {});
                } catch (e3) {}
              }
            }
          })();
        } catch (e) {
          webcamReader = null;
        }
      }
      if (!webcamReader) {
        webcamVideo = document.createElement('video');
        webcamVideo.srcObject = webcamStream;
        webcamVideo.muted = true;
        webcamVideo.playsInline = true;
        await waitForMetadata(webcamVideo);
        webcamVideo.play().catch(() => {});
        // Short wait for the webcam only — the display stream is the one
        // that must not be held up waiting for camera frames.
        await waitForVideoData(webcamVideo, 3000);
      }

      // The ACTUAL decoded frame is the source of truth for the canvas
      // size — NOT trackSettings. getSettings() reports the *logical*
      // size on Windows DPI-scaled displays (125%/150%), which disagrees
      // with the real frame the video element decodes, and some Chrome
      // versions omit width/height from getSettings() entirely. Using a
      // mismatched canvas here made drawImage stretch the picture, so
      // players cropped/padded the BOTTOM of the recording (green/black
      // band, cut-off bottom, doubled bottom row on some platforms).
      // Fallbacks keep the canvas from ever being 0-sized (which would
      // make canvas.captureStream() produce an empty stream and the
      // MediaRecorder fail outright) even if metadata never arrived.
      let canvasWidth = video.videoWidth || trackSettings.width || 1280;
      let canvasHeight = video.videoHeight || trackSettings.height || 720;
      // Preserve the selected screen/window's native dimensions.
      // Only an odd final row/column is clipped when canvas compositing is
      // required; a normal 1920x1080 capture remains exactly 1920x1080.
      const captureSize = screenCanvasSize(canvasWidth, canvasHeight);
      canvasWidth = captureSize.w;
      canvasHeight = captureSize.h;

      canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      // NO desynchronized: true here. A desynchronized 2D context is
      // meant for low-latency presentation on screen; in a hidden
      // offscreen document nothing is presented, and desync is a known
      // source of broken/stalled canvas.captureStream() output.
      const ctx = canvas.getContext('2d', { alpha: false });
      // Pixel-crisp: the canvas is sized from the decoded frame and
      // differs by at most one odd edge pixel, so nearest-neighbor keeps
      // text edges hard instead of softening the desktop during compositing.
      ctx.imageSmoothingEnabled = false;

      // The bubble starts at the corner picked in the popup, but unlike
      // a fixed constant it's stored in module state so the user can
      // drag it to any position via the widget's bubble panel while
      // recording (full-screen capture has no page DOM to drag on).
      const bubbleDiameter = Math.round(canvasWidth * 0.16);
      const bubbleMargin = Math.round(canvasWidth * 0.02);
      const positions = {
        'bottom-right': [canvasWidth - bubbleDiameter - bubbleMargin, canvasHeight - bubbleDiameter - bubbleMargin],
        'bottom-left': [bubbleMargin, canvasHeight - bubbleDiameter - bubbleMargin],
        'top-right': [canvasWidth - bubbleDiameter - bubbleMargin, bubbleMargin],
        'top-left': [bubbleMargin, bubbleMargin]
      };
      const initial = positions[config.webcamPosition] || positions['bottom-right'];
      screenDims = { w: canvasWidth, h: canvasHeight };
      screenBubble = { x: initial[0], y: initial[1], d: bubbleDiameter };

      const bubbleShape = config.webcamShape === 'rounded' ? 'rounded' : 'circle';
      function traceBubblePath(c, x, y, w, h) {
        if (bubbleShape === 'rounded') {
          const r = Math.min(w, h) * 0.18;
          c.beginPath();
          c.roundRect(x, y, w, h, r);
        } else {
          c.beginPath();
          c.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
        }
        c.closePath();
      }

      renderLoopActive = true;
      // The draw loop is a plain self-sustaining timer at the target
      // cadence. It deliberately does NOT rely on
      // requestVideoFrameCallback: in a hidden offscreen document Chrome
      // throttles video-frame presentation, which made an rVFC-only loop
      // silently stall — the watchdog then only redrew ~2x/second and the
      // recording came out as a frame-frame-frame slideshow. A fixed
      // cadence always feeds canvas.captureStream at the requested fps
      // (redrawing the latest available frame when the source is slow is
      // cheap and harmless).
      const cadence = 1000 / (config.fps || 60);
      let lastDrawnVideoTime = -1;
      let lastDrawnDisplaySeq = -1;
      let lastDrawnBubble = null; // snapshot of the last drawn bubble position
      let lastDrawnWebcamSeq = -1;
      let lastCaptionDrawn = '';

      function renderFrame() {
        if (!renderLoopActive) return;
        // Skip the (expensive full-resolution) redraw when nothing
        // changed: at 60fps cadence with a 30fps source, half the draws
        // would otherwise be wasted work on an identical frame. Redraw
        // when the display presented a new frame, the bubble moved (so
        // positioning stays live and smooth), or a fresh webcam frame
        // arrived (so the face in the bubble stays live even on a static
        // screen).
        const videoTime = video.readyState >= video.HAVE_CURRENT_DATA ? video.currentTime : -1;
        const displayChanged = displayReader
          ? displayFrameSeq !== lastDrawnDisplaySeq
          : videoTime !== lastDrawnVideoTime;
        const b = screenBubble;
        const bubbleMoved = !lastDrawnBubble || !b ||
          b.x !== lastDrawnBubble.x || b.y !== lastDrawnBubble.y || b.d !== lastDrawnBubble.d;
        const webcamChanged = webcamFrameSeq !== lastDrawnWebcamSeq;
        const captionChanged = captionText !== lastCaptionDrawn;
        if (displayChanged || bubbleMoved || webcamChanged || captionChanged) {
          lastDrawnVideoTime = videoTime;
          lastDrawnDisplaySeq = displayFrameSeq;
          lastDrawnBubble = b ? { x: b.x, y: b.y, d: b.d } : null;
          lastDrawnWebcamSeq = webcamFrameSeq;
          lastCaptionDrawn = captionText;
          ctx.clearRect(0, 0, canvasWidth, canvasHeight);
          const displaySource = latestDisplayFrame || (videoTime >= 0 ? video : null);
          if (displaySource) {
            // Native-size draw; when a source edge is odd the canvas is one
            // pixel smaller and simply clips that final row/column.
            ctx.drawImage(displaySource, 0, 0, captureSize.drawW, captureSize.drawH);
          }
          if (b) {
            ctx.save();
            traceBubblePath(ctx, b.x, b.y, b.d, b.d);
            ctx.clip();
            if (latestWebcamFrame) {
              ctx.drawImage(latestWebcamFrame, b.x, b.y, b.d, b.d);
            } else if (webcamVideo && webcamVideo.readyState >= webcamVideo.HAVE_CURRENT_DATA) {
              ctx.drawImage(webcamVideo, b.x, b.y, b.d, b.d);
            }
            ctx.restore();
            ctx.lineWidth = Math.max(2, canvasWidth * 0.003);
            ctx.strokeStyle = '#10b981';
            traceBubblePath(ctx, b.x, b.y, b.d, b.d);
            ctx.stroke();
          }
          if (captionText && typeof srpDrawCaptions === 'function') {
            srpDrawCaptions(ctx, canvasWidth, canvasHeight, captionText, { size: config.captionsSize || 'medium' });
          }
        }
        drawTimer = setTimeout(renderFrame, cadence);
      }
      renderFrame();

      compositeStream = canvas.captureStream(config.fps || 60);
      attachMixedAudio(compositeStream, [systemAudioTrack, micTrack], {
        noiseReduction: config.noiseReduction,
        // Screen/window keeps RNNoise noise removal, but never hard-gates
        // speech. This preserves quiet and first words while RNNoise warms up.
        noiseGate: false,
        micTrack,
        systemMixGain: config.audioSource === 'both' ? 0.35 : 0.72
      });
      reportProgress('pipeline', 'canvas compositing with webcam overlay');
      // Keep the internal preview/watchdog alive for every capture, but on
      // an entire monitor do not emit floating-preview frames that have no
      // visible consumer (the monitor widget is intentionally closed).
      startPreview({ canvas }, emitFloatingPreview);
    } else {
      // Direct path: record the raw display stream whenever possible.
      // The preview <video> is only a decoded-size probe + cosmetic live
      // preview; it is not part of the recorded path unless captions or
      // an odd source edge require a tiny canvas composition.
      //
      // Decoded dimensions are the source of truth because getSettings()
      // can report logical DPI-scaled dimensions that differ from the
      // actual frames delivered by Chrome.
      const previewVideo = document.createElement('video');
      previewVideo.srcObject = displayStream;
      previewVideo.muted = true;
      previewVideo.playsInline = true;
      previewVideo.play().catch(() => {});
      // Wait for decoded dimensions, with a hard timeout so a hidden
      // offscreen document can never hang the recording start.
      await waitForMetadata(previewVideo, 4000);
      const realW = previewVideo.videoWidth || trackSettings.width || 1280;
      const realH = previewVideo.videoHeight || trackSettings.height || 720;
      // Keep the raw stream for normal screen/window capture so Chrome
      // can preserve the source cadence without a full-resolution hidden
      // canvas. Captions are the only reason this no-webcam path composites.
      const captureSize = screenCanvasSize(realW, realH);
      const needsCanvas = !!config.captions;
      if (needsCanvas) {
        canvas = document.createElement('canvas');
        canvas.width = captureSize.w;
        canvas.height = captureSize.h;
        const ctx = canvas.getContext('2d', { alpha: false });
        // This path is native-size except for a possible one-pixel
        // edge clip, so nearest-neighbor keeps desktop text crisp.
        ctx.imageSmoothingEnabled = false;
        renderLoopActive = true;
        const cadence = 1000 / (config.fps || 60);
        let lastResampleT = -1;
        let lastCaptionDrawn = '';
        const loop = () => {
          if (!renderLoopActive) return;
          const t = previewVideo.readyState >= previewVideo.HAVE_CURRENT_DATA ? previewVideo.currentTime : -1;
          // Redraw when the video advanced OR the caption line changed
          // (a caption update must appear even on a static screen).
          if (t !== lastResampleT || captionText !== lastCaptionDrawn) {
            lastResampleT = t;
            lastCaptionDrawn = captionText;
            ctx.clearRect(0, 0, captureSize.w, captureSize.h);
            if (t >= 0) {
              // Native-size draw; an odd final row/column is clipped.
              ctx.drawImage(previewVideo, 0, 0, captureSize.drawW, captureSize.drawH);
            }
            if (captionText && typeof srpDrawCaptions === 'function') {
              srpDrawCaptions(ctx, captureSize.w, captureSize.h, captionText, { size: config.captionsSize || 'medium' });
            }
          }
          drawTimer = setTimeout(loop, cadence);
        };
        loop();
        compositeStream = canvas.captureStream(config.fps || 60);
        attachMixedAudio(compositeStream, [systemAudioTrack, micTrack], {
          noiseReduction: config.noiseReduction,
          // Screen/window keeps RNNoise noise removal, but never hard-gates
          // speech. This preserves quiet and first words while RNNoise warms up.
          noiseGate: false,
          micTrack,
          systemMixGain: config.audioSource === 'both' ? 0.35 : 0.72
        });
        reportProgress('pipeline', captureSize.clipped ? 'canvas compose (native frame, 1px edge clip)' : 'canvas compose (native frame)');
        screenDims = { w: captureSize.w, h: captureSize.h };
        startPreview({ canvas }, emitFloatingPreview);
      } else {
        compositeStream = displayStream;
        attachMixedAudio(compositeStream, [systemAudioTrack, micTrack], {
          noiseReduction: config.noiseReduction,
          // Screen/window keeps RNNoise noise removal, but never hard-gates
          // speech. This preserves quiet and first words while RNNoise warms up.
          noiseGate: false,
          micTrack,
          systemMixGain: config.audioSource === 'both' ? 0.35 : 0.72
        });
        reportProgress('pipeline', 'direct stream recording (no webcam)');
        // Live preview from the raw stream. The video element is ONLY
        // for this cosmetic preview (never part of the recording
        // pipeline), so even if it misbehaves the recording is
        // completely unaffected.
        screenDims = { w: realW, h: realH };
        startPreview({ video: previewVideo }, emitFloatingPreview);
      }
    }

    // The recorded stream's true dimensions. screenDims is set by every
    // pipeline branch to the EXACT pixels being recorded (the canvas dims
    // in the webcam/resample paths, the decoded frame size in the direct
    // path) — NOT trackSettings, which reports the logical size on
    // DPI-scaled displays. The bitrate and the history resolution label
    // must match the real recorded pixels.
    const canvasWidth = screenDims ? screenDims.w : (trackSettings.width || 1280);
    const canvasHeight = screenDims ? screenDims.h : (trackSettings.height || 720);
    const bitrate = srpScaledBitrate(config.quality, canvasWidth, canvasHeight);
    // MP4 (H.264) preferred, WebM fallback — see srpPickMimeType() in
    // qualityPresets.js. The mime actually used is captured so the blobs,
    // filenames, history entries and recovery checkpoints below all match
    // the container that was really recorded.
    const recorderInfo = srpCreateMediaRecorder(compositeStream, bitrate, null, config.outputFormat === 'webm');
    mediaRecorder = recorderInfo.recorder;
    const recorderMime = recorderInfo.mimeType;
    // Raw display streams can have odd pixel dimensions (for example a
    // 1599x947 window). VP8/WebM preserves those dimensions, but H.264/MP4
    // encoders require 4:2:0-compatible even dimensions and Chrome clips the
    // final odd row/column. Keep History/recovery metadata aligned with the
    // actual file rather than labeling a 1598x946 MP4 as 1599x947.
    const recordedWidth = srpIsMp4Mime(recorderMime)
      ? Math.max(2, canvasWidth - (canvasWidth % 2))
      : canvasWidth;
    const recordedHeight = srpIsMp4Mime(recorderMime)
      ? Math.max(2, canvasHeight - (canvasHeight % 2))
      : canvasHeight;
    recordedChunks = [];
    isPaused = false;
    totalPausedMs = 0;
    recordStartTime = Date.now();

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      // Identity guard: state is cleared (and RECORDING_STOPPED sent)
      // before the async save below, so a NEW recording can legitimately
      // start in this same document while onstop is still saving. The
      // final window.close() must then only run if this is still the
      // current recorder — otherwise it would kill the new recording.
      const myRecorder = mediaRecorder;
      renderLoopActive = false;
      if (drawTimer) clearTimeout(drawTimer);
      stopPreview();
      if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
      recoverySentChunks = 0;
      screenBubble = null;
      screenDims = null;
      if (displayReader) { try { displayReader.cancel(); } catch (e) {} displayReader = null; }
      if (latestDisplayFrame) { try { latestDisplayFrame.close(); } catch (e) {} latestDisplayFrame = null; }
      if (webcamReader) { try { webcamReader.cancel(); } catch (e) {} webcamReader = null; }
      if (latestWebcamFrame) { try { latestWebcamFrame.close(); } catch (e) {} latestWebcamFrame = null; }
      if (captionEngine) { try { captionEngine.stop(); } catch (e) {} captionEngine = null; }
      captionText = '';
      activeStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      activeStreams = [];

      // Snapshot the mode now: the async IndexedDB write below runs
      // after this recorder has already reached 'inactive', so a new
      // recording could theoretically start (and overwrite currentConfig)
      // before the save finishes. Saving the value up front keeps the
      // history entry labeled with the recording it actually belongs to.
      const savedMode = (currentConfig && currentConfig.mode) || 'screen';
      const resolution = `${recordedWidth}x${recordedHeight}`;
      const durationSec = Math.round((Date.now() - recordStartTime - totalPausedMs) / 1000);

      const blob = new Blob(recordedChunks, { type: recorderMime });

      // Clear the recording state via background.js, which is the single
      // owner of persisted state — this document deliberately never
      // touches chrome.storage (it is not reliably available in offscreen
      // documents on all Chrome versions; using it here threw and killed
      // recordings the instant they started). The message is sent before
      // the async save below so a fast retry is never blocked.
      chrome.runtime.sendMessage({
        action: 'RECORDING_STOPPED',
        // 'track-ended' = Chrome stopped the shared tab/window (onended
        // fired) — worth telling the user why the recording ended, since
        // nothing they did caused it.
        reason: stopReason
      }).catch(() => {});

      reportProgress('stopped', `chunks=${recordedChunks.length} bytes=${blob.size} reason=${stopReason} codec=${recorderMime}`);

      if (blob.size === 0) {
        // Zero-byte recording: the encoder produced nothing (the classic
        // VP9-on-raw-stream Linux failure). Don't download/save noise.
        console.warn('[ScreenRecorder] recording produced 0 bytes — skipped empty file');
        if (mediaRecorder === myRecorder) window.close();
        return;
      }

      const thumbnail = canvas ? canvas.toDataURL('image/jpeg', 0.5) : null;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `full-recording-${Date.now()}.${srpMimeExtension(recorderMime)}`;
      a.click();
      URL.revokeObjectURL(url);

      try {
        const buffer = await blob.arrayBuffer();
        await SRPDB.addRecording({
          buffer,
          mimeType: recorderMime,
          thumbnail,
          mode: savedMode,
          duration: durationSec,
          resolution
        });
        await SRPDB.pruneOldest(20);
        // The recording is safely in History — the crash-recovery snapshot
        // is obsolete. Only clear it AFTER this save succeeds: if Chrome
        // was shutting down and the save failed, the snapshot survives so
        // the next launch can recover it (background.js RECOVERY_CLEAR).
        chrome.runtime.sendMessage({ action: 'RECOVERY_CLEAR' }).catch(() => {});
      } catch (e) {
        console.warn('Could not save recording to history:', e);
      }
      if (mediaRecorder === myRecorder) window.close();
    };

    // Track-lifecycle handlers are assigned BEFORE mediaRecorder.start()
    // so there's no gap where the capture could end without being
    // handled.
    displayVideoTrack.onended = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        stopReason = 'track-ended';
        console.warn('[ScreenRecorder] capture track ended — Chrome stopped the share (the shared tab/window closed or was stopped)');
        reportProgress('track-ended', 'Chrome stopped the shared tab/window');
        mediaRecorder.stop();
      }
    };
    mediaRecorder.onerror = (e) => {
      stopReason = 'recorder-error';
      console.error('[ScreenRecorder] MediaRecorder error:', e.error && e.error.name, e.error && e.error.message);
      reportProgress('recorder-error', (e.error && e.error.message) || 'unknown MediaRecorder error');
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    };

    // --- Live captions (burned into the recorded frames) ---
    // The Web Speech API captures the microphone itself — it doesn't
    // need the mixer's mic track, only the extension's granted mic
    // permission (pre-flighted in the popup). It works in this hidden
    // document: the same kind of page as the MV2 background pages where
    // SpeechRecognition has always worked. If it can't run (mic
    // denied, no network, unsupported), the recording simply continues
    // and background.js tells the user why captions are missing.
    if (config.captions) {
      // Prefer Chrome's established webkit constructor: it is backed by
      // the multilingual online recognizer. Some recent Chrome builds
      // expose an unprefixed on-device-first constructor alongside it.
      const R = (typeof webkitSpeechRecognition !== 'undefined') ? webkitSpeechRecognition
        : (typeof SpeechRecognition !== 'undefined') ? SpeechRecognition : null;
      if (!R || typeof srpCreateCaptionEngine !== 'function') {
        chrome.runtime.sendMessage({ action: 'CAPTIONS_UNAVAILABLE', reason: 'unsupported' }).catch(() => {});
      } else {
        captionEngine = srpCreateCaptionEngine({
          Recognition: R,
          lang: config.captionsLang || 'en-US',
          onCaption: (t) => { captionText = t; },
          onError: (reason) => {
            chrome.runtime.sendMessage({ action: 'CAPTIONS_UNAVAILABLE', reason }).catch(() => {});
          }
        });
        captionEngine.start();
      }
    }

    reportProgress('media-recorder-started', 'recording began');
    mediaRecorder.start(1000);

    // --- Crash-recovery checkpoints ---
    // Append the recorded-so-far bytes (delta-only) to the background's
    // IndexedDB snapshot every ~5s. If Chrome crashes or the extension
    // reloads mid-recording, the snapshot survives and background.js
    // offers it back ("⚠ Recording recovered"). While paused nothing is
    // appended, so the same tick sends a lightweight heartbeat instead to
    // keep the snapshot marked as live.
    recoverySentChunks = 0;
    // In-flight guard: if one tick's send + service-worker round-trip ever
    // exceeded 5s, the next tick would overlap it and two concurrent
    // RECOVERY_APPENDs could both read the same checkpoint sequence number,
    // silently dropping a chunk (a hole in the recovered file).
    let recoveryBusy = false;
    recoveryTimer = setInterval(async () => {
      if (recoveryBusy) return;
      recoveryBusy = true;
      try {
        if (!mediaRecorder) return;
        if (mediaRecorder.state !== 'recording') {
          chrome.runtime.sendMessage({ action: 'RECOVERY_HEARTBEAT' }).catch(() => {});
          return;
        }
        // Delta-only by chunk COUNT: materializing the whole recording
        // every 5s to slice out new bytes would be O(n²) over a long
        // recording (see selector.js for the same reasoning).
        if (recordedChunks.length <= recoverySentChunks) return;
        const fresh = recordedChunks.slice(recoverySentChunks);
        const blob = new Blob(fresh, { type: recorderMime });
        recoverySentChunks = recordedChunks.length;
        if (blob.size === 0) return;
        const buffer = await blob.arrayBuffer();
        chrome.runtime.sendMessage({
          action: 'RECOVERY_APPEND',
          chunk: srpRecoveryToBase64(buffer),
          mode: 'screen',
          resolution: `${recordedWidth}x${recordedHeight}`,
          mimeType: recorderMime
        }).catch(() => {});
      } catch (e) {
        // Recovery must never be able to affect the recording itself.
      } finally {
        recoveryBusy = false;
      }
    }, 5000);

    // background.js persists isRecording/recordStartTime from this
    // message — the offscreen document never writes storage itself (it's
    // not reliably available here; see the note in onstop).
    chrome.runtime.sendMessage({
      action: 'RECORDING_STARTED',
      mode: config.mode,
      recordStartTime,
      surface: trackSettings.displaySurface || 'unknown',
      sourceFrameRate: trackSettings.frameRate || null
    }).catch(() => {});
  } catch (err) {
    // This path must ALWAYS run to completion: it tells background.js to
    // reset its own state + close the widget. Nothing here touches
    // chrome.storage — every storage operation lives in the background
    // service worker, which is the only context with reliable access.
    console.error('[ScreenRecorder] Failed to start offscreen recorder:', err.name, err.message, err.stack);
    renderLoopActive = false;
    if (drawTimer) clearTimeout(drawTimer);
    stopPreview();
    if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
    if (displayReader) { try { displayReader.cancel(); } catch (e) {} displayReader = null; }
    if (latestDisplayFrame) { try { latestDisplayFrame.close(); } catch (e) {} latestDisplayFrame = null; }
    if (webcamReader) { try { webcamReader.cancel(); } catch (e) {} webcamReader = null; }
    if (latestWebcamFrame) { try { latestWebcamFrame.close(); } catch (e) {} latestWebcamFrame = null; }
    if (captionEngine) { try { captionEngine.stop(); } catch (e) {} captionEngine = null; }
    captionText = '';
    activeStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    activeStreams = [];
    chrome.runtime.sendMessage({ action: 'RECORDING_FAILED', error: err.message, errorName: err.name }).catch(() => {});
    try { window.close(); } catch (e) { /* the document may already be gone */ }
  } finally {
    // Unconditionally reset the start lock — if anything above throws,
    // the next start attempt must never be falsely blocked.
    startingCapture = false;
  }
}

function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    isPaused = true;
    pauseStartedAt = Date.now();
    // The pause timestamp travels with the message — background.js
    // persists it for the widget's live timer (no chrome.storage here).
    chrome.runtime.sendMessage({ action: 'RECORDING_PAUSED', pauseStartedAt }).catch(() => {});
  }
}

function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    isPaused = false;
    totalPausedMs += Date.now() - pauseStartedAt;
    pauseStartedAt = 0;
    chrome.runtime.sendMessage({ action: 'RECORDING_RESUMED', totalPausedMs }).catch(() => {});
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    stopReason = 'user';
    reportProgress('stop-called', 'via STOP_OFFSCREEN (user clicked Stop / shortcut)');
    mediaRecorder.stop();
  }
}
