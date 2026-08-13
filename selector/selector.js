(function () {
  // #srp-overlay only exists during the brief drag-to-select phase — once
  // a selection is made it's removed, well before the recording (and all
  // its setup: display/webcam/mic permission prompts, then the countdown)
  // actually finishes starting. That left a multi-second window where
  // nothing on the page indicated a recording was already under way, so
  // storage's isRecording flag (which only got set at the very end) could
  // still read false — letting a confused or impatient click on "Start
  // Recording" inject and run this entire script a second time in
  // parallel: two webcam bubbles, two annotate canvases, two widgets, two
  // MediaRecorders, all fighting over the same tab. data-srp-active is set
  // the instant this script starts running and lives for the whole
  // session (through setup, countdown, and recording), so a second
  // injection at any point during that window is a same-tab no-op.
  if (document.getElementById('srp-overlay') || document.body.hasAttribute('data-srp-active')) return;
  document.body.setAttribute('data-srp-active', 'true');

  // Encodes a binary chunk as base64 for chrome.runtime.sendMessage (see
  // the SAVE_RECORDING_CHUNK send site for why). Chunked iteration avoids
  // blowing the call stack on multi-MB buffers.
  function srpArrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(binary);
  }

  // Small helper so window-level listeners (drag handlers, drawing) added
  // for the life of a recording can actually be torn down when it ends,
  // instead of silently accumulating on window across repeated
  // recordings on the same tab.
  const cleanupFns = [];
  function trackListener(target, type, handler) {
    target.addEventListener(type, handler);
    const remove = () => target.removeEventListener(type, handler);
    cleanupFns.push(remove);
    return remove;
  }

  // Polls until the video element has real decodable frames (or times
  // out) instead of spinning on requestAnimationFrame — more robust when
  // frames arrive slowly, and identical behavior otherwise.
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

  // Pixel-level detector for Chrome's "Sharing this tab" indicator bar.
  // Pure function over an RGBA ImageData strip (the top STRIP rows of a
  // captured frame), split out from the video wrapper below so the
  // algorithm can be unit-tested with synthetic frames.
  //
  // candidate is the bar height in capture pixels inferred from the
  // capture geometry (extra, clamped to a sane range by the caller). The
  // check is ANCHORED to that height rather than a free-form band search:
  // a page's own dark top rows can merge with the bar into one long
  // unbroken band, which makes "find the band's bottom edge" ambiguous —
  // but we already know where the bar should end, so we verify the
  // pixels agree with that instead:
  //  1. the top `candidate` rows must be mostly (>= 60%) "bar-like";
  //  2. the 16 rows just below the candidate must be mostly (>= 50%)
  //     NOT bar-like — i.e. page content begins exactly where the bar
  //     should end.
  // A row is "bar-like" when the three sample columns (50/66/82% of the
  // width — the bar's flat middle zone, between the left text and the
  // right button) agree (spread <= 18) and the color is DARK grey
  // (luminance 12-80, max channel diff <= 18). The luminance floor
  // rejects a pure-black frame (no bar decoded yet); the ceiling and the
  // neutrality cap reject bright or tinted content (e.g. a dark-blue
  // gradient) that must never count as the bar.
  function srpBarVisibleInImageData(img, W, STRIP, candidate) {
    const xs = [0.5, 0.66, 0.82].map((f) => Math.max(1, Math.min(W - 1, Math.floor(f * W))));
    const barLike = (y) => {
      let maxD = 0;
      let lum = 0;
      let tint = 0;
      const samples = [];
      for (const x of xs) {
        const i = (y * W + x) * 4;
        samples.push([img[i], img[i + 1], img[i + 2]]);
      }
      for (let a = 0; a < samples.length; a++) {
        for (let b = a + 1; b < samples.length; b++) {
          const d = Math.max(
            Math.abs(samples[a][0] - samples[b][0]),
            Math.abs(samples[a][1] - samples[b][1]),
            Math.abs(samples[a][2] - samples[b][2])
          );
          if (d > maxD) maxD = d;
        }
        const [r, g, b] = samples[a];
        lum += 0.299 * r + 0.587 * g + 0.114 * b;
        tint = Math.max(tint, Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)));
      }
      lum /= samples.length;
      return maxD <= 18 && lum >= 12 && lum <= 80 && tint <= 18;
    };

    const inBar = Math.max(8, Math.min(candidate, STRIP - 20));
    // 1. The bar region: at least 60% bar-like rows.
    let barRows = 0;
    for (let y = 0; y < inBar; y++) if (barLike(y)) barRows++;
    if (barRows < inBar * 0.6) return false;
    // 2. Just below the bar: page content must begin (>= 50% non-bar).
    const from = inBar;
    const to = Math.min(inBar + 16, STRIP);
    let contentRows = 0;
    for (let y = from; y < to; y++) if (!barLike(y)) contentRows++;
    return contentRows / (to - from) >= 0.5;
  }

  // Wraps the detector around the first decoded frame of a tab capture:
  // draws the top STRIP rows of the video into a scratch canvas and runs
  // srpBarVisibleInImageData on them, anchored to the candidate bar
  // height. Any failure returns false so the caller (crop compensation)
  // can never be misled by an exception.
  function srpBarVisibleInFrame(video, candidate) {
    try {
      const W = video.videoWidth;
      const H = video.videoHeight;
      if (!W || !H) return false;
      const STRIP = 76;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = STRIP;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, W, Math.min(STRIP, H), 0, 0, W, STRIP);
      return srpBarVisibleInImageData(ctx.getImageData(0, 0, W, STRIP), W, STRIP, candidate);
    } catch (e) {
      return false;
    }
  }

  // Timeout-bounded wait for stream metadata — an unbounded
  // loadedmetadata await could hang setup forever if the event never
  // fires (slow pages / unusual capture sources).
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

  // Lets the background service worker reset its own recording state
  // (isRecording flag, badge) when area-mode setup aborts before the
  // recorder ever starts — otherwise a canceled recording left the badge
  // showing REC and the popup stuck on "recording in progress" forever.
  function notifyAreaRecordingStopped() {
    chrome.runtime.sendMessage({ action: 'AREA_RECORDING_STOPPED' }).catch(() => {});
  }

  // Shows the drag-to-select overlay and reports the resulting selection via
  // onSelect (or cancels via onCancel). Reusable: it runs once on injection,
  // and again mid-setup if the window changed size between the first drag and
  // the capture — the page layout moves, so the selection must be made again
  // on the live layout the video actually shows (no crop math can fix a
  // changed layout).
  function startAreaSelector(onSelect, onCancel) {
    const overlay = document.createElement('div');
    overlay.id = 'srp-overlay';

    const selectionBox = document.createElement('div');
    selectionBox.id = 'srp-box';

    const dimensions = document.createElement('div');
    dimensions.id = 'srp-dimensions';
    selectionBox.appendChild(dimensions);

    const instructions = document.createElement('div');
    instructions.id = 'srp-instructions';
    instructions.textContent = 'Click & Drag to select recording area • Esc to cancel';

    overlay.appendChild(selectionBox);
    overlay.appendChild(instructions);
    document.body.appendChild(overlay);

    let startX = 0;
    let startY = 0;

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        cleanupOverlay();
        if (onCancel) onCancel();
      }
    };

    function cleanupOverlay() {
      window.removeEventListener('keydown', keyHandler);
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    }

    window.addEventListener('keydown', keyHandler);

    overlay.addEventListener('pointerdown', (e) => {
      overlay.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      selectionBox.style.display = 'block';
      selectionBox.style.left = `${startX}px`;
      selectionBox.style.top = `${startY}px`;
      selectionBox.style.width = '0px';
      selectionBox.style.height = '0px';
    });

    overlay.addEventListener('pointermove', (e) => {
      if (e.buttons !== 1) return;
      const currentX = e.clientX;
      const currentY = e.clientY;

      const x = Math.min(startX, currentX);
      const y = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      selectionBox.style.left = `${x}px`;
      selectionBox.style.top = `${y}px`;
      selectionBox.style.width = `${width}px`;
      selectionBox.style.height = `${height}px`;

      dimensions.textContent = `${Math.round(width)} × ${Math.round(height)}px`;
    });

    overlay.addEventListener('pointerup', (e) => {
      // The recorded rectangle is built from the RAW drag coordinates
      // (pointerdown -> pointerup), NOT from selectionBox.getBoundingClientRect().
      // #srp-box is content-box with a 2px border, so its border-box rect is
      // 4px larger than the drag on each axis (border drawn outside the box);
      // cropping that rect recorded the 2px green selection border plus 2px of
      // page beyond the drag on every side — exactly the "little extra strip on
      // the side/bottom" symptom. The drag rectangle is what the user actually
      // intends, so the crop must be built from it, border excluded.
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);
      if (width < 20 || height < 20) {
        cleanupOverlay();
        if (onCancel) onCancel();
        return;
      }

      const selection = {
        x,
        y,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };

      cleanupOverlay();
      onSelect(selection);
    });

    return cleanupOverlay;
  }

  function showFatalMessage(text) {
    const msg = document.createElement('div');
    msg.id = 'srp-fatal';
    msg.textContent = text;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 4000);
  }

  function showWarning(text) {
    const msg = document.createElement('div');
    msg.id = 'srp-warning';
    msg.textContent = text;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 4000);
  }

  // Big centered 3-2-1 countdown shown right before recording actually
  // starts. The render loop is already live underneath it by the time
  // this runs, so the user gets a last look at exactly what's about to
  // be captured — crop, webcam bubble position, etc. — before the clock
  // starts. Resolves once the countdown finishes.
  function runCountdown(seconds) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.id = 'srp-countdown';
      document.body.appendChild(el);

      function show(n) {
        el.textContent = String(n);
        el.classList.remove('srp-countdown-pulse');
        void el.offsetWidth; // force reflow so the pulse animation restarts each tick
        el.classList.add('srp-countdown-pulse');
      }

      let remaining = seconds;
      show(remaining);
      const interval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(interval);
          el.remove();
          resolve();
        } else {
          show(remaining);
        }
      }, 1000);
    });
  }

  // Resets the background's recording state (badge, popup status) when the
  // pre-recording flow aborts before the recorder ever starts.
  function areaTeardown() {
    document.body.removeAttribute('data-srp-active');
    notifyAreaRecordingStopped();
  }

  // Shown when the first getDisplayMedia attempt failed with NotAllowedError
  // (usually because there was no page-level user gesture — a popup click
  // doesn't always transfer one, and the picker was never even shown). One
  // click on the page unlocks the share dialog; then the area selection
  // follows.
  function showClickToStart(onClick, onCancel) {
    const overlay = document.createElement('div');
    overlay.id = 'srp-overlay';
    const hint = document.createElement('div');
    hint.id = 'srp-click-hint';
    hint.textContent = 'Click anywhere to start sharing this tab — then select the area to record';
    overlay.appendChild(hint);
    document.body.appendChild(overlay);

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        if (onCancel) onCancel();
      }
    };
    window.addEventListener('keydown', keyHandler);

    function cleanup() {
      window.removeEventListener('keydown', keyHandler);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    overlay.addEventListener('pointerdown', () => {
      cleanup();
      onClick();
    });
  }

  // IMPORTANT: no forced width/height here. Requesting a fixed target
  // resolution (e.g. 3840x2160) that doesn't match the actual tab's aspect
  // ratio makes Chrome letterbox the real content inside that frame (shrink
  // + pad with black) to hit the requested aspect ratio. That silently
  // shifts every pixel coordinate, which is exactly what broke the crop —
  // the math below assumes the video IS the page with no padding, so it has
  // to stay a native, unscaled capture for that to hold. (The quality
  // preset below is applied to the output bitrate instead, not the capture
  // resolution.) preferCurrentTab biases Chrome's picker to default to
  // "This Tab" instead of leaving it ambiguous — picking a different
  // window/monitor here would also make the crop math meaningless since
  // it's keyed to this page's own viewport coordinates.
  async function acquireDisplayStream(config) {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser',
          cursor: config?.cursor ? 'always' : 'never',
          frameRate: { ideal: config?.fps || 60, max: 60 }
        },
        audio: config?.audioSource === 'system' || config?.audioSource === 'both',
        selfBrowserSurface: 'include',
        preferCurrentTab: true
      });
      return { stream };
    } catch (err) {
      return { error: err };
    }
  }

  // --- Flow start: share FIRST, then select ONCE ---
  // The capture starts before the area is picked, so the selection is made
  // on the exact, stable layout the video will show (after the "Sharing
  // this tab" bar is up). The old order — select, then share, then re-select
  // when the layout had moved — asked the user to drag the area twice.
  (async () => {
    try {
      const { recordConfig } = await chrome.storage.local.get('recordConfig');
      // Flip isRecording (badge, popup status) before any prompt can run, so
      // a second Start click can't inject a parallel session.
      chrome.runtime.sendMessage({ action: 'AREA_RECORDING_STARTING', mode: recordConfig?.mode }).catch(() => {});

      let acquired = await acquireDisplayStream(recordConfig || {});
      if (acquired.error && acquired.error.name === 'NotAllowedError') {
        // First attempt: NotAllowedError almost always means there was no
        // page-level user gesture (the picker never even showed). One click
        // on the page provides it, then retry. If the picker WAS shown and
        // dismissed, this just re-opens it after the click — harmless.
        const clicked = await new Promise((resolve) => {
          showClickToStart(() => resolve(true), () => resolve(false));
        });
        if (!clicked) {
          areaTeardown();
          return;
        }
        acquired = await acquireDisplayStream(recordConfig || {});
      }
      if (acquired.error || !acquired.stream) {
        showFatalMessage('Sharing was cancelled — please try again.');
        areaTeardown();
        return;
      }
      const fullStream = acquired.stream;

    const videoTrack = fullStream.getVideoTracks()[0];
    const trackSettings = videoTrack.getSettings();
    // If the user picked something other than this tab (a window or the
    // whole monitor), the viewport-based crop coordinates don't apply to
    // that stream at all. Fail loudly instead of silently recording the
    // wrong region.
    if (trackSettings.displaySurface && trackSettings.displaySurface !== 'browser') {
      fullStream.getTracks().forEach((track) => track.stop());
      showFatalMessage('Area recording needs "This Tab" selected in the share dialog — please try again and pick this tab.');
      areaTeardown();
      return;
    }

      // The layout is stable now: the ONE selection, on the live page the
      // video is actually capturing.
      startAreaSelector((selection) => {
        initiateAreaRecording(selection, recordConfig || {}, fullStream);
      }, () => {
        fullStream.getTracks().forEach((track) => track.stop());
        areaTeardown();
      });
    } catch (err) {
      // Never let an unexpected error leave data-srp-active set (which would
      // brick area recording on this tab until reload) or the badge stuck.
      showFatalMessage('Could not start area recording — please try again.');
      areaTeardown();
    }
  })();

  async function initiateAreaRecording(selection, config, fullStream) {
    let webcamStream = null;
    let micStream = null;

    // UI elements created for the life of the recording; cleaned up on stop.
    let widgetEl = null;
    let webcamBubbleEl = null;
    let annotateCanvasEl = null;
    // Full-selection pointer surface for the blur/redact tool (see the
    // blur block in the widget section). Hoisted like annotateCanvasEl so
    // the stop/catch cleanup paths can always remove it.
    let blurSurfaceEl = null;
    // Text boxes created by triple-clicking the recording area. Hoisted
    // out of the try block for the same reason as renderLoopActive below
    // — so the catch block can reach them too, in the rare case setup
    // fails after the user has already created one.
    const textBoxes = [];
    // Finished .srp-blur-stroke elements (blur/redact tool); removed on stop.
    const blurBars = [];
    let activeTextBox = null;
    // Hoisted out of the try block (rather than declared inline where the
    // render loop starts) so the catch block can also reliably stop it —
    // previously an error thrown after the loop had already started left
    // it running forever, silently drawing frames nobody would ever use.
    let renderLoopActive = false;
    // Blank-frame watchdog state (see renderFrame): consecutive
    // uniform-color samples plus a fired-once flag, so the alert appears
    // at most once per recording.
    let blankStreak = 0;
    let blankAlerted = false;
    let blankSampleFrame = 0;
    // Luminance mean of the previous sample, for the stability
    // requirement (a dead capture holds one color; real content changes).
    let blankPrevMean = null;
    // Live-caption state (config.captions): the engine transcribes the
    // mic with the Web Speech API and captionText is drawn into every
    // recorded frame by srpDrawCaptions (shared/captions.js). Hoisted so
    // the stop/catch cleanup paths can always tear the engine down.
    let captionEngine = null;
    let captionText = '';

    try {
      // Re-derive the video track + its reported settings here (the flow
      // start also reads them for the displaySurface check): the diag
      // payload, the captured-size fallback, the countdown-cancel check and
      // the onended handler all live in this function's scope.
      const videoTrack = fullStream.getVideoTracks()[0];
      const trackSettings = videoTrack.getSettings();

      // Webcam and mic are acquired from within this page's own origin
      // (a content script has no other option), which means a site
      // that disables camera/mic via a Permissions-Policy header will
      // block these — that's a real browser limitation, not a bug, so
      // failures here are treated as non-fatal: recording continues
      // without that source and the user gets a heads-up.
      if (config?.webcam) {
        try {
          webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 320 }
          });
        } catch (e) {
          showWarning('Webcam unavailable on this page — recording without it.');
        }
      }

      if (config?.audioSource === 'mic' || config?.audioSource === 'both') {
        try {
          // Echo cancellation keeps the speaker sound out of the mic;
          // browser input AGC raises quiet microphones before RNNoise. See
          // offscreen.js for the same logic. Chrome's own noiseSuppression
          // is deliberately NOT requested — RNNoise does the noise removal
          // and Chrome's built-in suppression has erased soft voices on
          // some platforms (the recording came out silent while captions
          // still heard the voice).
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
          });
        } catch (e) {
          // Some platforms reject the processing-constraint combo — fall
          // back to a plain mic so noise reduction degrades to
          // unprocessed audio, never to no mic.
          try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (e2) {
            showWarning('Microphone unavailable on this page — recording without it.');
          }
        }
      }

      // --- Live captions (burned into the recorded frames) ---
      // SpeechRecognition captures the mic itself (permission comes from
      // this page's origin, same as micStream above). The engine is
      // context-agnostic (shared/captions.js) and restarts itself across
      // silence gaps; fatal failures (mic denied / unsupported) leave the
      // recording untouched and tell the user why captions are missing.
      if (config?.captions) {
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
              if (reason === 'not-allowed' || reason === 'service-not-allowed') {
                showWarning('Microphone denied — live captions are off for this recording.');
              }
            }
          });
          // The engine lives for this recording only; stopping it is part
          // of the same cleanup that stops the mic/camera tracks.
          cleanupFns.push(() => {
            if (captionEngine) { try { captionEngine.stop(); } catch (e) {} captionEngine = null; }
            captionText = '';
          });
          captionEngine.start();
        }
      }

      const video = document.createElement('video');
      video.srcObject = fullStream;
      video.muted = true;
      video.playsInline = true;

      await waitForMetadata(video);
      video.play().catch(() => {});

      // Wait for an actual decoded frame, not just metadata, before
      // trusting videoWidth/videoHeight or drawing anything.
      await waitForVideoData(video);

      // Derive scale from the real captured dimensions and the
      // viewport size right now (re-read in case of resize/zoom
      // between the drag and the permission prompt resolving), rather
      // than a value computed before the browser ever confirmed what
      // it actually captured.
      // The crop coordinates live in the video element's INTRINSIC coordinate
      // space (that is what drawImage samples), so the scale must be derived
      // from video.videoWidth/videoHeight — NOT from trackSettings, which can
      // report a different (e.g. dpr-scaled) surface size on some setups and
      // silently scale every crop wrong.
      const capturedWidth = video.videoWidth || trackSettings.width;
      const capturedHeight = video.videoHeight || trackSettings.height;
      const liveViewportWidth = window.innerWidth;
      const liveViewportHeight = window.innerHeight;

      const scaleX = capturedWidth / liveViewportWidth;
      const scaleY = capturedHeight / liveViewportHeight;

      // --- Tab-sharing indicator compensation ---
      // The instant the capture starts, Chrome shows its "Sharing this tab
      // to …" bar at the top of the tab. On many setups that bar is part
      // of the captured video, which pushes the page content down by the
      // bar's height — so a crop computed from the pre-bar selection box
      // would record the wrong, vertically-shifted region. Detect the bar
      // from the capture geometry itself instead of guessing a constant:
      // a real tab capture is a UNIFORM scale of the page viewport, and
      // if it is taller than the live viewport predicts, the extra rows
      // at the top are the indicator bar. When present, shift the crop
      // down by exactly that many viewport pixels and map Y with the
      // uniform scale. (Non-uniform captures — window/monitor surfaces,
      // or environments without the bar — keep the original mapping, so
      // this is a no-op there and cannot regress them.)
      //
      // The uniformity threshold is deliberately loose (12%): a bar in
      // the capture skews the height ratio by B/viewportHeight — roughly
      // 7-11% depending on window height — so a tight gate would silently
      // skip the compensation exactly when it's needed. Artifacts of
      // non-tab captures are typically >14% off and stay excluded (and
      // window/monitor picks are already rejected by the displaySurface
      // check above); the bar-height clamp below rejects anything that
      // isn't a plausible bar.
      // Diagnostic-only now: the crop mapping below always uses the uniform
      // scaleX for both axes (a tab capture is always a uniform scale of the
      // page), so this flag only documents whether the height ratio agreed.
      const isUniformTabCapture =
        capturedWidth > 0 &&
        Math.abs(capturedHeight / (selection.viewportHeight || liveViewportHeight) - scaleX) < 0.12;
      // Diagnostic values (test build): the crop math below is sensitive
      // to how the user's Chrome reports the capture surface vs. the bar
      // actually being inside the video, and those two can disagree in
      // ways the E2E environment can't reproduce. Ping the exact numbers
      // back to a local listener on the user's machine so a "crop is
      // still wrong" report can be diagnosed from the real computation
      // instead of by guessing.
      let diagExtra = 0;
      let diagBarHeightPx = 0;
      let diagBarVisible = false;
      // True when the crop height had to be clamped because the selection
      // reached past the bottom of the captured page (see diag payload).
      let diagClamped = false;
      // Near-integer-safe edge snapping. Selection edges map to capture
      // pixels at values like 13.6 * 1.25 = 17.0 — but floating point can
      // deliver 17.000000000000004, and a raw Math.ceil on that silently
      // gains a whole pixel. Snapping just inside the boundary first
      // (ceil - eps, floor + eps) keeps exact-integer mappings exact.
      const snapCeil = (v) => Math.ceil(v - 1e-6);
      const snapFloor = (v) => Math.floor(v + 1e-6);

      // The tab-sharing indicator bar (if any) sits at the TOP of the
      // captured frames; infer it from the capture geometry. A real bar is
      // ~40-55px; anything outside that range is more likely a window
      // resize between the drag and the capture, which no compensation can
      // salvage.
      diagExtra = Math.round(capturedHeight / scaleX - liveViewportHeight);
      const candidate = diagExtra >= 8 && diagExtra <= 150 ? diagExtra : 0;
      // CRITICAL: only shift the crop when the bar is ACTUALLY VISIBLE in
      // the captured frames. Chrome behavior differs across builds: some
      // put the bar in the video (page content pushed down — the crop must
      // shift down by the bar height), while others count the bar's height
      // in the capture surface size but keep it out of the frames (page
      // content NOT pushed — shifting would record a region ~45px BELOW
      // the selection, the exact "my selection moved down" bug). The two
      // cases are indistinguishable from dimensions alone (both report the
      // taller capture), so sample the top of the first decoded frame and
      // verify the bar is really there before compensating.
      diagBarVisible = candidate > 0 && srpBarVisibleInFrame(video, candidate);
      // Cap the shift at a realistic bar height: Chrome's indicator is
      // ~40-55px. A larger `extra` is more likely a window resize between
      // the drag and the capture, which no amount of shifting can salvage.
      diagBarHeightPx = diagBarVisible ? Math.min(candidate, 60) : 0;

      // The selection was made AFTER the capture was live (the sharing bar
      // and the window layout are stable by then), so the crop maps the
      // selection straight onto the video — no layout re-selection needed.

      // --- Crop mapping ---
      // A browser tab capture is ALWAYS a uniform scale of the page: the
      // video is the page viewport scaled by scaleX on BOTH axes. The raw
      // height ratio (capturedHeight / liveViewportHeight) can diverge from
      // scaleX when the window resizes or enters fullscreen between the
      // drag and the capture — using that ratio as a separate Y scale
      // silently STRETCHED the crop vertically (the user's recordings came
      // out ~21% taller than the selection, adding a strip of unwanted
      // content at the bottom). Height mismatches are handled by clamping
      // to the captured page extent, never by rescaling Y.
      const cropLeft = snapCeil(selection.x * scaleX);
      const cropRight = snapFloor((selection.x + selection.width) * scaleX);
      const cropX = cropLeft;
      const cropWidth = Math.max(1, cropRight - cropLeft);

      // The page inside the video starts below the bar when one was
      // detected; selection.y is in the pre-bar viewport space, so the bar
      // height is added to the Y offset before scaling.
      const pageBottomCss = capturedHeight / scaleX - diagBarHeightPx;
      const availH = Math.max(0, pageBottomCss - selection.y);
      diagClamped = selection.height > availH + 0.5;
      const hCss = Math.min(selection.height, availH);
      const cropTop = snapCeil((selection.y + diagBarHeightPx) * scaleX);
      const cropBottom = snapFloor((selection.y + diagBarHeightPx + hCss) * scaleX);
      const cropY = cropTop;
      const cropHeight = Math.max(1, cropBottom - cropTop);

      // Diagnostic: does the video's page content reach the bottom of the
      // capture, or is the bottom a uniform (empty) strip? An empty strip
      // means the page is top-aligned and the crop above is correct even
      // when the capture is much taller than the viewport; content at the
      // bottom means the page reflowed (window resized mid-setup), so no
      // crop can match the selection and the user should be warned instead.
      let diagBottomUniform = null;
      try {
        const vW = video.videoWidth;
        const vH = video.videoHeight;
        if (vW && vH) {
          const stripH = Math.min(40, vH);
          const c = document.createElement('canvas');
          c.width = vW;
          c.height = stripH;
          const bctx = c.getContext('2d', { willReadFrequently: true });
          bctx.drawImage(video, 0, vH - stripH, vW, stripH, 0, 0, vW, stripH);
          const img = bctx.getImageData(0, 0, vW, stripH);
          const xs = [0.5, 0.66, 0.82].map((f) => Math.max(1, Math.min(vW - 1, Math.floor(f * vW))));
          let contentRows = 0;
          for (let y = 0; y < stripH; y++) {
            let spread = 0;
            let lum = 0;
            const samples = [];
            for (const x of xs) {
              const i = (y * vW + x) * 4;
              samples.push([img[i], img[i + 1], img[i + 2]]);
            }
            for (let a = 0; a < samples.length; a++) {
              for (let b = a + 1; b < samples.length; b++) {
                const d = Math.max(
                  Math.abs(samples[a][0] - samples[b][0]),
                  Math.abs(samples[a][1] - samples[b][1]),
                  Math.abs(samples[a][2] - samples[b][2])
                );
                if (d > spread) spread = d;
              }
              const [r, g, bl] = samples[a];
              lum += 0.299 * r + 0.587 * g + 0.114 * bl;
            }
            lum /= samples.length;
            if (spread > 20 || lum > 100) contentRows++;
          }
          diagBottomUniform = contentRows / stripH < 0.25;
        }
      } catch (e) {
        // Diagnostics must never be able to affect the recording.
      }

      // --- Area-mode crop diagnostics (test instrumentation) ---
      try {
        chrome.runtime.sendMessage({
          action: 'SRP_DIAG',
          data: {
            version: '2.9.0',
            selection,
            liveViewport: { w: liveViewportWidth, h: liveViewportHeight },
            captured: { w: capturedWidth, h: capturedHeight },
            video: { w: video.videoWidth, h: video.videoHeight },
            track: {
              w: trackSettings.width,
              h: trackSettings.height,
              ds: trackSettings.displaySurface,
              frameRate: trackSettings.frameRate
            },
            scaleX,
            scaleY,
            isUniformTabCapture,
            extra: diagExtra,
            barVisible: diagBarVisible,
            barHeightPx: diagBarHeightPx,
            clamped: diagClamped,
            bottomUniform: diagBottomUniform,
            crop: { x: cropX, y: cropY, w: cropWidth, h: cropHeight },
            dpr: window.devicePixelRatio || 1,
            screen: { w: screen.width, h: screen.height },
            vvScale: (window.visualViewport && window.visualViewport.scale) || 1,
            url: location.hostname
          }
        }).catch(() => {});
      } catch (e) {
        // Diagnostics must never be able to affect the recording.
      }

      // Round the canvas down to the container's alignment unit — 16
      // for H.264/MP4 (Chrome pads to 16x16 macroblock boundaries and
      // the MP4 doesn't crop the padding, which plays back as the
      // duplicated bottom strip), 2 for VP8/VP9/WebM (cropped
      // correctly). Loses at most unit-1 pixels, never visible.
      // qualityPresets.js is always injected before this file; guard
      // anyway for harnesses that omit it.
      const alignUnit = (typeof srpAlignUnit === 'function' && typeof srpPickMimeType === 'function')
        ? srpAlignUnit(srpPickMimeType(null, config?.outputFormat === 'webm'))
        : 2;
      const canvas = document.createElement('canvas');
      canvas.width = cropWidth - (cropWidth % alignUnit);
      canvas.height = cropHeight - (cropHeight % alignUnit);

      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // ---------- Webcam bubble (draggable, area mode only) ----------
      if (webcamStream) {
        webcamBubbleEl = document.createElement('div');
        webcamBubbleEl.id = 'srp-webcam-bubble';
        // Circle by default; a rounded rectangle when chosen in the
        // popup. The bubble is a real page element in area mode, so the
        // shape is pure CSS on that element (selector.css).
        if (config?.webcamShape === 'rounded') {
          webcamBubbleEl.classList.add('srp-bubble-rounded');
        }
        const bubbleVideo = document.createElement('video');
        bubbleVideo.srcObject = webcamStream;
        bubbleVideo.muted = true;
        bubbleVideo.autoplay = true;
        bubbleVideo.playsInline = true;
        webcamBubbleEl.appendChild(bubbleVideo);
        document.body.appendChild(webcamBubbleEl);

        const bubbleSize = 130;
        const corner = config?.webcamPosition || 'bottom-right';
        const initial = {
          'bottom-right': [selection.x + selection.width - bubbleSize - 10, selection.y + selection.height - bubbleSize - 10],
          'bottom-left': [selection.x + 10, selection.y + selection.height - bubbleSize - 10],
          'top-right': [selection.x + selection.width - bubbleSize - 10, selection.y + 10],
          'top-left': [selection.x + 10, selection.y + 10]
        }[corner] || [selection.x + selection.width - bubbleSize - 10, selection.y + selection.height - bubbleSize - 10];

        webcamBubbleEl.style.left = `${Math.max(0, Math.min(initial[0], window.innerWidth - bubbleSize))}px`;
        webcamBubbleEl.style.top = `${Math.max(0, Math.min(initial[1], window.innerHeight - bubbleSize))}px`;

        // Free-drag anywhere on the page. Dragging it outside the
        // selection box just means it won't appear in the recording,
        // since only pixels inside the box get drawn onto the canvas.
        //
        // Pointer events + setPointerCapture rather than mouse events +
        // window-level listeners: capturing the pointer means this
        // element keeps receiving move/up events for that specific
        // pointer even once the cursor leaves it, with no window
        // listener needed at all — and tracking the exact pointerId
        // means a second, redundant pointer (some touchscreens/styluses
        // fire both a genuine pointer event and a synthetic
        // compatibility one for the same physical motion) can't also
        // drive the same drag.
        let dragging = false;
        let dragPointerId = null;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        webcamBubbleEl.addEventListener('pointerdown', (e) => {
          if (dragging) return;
          dragging = true;
          dragPointerId = e.pointerId;
          webcamBubbleEl.setPointerCapture(e.pointerId);
          webcamBubbleEl.classList.add('srp-dragging');
          const rect = webcamBubbleEl.getBoundingClientRect();
          dragOffsetX = e.clientX - rect.left;
          dragOffsetY = e.clientY - rect.top;
          e.preventDefault();
        });
        webcamBubbleEl.addEventListener('pointermove', (e) => {
          if (!dragging || e.pointerId !== dragPointerId) return;
          webcamBubbleEl.style.left = `${e.clientX - dragOffsetX}px`;
          webcamBubbleEl.style.top = `${e.clientY - dragOffsetY}px`;
        });
        const endBubbleDrag = (e) => {
          if (e.pointerId !== dragPointerId) return;
          dragging = false;
          dragPointerId = null;
          webcamBubbleEl.classList.remove('srp-dragging');
        };
        webcamBubbleEl.addEventListener('pointerup', endBubbleDrag);
        webcamBubbleEl.addEventListener('pointercancel', endBubbleDrag);
      }

      // ---------- Annotation drawing layer (area mode only) ----------
      let annCtx = null;
      // The active drawing tool: null (off) or 'pen' | 'rect' | 'circle' |
      // 'arrow' | 'highlight'. Text is placed with a click (its own
      // button), not a drag, so it's not a tool state.
      let activeTool = null;
      let currentColor = '#ef4444';
      let lineWidth = 4;
      const COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#ffffff'];
      // Committed annotation actions (undo/redo). Text boxes are tracked
      // here too so Undo can remove them.
      const actions = [];
      const redoStack = [];
      // "Remember last settings": drawing prefs persisted from the last
      // recording (tool, color, line width, blur style) — see
      // saveDrawPrefs below.
      const { drawPrefs } = await chrome.storage.local.get('drawPrefs');

      if (config?.annotate) {
        annotateCanvasEl = document.createElement('canvas');
        annotateCanvasEl.id = 'srp-annotate-canvas';
        annotateCanvasEl.style.left = `${selection.x}px`;
        annotateCanvasEl.style.top = `${selection.y}px`;
        annotateCanvasEl.style.width = `${selection.width}px`;
        annotateCanvasEl.style.height = `${selection.height}px`;
        // Backing store sized in CSS pixels (not devicePixelRatio-scaled) —
        // a deliberate trade-off to keep the crop math simple; strokes are
        // still scaled up cleanly onto the final canvas since drawImage
        // scales automatically.
        annotateCanvasEl.width = Math.round(selection.width);
        annotateCanvasEl.height = Math.round(selection.height);
        document.body.appendChild(annotateCanvasEl);

        annCtx = annotateCanvasEl.getContext('2d');
        annCtx.lineJoin = 'round';
        annCtx.lineCap = 'round';
        // Remembered prefs: apply the last-used color/width, and the tool
        // itself is restored at the end of this block (once the toolbar
        // buttons exist to reflect it).
        currentColor = drawPrefs?.color || currentColor;
        lineWidth = drawPrefs?.lineWidth || 4;

        // ----- Live drawing state -----
        let drawing = false;
        let drawPointerId = null;
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastY = 0;
        let liveAction = null;

        const pointerPos = (e) => {
          const rect = annotateCanvasEl.getBoundingClientRect();
          return [e.clientX - rect.left, e.clientY - rect.top];
        };

        // Draws one committed (or in-progress) action onto the annotate
        // canvas. The canvas is a real page element captured by
        // getDisplayMedia, so everything drawn here appears in the
        // recording automatically.
        function drawAction(a) {
          if (!a) return;
          const c = annCtx;
          c.save();
          if (a.type === 'pen' || a.type === 'highlight') {
            c.strokeStyle = a.color;
            c.lineWidth = a.width;
            if (a.type === 'highlight') c.globalAlpha = 0.45;
            c.lineJoin = 'round';
            c.lineCap = 'round';
            if (a.pts.length === 1) {
              // A click-without-drag still draws a visible dot.
              c.fillStyle = a.color;
              c.beginPath();
              c.arc(a.pts[0][0], a.pts[0][1], a.width / 2, 0, Math.PI * 2);
              c.fill();
              c.restore();
              return;
            }
            c.beginPath();
            a.pts.forEach((p, i) => (i === 0 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1])));
            c.stroke();
          } else if (a.type === 'rect') {
            c.strokeStyle = a.color;
            c.lineWidth = a.width;
            c.strokeRect(a.x, a.y, a.w, a.h);
          } else if (a.type === 'circle') {
            c.strokeStyle = a.color;
            c.lineWidth = a.width;
            c.beginPath();
            c.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
            c.stroke();
          } else if (a.type === 'arrow') {
            c.strokeStyle = a.color;
            c.lineWidth = a.width;
            c.lineCap = 'round';
            c.beginPath();
            c.moveTo(a.x1, a.y1);
            c.lineTo(a.x2, a.y2);
            c.stroke();
            // Arrowhead: two short lines back from the tip at ~±25°.
            const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
            const head = Math.max(10, a.width * 3);
            c.beginPath();
            c.moveTo(a.x2, a.y2);
            c.lineTo(a.x2 - head * Math.cos(ang - 0.44), a.y2 - head * Math.sin(ang - 0.44));
            c.moveTo(a.x2, a.y2);
            c.lineTo(a.x2 - head * Math.cos(ang + 0.44), a.y2 - head * Math.sin(ang + 0.44));
            c.stroke();
          }
          c.restore();
        }

        // Replays the whole annotate layer (committed actions + the live
        // in-progress shape). Undo/redo simply pop/push the action list
        // and re-render — no canvas surgery needed.
        function renderAll() {
          if (!annCtx) return;
          annCtx.clearRect(0, 0, annotateCanvasEl.width, annotateCanvasEl.height);
          for (const a of actions) drawAction(a);
          if (liveAction) drawAction(liveAction);
        }

        // Builds/updates the in-progress shape from a drag.
        function updateLiveAction(tool, x0, y0, x1, y1) {
          if (tool === 'pen' || tool === 'highlight') {
            if (!liveAction) {
              liveAction = {
                type: tool,
                color: currentColor,
                width: tool === 'highlight' ? Math.max(18, lineWidth * 4) : lineWidth,
                pts: [[x0, y0]]
              };
            } else {
              liveAction.pts.push([x1, y1]);
            }
          } else {
            if (tool === 'rect' || tool === 'circle') {
              liveAction = {
                type: tool,
                color: currentColor,
                width: Math.max(2, lineWidth),
                x: Math.min(x0, x1),
                y: Math.min(y0, y1),
                w: Math.abs(x1 - x0),
                h: Math.abs(y1 - y0)
              };
            } else if (tool === 'arrow') {
              liveAction = {
                type: 'arrow',
                color: currentColor,
                width: Math.max(2, lineWidth),
                x1: x0,
                y1: y0,
                x2: x1,
                y2: y1
              };
            }
          }
        }

        annotateCanvasEl.addEventListener('pointerdown', (e) => {
          if (!activeTool || drawing) return;
          drawing = true;
          drawPointerId = e.pointerId;
          annotateCanvasEl.setPointerCapture(e.pointerId);
          [startX, startY] = pointerPos(e);
          lastX = startX;
          lastY = startY;
          liveAction = null;
          updateLiveAction(activeTool, startX, startY, startX, startY);
          e.preventDefault();
        });
        annotateCanvasEl.addEventListener('pointermove', (e) => {
          if (!drawing || e.pointerId !== drawPointerId) return;
          const [x, y] = pointerPos(e);
          // Skip sub-pixel jitter so pen/highlight point lists stay small.
          if (Math.abs(x - lastX) < 1 && Math.abs(y - lastY) < 1) return;
          lastX = x;
          lastY = y;
          updateLiveAction(activeTool, startX, startY, x, y);
          renderAll();
        });
        const endStroke = (e) => {
          if (e.pointerId !== drawPointerId) return;
          drawing = false;
          drawPointerId = null;
          if (liveAction && activeTool) {
            // A click-without-drag still counts for pen (a dot); shapes
            // need a real size, so a tiny drag is dropped.
            const tiny = (a) => (
              ((a.type === 'rect' || a.type === 'circle') && a.w < 2 && a.h < 2) ||
              (a.type === 'arrow' && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 2)
            );
            if (!tiny(liveAction)) {
              actions.push(liveAction);
              redoStack.length = 0;
              saveDrawPrefs();
            }
          }
          liveAction = null;
          renderAll();
        };
        annotateCanvasEl.addEventListener('pointerup', endStroke);
        annotateCanvasEl.addEventListener('pointercancel', endStroke);

        // ---------- Triple-click to add draggable, colorable text ----------
        // A native triple-click already reports itself via event.detail
        // === 3 on the third 'click' in quick succession, so no manual
        // tap-counting/timing is needed. This listens on window (not the
        // annotate canvas itself) so it works regardless of whether draw
        // mode happens to be toggled on — adding a caption shouldn't
        // require first switching to the pencil.
        function isInsideSelection(x, y) {
          return x >= selection.x && x <= selection.x + selection.width &&
                 y >= selection.y && y <= selection.y + selection.height;
        }

        function createTextBox(pageX, pageY, recordAction = true) {
          const wrap = document.createElement('div');
          wrap.className = 'srp-text-box';
          wrap.style.left = `${pageX}px`;
          wrap.style.top = `${pageY}px`;

          const handle = document.createElement('span');
          handle.className = 'srp-text-drag-handle';
          handle.textContent = '⋮⋮';
          handle.title = 'Drag to move';

          const editable = document.createElement('div');
          editable.className = 'srp-text-editable';
          editable.contentEditable = 'true';
          editable.setAttribute('data-placeholder', 'Type, then click outside…');
          // Reuses the same color state as the pencil tool, so picking a
          // swatch while this box is active recolors it (see the swatch
          // click handler further down).
          editable.style.setProperty('color', currentColor, 'important');

          const delBtn = document.createElement('button');
          delBtn.className = 'srp-text-delete';
          delBtn.textContent = '✕';
          delBtn.title = 'Delete text';

          wrap.appendChild(handle);
          wrap.appendChild(editable);
          wrap.appendChild(delBtn);
          document.body.appendChild(wrap);

          const box = { el: editable, wrap, color: currentColor, fontSize: 22 };
          textBoxes.push(box);
          activeTextBox = box;
          // Track creation in the undo/redo history (Redo passes
          // recordAction=false and pushes the restored action itself).
          if (recordAction) {
            actions.push({ type: 'text', box });
            redoStack.length = 0;
            saveDrawPrefs();
          }

          function removeBox() {
            wrap.remove();
            const idx = textBoxes.indexOf(box);
            if (idx !== -1) textBoxes.splice(idx, 1);
            if (activeTextBox === box) activeTextBox = null;
          }

          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeBox();
          });

          editable.addEventListener('focus', () => {
            activeTextBox = box;
          });

          // Single-line by design: Enter finishes editing (rather than
          // inserting a line break) so canvas rendering never has to deal
          // with contenteditable's inconsistent-across-browsers handling
          // of multi-line content.
          editable.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              editable.blur();
            } else if (e.key === 'Escape') {
              editable.blur();
            }
          });

          // An empty box left behind (triple-clicked, then clicked away
          // without typing anything) would just be clutter on the
          // recording — remove it rather than keep it around.
          editable.addEventListener('blur', () => {
            if (!editable.textContent.trim()) removeBox();
          });

          let textDragging = false;
          let textDragPointerId = null;
          let textDragOffsetX = 0;
          let textDragOffsetY = 0;
          handle.addEventListener('pointerdown', (e) => {
            if (textDragging) return;
            textDragging = true;
            textDragPointerId = e.pointerId;
            handle.setPointerCapture(e.pointerId);
            const rect = wrap.getBoundingClientRect();
            textDragOffsetX = e.clientX - rect.left;
            textDragOffsetY = e.clientY - rect.top;
            e.preventDefault();
          });
          handle.addEventListener('pointermove', (e) => {
            if (!textDragging || e.pointerId !== textDragPointerId) return;
            wrap.style.left = `${e.clientX - textDragOffsetX}px`;
            wrap.style.top = `${e.clientY - textDragOffsetY}px`;
          });
          const endTextDrag = (e) => {
            if (e.pointerId !== textDragPointerId) return;
            textDragging = false;
            textDragPointerId = null;
          };
          handle.addEventListener('pointerup', endTextDrag);
          handle.addEventListener('pointercancel', endTextDrag);

          editable.focus();
          return box;
        }

        // ---------- Undo / Redo ----------
        // Undo pops the last action and re-renders the canvas from the
        // remaining list. Text boxes are DOM elements, so undoing one
        // snapshots its content + position, removes it, and lets Redo
        // rebuild it.
        function undoLast() {
          const a = actions.pop();
          if (!a) return;
          if (a.type === 'text' && a.box) {
            a.saved = {
              x: parseFloat(a.box.wrap.style.left) || 0,
              y: parseFloat(a.box.wrap.style.top) || 0,
              text: a.box.el.textContent || '',
              color: a.box.color
            };
            const idx = textBoxes.indexOf(a.box);
            if (idx !== -1) textBoxes.splice(idx, 1);
            if (activeTextBox === a.box) activeTextBox = null;
            a.box.wrap.remove();
          }
          redoStack.push(a);
          renderAll();
          saveDrawPrefs();
        }

        function redoLast() {
          const a = redoStack.pop();
          if (!a) return;
          if (a.type === 'text') {
            const s = a.saved || {};
            const box = createTextBox(
              typeof s.x === 'number' ? s.x : selection.x + selection.width / 2,
              typeof s.y === 'number' ? s.y : selection.y + selection.height / 2,
              false
            );
            box.el.textContent = s.text || '';
            box.color = s.color || currentColor;
            box.el.style.setProperty('color', box.color, 'important');
            a.box = box;
            a.saved = null;
            actions.push(a);
          } else {
            actions.push(a);
            renderAll();
          }
          saveDrawPrefs();
        }

        trackListener(window, 'click', (e) => {
          if (e.detail !== 3) return;
          if (activeTool) return;
          if (!isInsideSelection(e.clientX, e.clientY)) return;
          if (e.target.closest && e.target.closest('.srp-text-box, #srp-webcam-bubble, #srp-widget, .srp-blur-surface, .srp-blur-stroke')) return;
          // Triple-clicking normally selects a paragraph of page text —
          // clear that out so it doesn't sit highlighted underneath the
          // new text box.
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
          createTextBox(e.clientX, e.clientY);
        });
      }

      renderLoopActive = true;

      // Watchdog readback scratch: a tiny canvas whose context is created
      // with willReadFrequently so the blank-frame watchdog can sample
      // pixels without repeatedly calling getImageData on the recording
      // context (which triggers Chrome's Canvas2D readback warning and can
      // interfere with its GPU/desync path).
      const watchScratch = document.createElement('canvas');
      watchScratch.width = 48;
      watchScratch.height = 48;
      const watchScratchCtx = watchScratch.getContext('2d', { willReadFrequently: true });

      function renderFrame() {
        if (!renderLoopActive) return;
        // Defensive reset: guarantees no stale content (e.g. a webcam
        // bubble mid-drag) can persist into a frame where, for whatever
        // reason, the video draw below doesn't end up covering the full
        // canvas. With alpha:false this fills opaque black rather than
        // clearing to transparent, which is fine — it's immediately
        // overdrawn by the video frame in the ordinary case.
        // IMPORTANT: only the captured video is drawn here. The
        // annotation strokes (#srp-annotate-canvas), the text boxes
        // (.srp-text-box) and the webcam bubble are all real DOM
        // elements on the page, and getDisplayMedia captures the whole
        // rendered tab — so every one of them is ALREADY in the video
        // frames being drawn below. Redrawing any of them on the canvas
        // produced a second, offset copy in the recording (the captured
        // element and the canvas draw rendered from different frame
        // sources at slightly different positions/times), which is
        // exactly the "drawing appears two times" bug. The single
        // on-page copy is the recording's copy.
        ctx.clearRect(0, 0, cropWidth, cropHeight);
        if (video.readyState >= video.HAVE_CURRENT_DATA) {
          ctx.drawImage(
            video,
            cropX, cropY, cropWidth, cropHeight,
            0, 0, cropWidth, cropHeight
          );
        }
        // Live captions: burned on top of the frame (canvas.width/height
        // are the real backing-store dims — cropWidth/cropHeight are the
        // pre-alignment selection size). The annotation strokes, text
        // boxes and webcam bubble above are real page DOM captured by
        // getDisplayMedia, so they need no canvas draw; the caption text
        // is NOT page DOM (it lives only in this content script), so it
        // must be painted here.
        if (captionText && typeof srpDrawCaptions === 'function') {
          srpDrawCaptions(ctx, canvas.width, canvas.height, captionText, { size: config?.captionsSize || 'medium' });
        }

        // --- Blank-frame watchdog (blue-screen detection) ---
        // Same idea as offscreen.js: Chrome's hardware-accelerated video
        // decode can render fullscreen video through a GPU overlay that
        // screen capture can't see, producing solid-blue frames. Sample a
        // small center region every ~2s (a full-resolution getImageData on
        // a large canvas every frame would be far too slow); near-zero
        // color variance means the capture is stuck on one color, so tell
        // the user the cause + fix live instead of after the fact.
        //
        // The whole block is deliberately defensive (try/catch, typeof
        // checks, and a guard on recordStartTime which is a let binding
        // initialized later in this function): it runs BEFORE the
        // requestAnimationFrame below, so any uncaught error here would
        // skip the next frame and freeze the recording. The watchdog must
        // never be able to affect the recording itself.
        blankSampleFrame += 1;
        try {
          if (
            blankSampleFrame % 120 === 0 &&
            mediaRecorder && mediaRecorder.state === 'recording' &&
            !blankAlerted &&
            recordStartTime && Date.now() - recordStartTime > 5000 &&
            typeof srpFrameStats === 'function'
          ) {
            const s = 48;
            const sx = Math.max(0, Math.floor((cropWidth - s) / 2));
            const sy = Math.max(0, Math.floor((cropHeight - s) / 2));
            // Copy the sample region into the tiny scratch canvas and
            // read THAT — the recording context itself is never read
            // back. drawImage from the desynchronized context is gentler
            // than getImageData, and any failure degrades the same way
            // (srpFrameStats returns null → sample skipped) as the old
            // direct readback did.
            watchScratchCtx.clearRect(0, 0, s, s);
            watchScratchCtx.drawImage(canvas, sx, sy, s, s, 0, 0, s, s);
            const stats = srpFrameStats(watchScratchCtx, 0, 0, s, s);
            if (stats) {
              // Uniform AND not legitimately black/white content AND the
              // same color as the previous sample (a dead capture holds
              // one color for seconds; real content changes).
              const stable = blankPrevMean === null || Math.abs(stats.mean - blankPrevMean) < 3;
              blankPrevMean = stats.mean;
              blankStreak = (
                stats.variance < SRP_BLANK_VARIANCE &&
                stats.mean > SRP_BLANK_MIN_MEAN &&
                stats.mean < SRP_BLANK_MAX_MEAN &&
                stable
              ) ? blankStreak + 1 : 0;
              if (blankStreak >= 4) {
                blankAlerted = true;
                chrome.runtime.sendMessage({ action: 'BLANK_CAPTURE_DETECTED' }).catch(() => {});
              }
            }
          }
        } catch (e) {
          // Never let the watchdog interfere with recording.
        }

        requestAnimationFrame(renderFrame);
      }
      renderFrame();

      const croppedStream = canvas.captureStream(config?.fps || 60);

      const systemAudioTrack = fullStream.getAudioTracks()[0] || null;
      // Same system-audio-missing warning as offscreen.js: Chrome only
      // shares this tab's audio if "Share tab audio" was ticked in the
      // picker — say so instead of the recording silently having no sound.
      if ((config?.audioSource === 'system' || config?.audioSource === 'both') && !systemAudioTrack) {
        chrome.runtime.sendMessage({ action: 'SYSTEM_AUDIO_MISSING', surface: 'browser' }).catch(() => {});
      }
      const micTrack = micStream ? micStream.getAudioTracks()[0] : null;
      const mixedAudioTrack = (typeof srpMixAudioTracks === 'function')
        ? srpMixAudioTracks([systemAudioTrack, micTrack], {
            noiseReduction: config?.noiseReduction,
            noiseGate: config?.noiseGate,
            micTrack
          })
        : systemAudioTrack;
      if (mixedAudioTrack) {
        croppedStream.addTrack(mixedAudioTrack);
      }

      const bitrate = (typeof srpScaledBitrate === 'function')
        ? srpScaledBitrate(config?.quality, cropWidth, cropHeight)
        : 8000000;
      // MP4 (H.264) preferred, WebM fallback — see srpPickMimeType() in
      // qualityPresets.js (qualityPresets.js is always injected before
      // this file). The mime actually used is captured so the blobs,
      // filenames, history entries and recovery checkpoints below all
      // match the container that was really recorded.
      const recorderInfo = srpCreateMediaRecorder(croppedStream, bitrate, null, config?.outputFormat === 'webm');
      const mediaRecorder = recorderInfo.recorder;
      const recorderMime = recorderInfo.mimeType;
      const chunks = [];
      // Snapshot the actual mode so the download name + history entry
      // below are labeled right (area vs. the new full-tab mode).
      const savedMode = (config && config.mode) || 'area';

      // Tutorial effects (click ripples) — real page DOM so they're
      // inside the recorded crop. No-op when the toggle is off;
      // idempotent on reinject. The ripple styles are injected by
      // effects.js itself (screen mode never loads selector.css).
      if (typeof SRPEffects !== 'undefined' && typeof SRPEffects.start === 'function') {
        SRPEffects.start({ clickEffects: config?.clickEffects !== false });
      }

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      if (config?.countdown) {
        await runCountdown(3);
        // The capture stream lags the live tab by a frame or two: the "1"
        // digit is still being delivered to the video element right after
        // the countdown element is removed, so starting the recorder at
        // once would bake that stale frame into the first moments of the
        // footage. Give the stream a moment to deliver a clean frame.
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (videoTrack.readyState === 'ended') {
          // The user clicked "Stop sharing" on Chrome's own indicator (or
          // the track otherwise ended) during the countdown, before
          // recording ever actually began — clean up and bail rather than
          // starting a recorder on a dead track.
          renderLoopActive = false;
          cleanupFns.forEach((fn) => fn());
          cleanupFns.length = 0;
          if (typeof SRPEffects !== 'undefined' && typeof SRPEffects.stop === 'function') SRPEffects.stop();
          fullStream.getTracks().forEach((track) => track.stop());
          if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
          if (micStream) micStream.getTracks().forEach((track) => track.stop());
          [webcamBubbleEl, annotateCanvasEl, blurSurfaceEl].forEach((el) => {
            if (el && el.parentNode) el.parentNode.removeChild(el);
          });
          textBoxes.forEach((box) => box.wrap.remove());
          blurBars.forEach((bar) => bar.remove());
          blurBars.length = 0;
          document.body.removeAttribute('data-srp-active');
          notifyAreaRecordingStopped();
          return;
        }
      }

      // ---------- Floating control widget ----------
      widgetEl = document.createElement('div');
      widgetEl.id = 'srp-widget';
      widgetEl.innerHTML = `
        <span class="srp-drag-handle">⋮⋮</span>
        <span id="srp-dot"></span>
        <span id="srp-timer">00:00</span>
        <button id="srp-btn-pause" title="Pause / Resume">⏸</button>
        <button id="srp-btn-shot" title="Screenshot">📷</button>
        ${config?.annotate ? `
        <span class="srp-tool-divider"></span>
        <button id="srp-btn-pen" class="srp-tool-btn" title="Pen">✏️</button>
        <button id="srp-btn-rect" class="srp-tool-btn" title="Rectangle">⬜</button>
        <button id="srp-btn-circle" class="srp-tool-btn" title="Circle">⭕</button>
        <button id="srp-btn-arrow" class="srp-tool-btn" title="Arrow">➡</button>
        <button id="srp-btn-text" class="srp-tool-btn" title="Add text">📝</button>
        <button id="srp-btn-highlight" class="srp-tool-btn" title="Highlight">🟨</button>
        <button id="srp-btn-blur" class="srp-tool-btn" title="Blur / hide content">B</button>
        <span class="srp-tool-divider"></span>
        <button id="srp-btn-undo" title="Undo">↶</button>
        <button id="srp-btn-redo" title="Redo">↷</button>
        <button id="srp-btn-clear" title="Clear all annotations">🗑</button>` : ''}
        <button id="srp-btn-stop" title="Stop recording">■</button>
        <button id="srp-btn-collapse" title="Collapse toolbar">⟩</button>
      `;
      document.body.appendChild(widgetEl);

      if (config?.annotate) {
        // ----- Color row (swatches + native picker) -----
        const colorRow = document.createElement('div');
        colorRow.className = 'srp-color-row';
        colorRow.style.setProperty('display', 'none', 'important');
        // 🎨 palette button: opens the in-page custom color picker (see
        // the picker block further down) and carries a small dot in its
        // corner showing the currently chosen color.
        const paletteBtn = document.createElement('button');
        paletteBtn.className = 'srp-color-palette';
        paletteBtn.textContent = '🎨';
        paletteBtn.title = 'Pick any color';
        const paletteDot = document.createElement('span');
        paletteDot.className = 'srp-color-palette-dot';
        paletteDot.style.setProperty('background', currentColor, 'important');
        paletteBtn.appendChild(paletteDot);
        colorRow.appendChild(paletteBtn);

        COLORS.forEach((color) => {
          const swatch = document.createElement('button');
          swatch.className = 'srp-swatch' + (color === currentColor ? ' srp-active' : '');
          // setProperty(..., 'important') matters here too: #srp-widget
          // button sets background !important (so widget buttons stay
          // legible regardless of host-page CSS), which was silently
          // beating a plain inline background assignment — every swatch
          // rendered as that same dark button color instead of its own
          // color, making them visually indistinguishable.
          swatch.style.setProperty('background', color, 'important');
          // A small pencil glyph (whitened via CSS filter) on every chip
          // so the row reads as "drawing/text color" — the white swatch
          // gets a dark glyph so it stays visible.
          const swatchIcon = document.createElement('span');
          swatchIcon.className = 'srp-swatch-icon' + (color === '#ffffff' ? ' srp-swatch-icon-dark' : '');
          swatchIcon.textContent = '✏️';
          swatch.appendChild(swatchIcon);
          swatch.addEventListener('click', () => {
            currentColor = color;
            paletteDot.style.setProperty('background', color, 'important');
            colorRow.querySelectorAll('.srp-swatch').forEach((s) => s.classList.remove('srp-active'));
            swatch.classList.add('srp-active');
            if (activeTextBox) {
              activeTextBox.color = color;
              activeTextBox.el.style.setProperty('color', color, 'important');
            }
            saveDrawPrefs();
          });
          colorRow.appendChild(swatch);
        });
        widgetEl.appendChild(colorRow);

        // ---------- In-page custom color picker ----------
        // Clicking 🎨 opens a full in-page color dialog (styled after the
        // native one — SV field, hue slider, RGB sliders, hex input,
        // old/new preview, Ok/Cancel, recently-used + standard palettes)
        // instead of Chrome's native picker, so it looks and behaves
        // identically on every machine. Color math stays in HSV; RGB and
        // hex are derived from it.
        const picker = document.createElement('div');
        picker.className = 'srp-color-picker';
        picker.innerHTML = `
          <div class="srp-cp-head">
            <span>Custom color</span>
            <button type="button" class="srp-cp-close" title="Close">✕</button>
          </div>
          <div class="srp-cp-main">
            <div class="srp-cp-sv" title="Drag to set saturation / brightness"><div class="srp-cp-marker"></div></div>
            <div class="srp-cp-hue" title="Hue"><div class="srp-cp-hue-marker"></div></div>
          </div>
          <div class="srp-cp-rgb">
            <label><span>R</span><input type="range" min="0" max="255" data-ch="r"><b data-v="r"></b></label>
            <label><span>G</span><input type="range" min="0" max="255" data-ch="g"><b data-v="g"></b></label>
            <label><span>B</span><input type="range" min="0" max="255" data-ch="b"><b data-v="b"></b></label>
          </div>
          <div class="srp-cp-hex"><span>#</span><input type="text" maxlength="7" spellcheck="false" autocomplete="off" title="Hex color"></div>
          <div class="srp-cp-foot">
            <div class="srp-cp-preview"><i class="srp-cp-prev-old"></i><i class="srp-cp-prev-new"></i></div>
            <div class="srp-cp-actions">
              <button type="button" class="srp-cp-cancel">Cancel</button>
              <button type="button" class="srp-cp-ok">Ok</button>
            </div>
          </div>
          <div class="srp-cp-recent">
            <span class="srp-cp-label">Recently used</span>
            <div class="srp-cp-chips" data-recent></div>
          </div>
          <div class="srp-cp-std">
            <span class="srp-cp-label">Standard palette</span>
            <div class="srp-cp-chips" data-std></div>
          </div>
        `;
        widgetEl.appendChild(picker);

        const pickerEls = {
          sv: picker.querySelector('.srp-cp-sv'),
          svMarker: picker.querySelector('.srp-cp-marker'),
          hue: picker.querySelector('.srp-cp-hue'),
          hueMarker: picker.querySelector('.srp-cp-hue-marker'),
          prevOld: picker.querySelector('.srp-cp-prev-old'),
          prevNew: picker.querySelector('.srp-cp-prev-new'),
          hex: picker.querySelector('.srp-cp-hex input'),
          rgb: {
            r: picker.querySelector('.srp-cp-rgb input[data-ch="r"]'),
            g: picker.querySelector('.srp-cp-rgb input[data-ch="g"]'),
            b: picker.querySelector('.srp-cp-rgb input[data-ch="b"]')
          },
          rgbVal: {
            r: picker.querySelector('.srp-cp-rgb b[data-v="r"]'),
            g: picker.querySelector('.srp-cp-rgb b[data-v="g"]'),
            b: picker.querySelector('.srp-cp-rgb b[data-v="b"]')
          },
          recent: picker.querySelector('[data-recent]'),
          std: picker.querySelector('[data-std]')
        };

        // HSV state backing the picker (h: 0-360, s/v: 0-1).
        let pch = 0, pcs = 0, pcv = 1;

        function srpHexToRgb(hex) {
          // Accepts #rrggbb, rrggbb, and 3-digit shorthand (#fff / fff).
          const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex).trim());
          if (!m) return null;
          const s = m[1];
          const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
          const n = parseInt(full, 16);
          return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
        function srpRgbToHex(r, g, b) {
          const to2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
          return '#' + to2(r) + to2(g) + to2(b);
        }
        function srpRgbToHsv(r, g, b) {
          r /= 255; g /= 255; b /= 255;
          const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
          let h = 0;
          if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
          }
          return { h, s: max === 0 ? 0 : d / max, v: max };
        }
        function srpHsvToRgb(h, s, v) {
          h = ((h % 360) + 360) % 360;
          const c = v * s;
          const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
          const m = v - c;
          let r, g, b;
          if (h < 60) { r = c; g = x; b = 0; }
          else if (h < 120) { r = x; g = c; b = 0; }
          else if (h < 180) { r = 0; g = c; b = x; }
          else if (h < 240) { r = 0; g = x; b = c; }
          else if (h < 300) { r = x; g = 0; b = c; }
          else { r = c; g = 0; b = x; }
          return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
        }

        // Reflects the picker's current HSV state onto every control.
        function syncPicker() {
          const { r, g, b } = srpHsvToRgb(pch, pcs, pcv);
          const hex = srpRgbToHex(r, g, b);
          // The SV field's background follows the hue. Must be set with
          // 'important': the stylesheet's .srp-cp-sv fallback uses
          // !important, and an !important declaration always beats a plain
          // inline style — without this the field silently rendered
          // permanently red no matter what hue was picked.
          pickerEls.sv.style.setProperty(
            'background',
            'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(' + pch + ', 100%, 50%))',
            'important'
          );
          pickerEls.svMarker.style.left = (pcs * 100) + '%';
          pickerEls.svMarker.style.top = ((1 - pcv) * 100) + '%';
          pickerEls.hueMarker.style.top = ((1 - pch / 360) * 100) + '%';
          pickerEls.rgb.r.value = r;
          pickerEls.rgb.g.value = g;
          pickerEls.rgb.b.value = b;
          pickerEls.rgbVal.r.textContent = r;
          pickerEls.rgbVal.g.textContent = g;
          pickerEls.rgbVal.b.textContent = b;
          // Don't clobber the hex field while the user is typing in it.
          if (document.activeElement !== pickerEls.hex) {
            pickerEls.hex.value = hex;
          }
          pickerEls.prevNew.style.background = hex;
        }

        function setFromHex(hex) {
          const rgb = srpHexToRgb(hex);
          if (!rgb) return;
          const hsv = srpRgbToHsv(rgb.r, rgb.g, rgb.b);
          pch = hsv.h; pcs = hsv.s; pcv = hsv.v;
          syncPicker();
        }

        // One small chip per color; clicking one sets the pending color.
        function buildChips(container, colors) {
          container.innerHTML = '';
          colors.forEach((color) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'srp-cp-chip';
            chip.style.setProperty('background', color, 'important');
            chip.title = color;
            chip.addEventListener('click', () => setFromHex(color));
            container.appendChild(chip);
          });
        }

        // Standard palette (a curated 16, mirroring the native dialog's
        // row) plus persisted recently-used colors (capped at 10).
        const STANDARD_COLORS = [
          '#ffff00', '#ffeb3b', '#ff9800', '#f44336', '#e91e63', '#9c27b0', '#673ab7',
          '#00bcd4', '#2196f3', '#cddc39', '#4caf50', '#a5d6a7', '#000000', '#424242',
          '#9e9e9e', '#ffffff'
        ];
        let recentColors = Array.isArray(drawPrefs?.recentColors) ? drawPrefs.recentColors.slice(0, 10) : [];
        buildChips(pickerEls.std, STANDARD_COLORS);
        buildChips(pickerEls.recent, recentColors);

        function rebuildRecentChips() {
          buildChips(pickerEls.recent, recentColors);
        }

        function openColorPicker() {
          setFromHex(currentColor);
          pickerEls.prevOld.style.background = currentColor;
          picker.classList.add('srp-open');
        }

        function closeColorPicker() {
          picker.classList.remove('srp-open');
        }

        function applyColorAndClose() {
          const rgb = srpHexToRgb(pickerEls.hex.value);
          if (!rgb) {
            // Invalid hex: flash the field red and stay open rather than
            // silently doing nothing on Ok.
            pickerEls.hex.classList.add('srp-cp-hex-invalid');
            setTimeout(() => pickerEls.hex.classList.remove('srp-cp-hex-invalid'), 500);
            return;
          }
          currentColor = srpRgbToHex(rgb.r, rgb.g, rgb.b);
          paletteDot.style.setProperty('background', currentColor, 'important');
          colorRow.querySelectorAll('.srp-swatch').forEach((s) => s.classList.remove('srp-active'));
          // If the picked color matches a preset, re-activate that
          // swatch's ring so the selection stays visually consistent.
          const presetIdx = COLORS.indexOf(currentColor);
          if (presetIdx !== -1) {
            colorRow.querySelectorAll('.srp-swatch')[presetIdx].classList.add('srp-active');
          }
          if (activeTextBox) {
            activeTextBox.color = currentColor;
            activeTextBox.el.style.setProperty('color', currentColor, 'important');
          }
          // Recently-used: most recent first, deduped, capped at 10.
          recentColors = [currentColor, ...recentColors.filter((c) => c !== currentColor)].slice(0, 10);
          rebuildRecentChips();
          saveDrawPrefs();
          closeColorPicker();
        }

        // --- Interaction wiring ---
        picker.querySelector('.srp-cp-close').addEventListener('click', closeColorPicker);
        picker.querySelector('.srp-cp-cancel').addEventListener('click', closeColorPicker);
        picker.querySelector('.srp-cp-ok').addEventListener('click', applyColorAndClose);

        // SV field + hue slider drags (pointer capture keeps the drag
        // alive outside the element; the pointerId guards redundant
        // events from touch/stylus).
        let dragMode = null; // 'sv' | 'hue'
        let dragPointerId = null;

        function svFromEvent(e, el) {
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
          pcs = x;
          pcv = 1 - y;
        }
        function hueFromEvent(e, el) {
          const r = el.getBoundingClientRect();
          const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
          pch = (1 - y) * 360;
        }

        pickerEls.sv.addEventListener('pointerdown', (e) => {
          if (dragMode) return;
          dragMode = 'sv';
          dragPointerId = e.pointerId;
          pickerEls.sv.setPointerCapture(e.pointerId);
          svFromEvent(e, pickerEls.sv);
          syncPicker();
          e.preventDefault();
        });
        pickerEls.hue.addEventListener('pointerdown', (e) => {
          if (dragMode) return;
          dragMode = 'hue';
          dragPointerId = e.pointerId;
          pickerEls.hue.setPointerCapture(e.pointerId);
          hueFromEvent(e, pickerEls.hue);
          syncPicker();
          e.preventDefault();
        });
        const onDragMove = (e) => {
          if (!dragMode || e.pointerId !== dragPointerId) return;
          if (dragMode === 'sv') svFromEvent(e, pickerEls.sv);
          else hueFromEvent(e, pickerEls.hue);
          syncPicker();
        };
        const onDragEnd = (e) => {
          if (e.pointerId !== dragPointerId) return;
          dragMode = null;
          dragPointerId = null;
        };
        pickerEls.sv.addEventListener('pointermove', onDragMove);
        pickerEls.hue.addEventListener('pointermove', onDragMove);
        pickerEls.sv.addEventListener('pointerup', onDragEnd);
        pickerEls.hue.addEventListener('pointerup', onDragEnd);
        pickerEls.sv.addEventListener('pointercancel', onDragEnd);
        pickerEls.hue.addEventListener('pointercancel', onDragEnd);

        // RGB sliders → recompute HSV from RGB.
        ['r', 'g', 'b'].forEach((ch) => {
          pickerEls.rgb[ch].addEventListener('input', () => {
            const { r, g, b } = {
              r: pickerEls.rgb.r.valueAsNumber,
              g: pickerEls.rgb.g.valueAsNumber,
              b: pickerEls.rgb.b.valueAsNumber
            };
            const hsv = srpRgbToHsv(r, g, b);
            pch = hsv.h; pcs = hsv.s; pcv = hsv.v;
            syncPicker();
          });
        });

        // Hex text box → parse on input (only syncs when valid).
        pickerEls.hex.addEventListener('input', () => {
          const rgb = srpHexToRgb(pickerEls.hex.value);
          if (!rgb) return;
          const hsv = srpRgbToHsv(rgb.r, rgb.g, rgb.b);
          pch = hsv.h; pcs = hsv.s; pcv = hsv.v;
          syncPicker();
        });
        pickerEls.hex.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') applyColorAndClose();
          else if (e.key === 'Escape') closeColorPicker();
        });
        pickerEls.hex.addEventListener('blur', () => {
          // Normalize a loosely-typed but valid entry on blur.
          const rgb = srpHexToRgb(pickerEls.hex.value);
          if (rgb) {
            pickerEls.hex.value = srpRgbToHex(rgb.r, rgb.g, rgb.b);
            syncPicker();
          }
        });

        // Clicking anywhere outside the picker cancels it.
        const outsideClick = (e) => {
          if (!picker.classList.contains('srp-open')) return;
          if (picker.contains(e.target) || paletteBtn.contains(e.target)) return;
          closeColorPicker();
        };
        document.addEventListener('pointerdown', outsideClick);
        cleanupFns.push(() => document.removeEventListener('pointerdown', outsideClick));

        // 🎨 toggles the picker.
        paletteBtn.addEventListener('click', () => {
          if (picker.classList.contains('srp-open')) closeColorPicker();
          else openColorPicker();
        });

        // ----- Tool selection -----
        const TOOL_BUTTONS = ['pen', 'rect', 'circle', 'arrow', 'highlight'];
        const toolButtons = {};
        TOOL_BUTTONS.forEach((t) => { toolButtons[t] = widgetEl.querySelector('#srp-btn-' + t); });

        function deactivateAllTools() {
          TOOL_BUTTONS.forEach((t) => toolButtons[t].classList.remove('srp-active'));
        }

        // Switches the active draw tool (or null to turn drawing off).
        function setTool(tool) {
          activeTool = tool;
          deactivateAllTools();
          if (tool) toolButtons[tool].classList.add('srp-active');
          const on = !!tool;
          // setProperty(..., 'important') matters here: selector.css sets
          // pointer-events: none !important on this canvas (so it never
          // blocks clicks on the host page while no tool is active) — a
          // plain inline style can't win against a stylesheet's
          // !important.
          annotateCanvasEl.style.setProperty('pointer-events', on ? 'auto' : 'none', 'important');
          annotateCanvasEl.classList.toggle('srp-draw-mode', on);
          colorRow.style.setProperty('display', on ? 'flex' : 'none', 'important');
          // A draw tool and blur mode are mutually exclusive — both would
          // fight over the same pointer.
          if (tool) {
            blurModeOn = false;
            blurBtn.classList.remove('srp-active');
            blurPopup.classList.remove('srp-open');
            blurSurfaceEl.classList.remove('srp-blur-active');
            blurSurfaceEl.style.setProperty('pointer-events', 'none', 'important');
          }
          saveDrawPrefs();
        }

        TOOL_BUTTONS.forEach((t) => {
          toolButtons[t].addEventListener('click', () => {
            if (activeTool === t) setTool(null);
            else setTool(t);
          });
        });

        // "Remember last settings" — persisted (debounced) drawing prefs.
        let drawPrefsTimer = null;
        function saveDrawPrefs() {
          if (drawPrefsTimer) clearTimeout(drawPrefsTimer);
          drawPrefsTimer = setTimeout(() => {
            chrome.storage.local.set({
              drawPrefs: {
                tool: activeTool,
                color: currentColor,
                lineWidth,
                blurThickness,
                blurOpacity,
                recentColors
              }
            }).catch(() => {});
          }, 400);
        }

        // 📝 Text tool — one click drops a transparent, editable text box
        // in the middle of the recorded area, focused and ready to type.
        // Its color is changed afterwards by selecting it (click) and
        // picking a swatch or the color picker above.
        const textBtn = widgetEl.querySelector('#srp-btn-text');
        textBtn.addEventListener('click', () => {
          createTextBox(selection.x + selection.width / 2, selection.y + selection.height / 2);
        });

        widgetEl.querySelector('#srp-btn-undo').addEventListener('click', undoLast);
        widgetEl.querySelector('#srp-btn-redo').addEventListener('click', redoLast);
        // 🗑 Clear-all: canvas actions, text boxes AND blur bars.
        widgetEl.querySelector('#srp-btn-clear').addEventListener('click', () => {
          actions.length = 0;
          redoStack.length = 0;
          renderAll();
          textBoxes.forEach((box) => box.wrap.remove());
          textBoxes.length = 0;
          activeTextBox = null;
          blurBars.forEach((bar) => bar.remove());
          blurBars.length = 0;
          saveDrawPrefs();
        });

        // ---------- Blur / redact tool ----------
        // Privacy tool: choose a brush size + cover strength from the
        // popup (it slides up above the button when blur mode turns on),
        // then drag on the recording area — a blurred trail follows your
        // pointer like a marker, hiding faces, names, chat messages and
        // private details. Each stroke is a real DOM element on the page,
        // so getDisplayMedia captures it automatically (exactly like the
        // pencil strokes and the webcam bubble). Drawing is fully usable
        // while the recording is paused — strokes appear in the footage
        // once recording resumes.
        let blurModeOn = false;
        // Restore the remembered blur style (see drawPrefs).
        let blurThickness = drawPrefs?.blurThickness || 48;
        let blurOpacity = drawPrefs?.blurOpacity ?? 0.88;

        blurSurfaceEl = document.createElement('div');
        blurSurfaceEl.className = 'srp-blur-surface';
        blurSurfaceEl.style.left = `${selection.x}px`;
        blurSurfaceEl.style.top = `${selection.y}px`;
        blurSurfaceEl.style.width = `${selection.width}px`;
        blurSurfaceEl.style.height = `${selection.height}px`;
        document.body.appendChild(blurSurfaceEl);

        const blurPopup = document.createElement('div');
        blurPopup.className = 'srp-blur-popup';
        blurPopup.innerHTML = `
          <span class="srp-blur-label">Brush size</span>
          <div class="srp-blur-sizes">
            <button data-size="24" title="Thin brush">S</button>
            <button data-size="48" class="srp-active" title="Medium brush">M</button>
            <button data-size="96" title="Thick brush">L</button>
          </div>
          <span class="srp-blur-label">Cover strength</span>
          <div class="srp-blur-opacity">
            <input type="range" min="0.35" max="1" step="0.05" value="0.88" title="Opacity">
            <span class="srp-blur-pct">88%</span>
          </div>
          <div class="srp-blur-clear">
            <button type="button" title="Remove all blur strokes">✕ Clear blur</button>
          </div>
        `;
        widgetEl.appendChild(blurPopup);

        blurPopup.querySelectorAll('.srp-blur-sizes button').forEach((btn) => {
          btn.addEventListener('click', () => {
            blurThickness = parseInt(btn.dataset.size, 10);
            blurPopup.querySelectorAll('.srp-blur-sizes button').forEach((b) => b.classList.remove('srp-active'));
            btn.classList.add('srp-active');
            saveDrawPrefs();
          });
        });
        const opacityInput = blurPopup.querySelector('input[type="range"]');
        const opacityPct = blurPopup.querySelector('.srp-blur-pct');
        opacityInput.addEventListener('input', () => {
          blurOpacity = parseFloat(opacityInput.value);
          opacityPct.textContent = `${Math.round(blurOpacity * 100)}%`;
          saveDrawPrefs();
        });
        // Clear-all lives here too (not just in the draw color row), so
        // blur mode always has a reachable undo for mis-placed bars.
        blurPopup.querySelector('.srp-blur-clear button').addEventListener('click', () => {
          blurBars.forEach((bar) => bar.remove());
          blurBars.length = 0;
        });

        const blurBtn = widgetEl.querySelector('#srp-btn-blur');
        blurBtn.addEventListener('click', () => {
          blurModeOn = !blurModeOn;
          blurBtn.classList.toggle('srp-active', blurModeOn);
          blurPopup.classList.toggle('srp-open', blurModeOn);
          blurSurfaceEl.classList.toggle('srp-blur-active', blurModeOn);
          // setProperty(..., 'important') matters here for the same reason
          // as the pencil: selector.css pins pointer-events: none on the
          // surface so it never blocks the host page while blur mode is off.
          blurSurfaceEl.style.setProperty('pointer-events', blurModeOn ? 'auto' : 'none', 'important');
          // Blur and the draw tools are mutually exclusive.
          if (blurModeOn) setTool(null);
          saveDrawPrefs();
        });

        // Freehand brush: every stroke is drawn as ONE fixed div
        // (.srp-blur-stroke) carrying a SINGLE backdrop-filter, masked to
        // the trail's exact shape via an inline SVG mask (a polyline with
        // round caps, brush-wide). Earlier versions used one
        // backdrop-filter div per emitted point; the stacked filters
        // re-blurred + re-tinted the page at every joint, so the trail
        // rendered as a chain of beads/circles even though its geometry
        // was continuous. One masked element can't stack, and the
        // polyline mask is continuous by construction at any drag speed.
        // A click without a drag paints a dot (a circle in the mask).
        // The surface rect is cached per stroke (it can't move
        // mid-stroke) to avoid a layout read on every emitted point.
        let blurSurfaceRect = null;
        // Current-stroke state (reset on pointerdown, finalized on up).
        let blurStrokeActive = false;
        let blurPointerId = null;
        let blurLastX = 0;
        let blurLastY = 0;
        let blurSegmentsDrawn = 0;
        let blurStrokeEl = null;
        let blurStrokePts = [];
        let blurStrokeMinX = 0, blurStrokeMinY = 0, blurStrokeMaxX = 0, blurStrokeMaxY = 0;

        // (Re)positions the stroke element to the trail's bounding box and
        // (re)writes its SVG mask. Runs on every emitted point — segments
        // are throttled to ~brush/6 px, so rebuilding the small data-URI
        // is cheap even for long strokes.
        function paintBlurStroke() {
          const t = blurThickness / 2;
          // The element box is padded by the brush radius so the round
          // line caps of the mask path are never clipped at the edges.
          const minX = blurStrokeMinX - t;
          const minY = blurStrokeMinY - t;
          const w = Math.max(1, blurStrokeMaxX - blurStrokeMinX + blurThickness);
          const h = Math.max(1, blurStrokeMaxY - blurStrokeMinY + blurThickness);
          const rel = blurStrokePts.map((p) => [(p[0] - minX).toFixed(1), (p[1] - minY).toFixed(1)]);
          let shape;
          if (rel.length === 1) {
            // A click-without-drag: a solid circle the size of the brush.
            shape = `<circle cx="${rel[0][0]}" cy="${rel[0][1]}" r="${t}" fill="#fff"/>`;
          } else {
            const d = `M ${rel.map((p, i) => (i === 0 ? `${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ')}`;
            shape = `<path d="${d}" fill="none" stroke="#fff" stroke-width="${blurThickness}" stroke-linecap="round" stroke-linejoin="round"/>`;
          }
          const uri = 'data:image/svg+xml,' + encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}">${shape}</svg>`
          );
          if (!blurStrokeEl) {
            blurStrokeEl = document.createElement('div');
            blurStrokeEl.className = 'srp-blur-stroke';
            blurStrokeEl.style.setProperty('background', `rgba(15, 23, 42, ${blurOpacity})`, 'important');
            document.body.appendChild(blurStrokeEl);
            blurBars.push(blurStrokeEl);
          }
          blurStrokeEl.style.left = `${minX}px`;
          blurStrokeEl.style.top = `${minY}px`;
          blurStrokeEl.style.width = `${w}px`;
          blurStrokeEl.style.height = `${h}px`;
          blurStrokeEl.style.maskImage = `url("${uri}")`;
          blurStrokeEl.style.webkitMaskImage = `url("${uri}")`;
        }

        // Extends the current stroke with one more (clamped) endpoint.
        function addBlurSegment(x0, y0, x1, y1) {
          const rect = blurSurfaceRect || blurSurfaceEl.getBoundingClientRect();
          // Clamp the endpoints (inset by half the brush diameter) so the
          // whole trail stays inside the captured region.
          const t = blurThickness / 2;
          const loX = Math.min(rect.left + t, rect.right - t);
          const hiX = Math.max(rect.left + t, rect.right - t);
          const loY = Math.min(rect.top + t, rect.bottom - t);
          const hiY = Math.max(rect.top + t, rect.bottom - t);
          const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
          const ax = clamp(x0, loX, hiX);
          const ay = clamp(y0, loY, hiY);
          const bx = clamp(x1, loX, hiX);
          const by = clamp(y1, loY, hiY);
          if (blurSegmentsDrawn === 0) {
            blurStrokePts.push([ax, ay]);
            blurStrokeMinX = blurStrokeMaxX = ax;
            blurStrokeMinY = blurStrokeMaxY = ay;
          }
          // A click-without-drag passes the same point twice: skip the
          // duplicate so the polyline has exactly ONE point and
          // paintBlurStroke renders the <circle> dot (a zero-length
          // two-point path wouldn't reliably rasterize in Chrome).
          if (bx !== ax || by !== ay) {
            blurStrokePts.push([bx, by]);
            if (bx < blurStrokeMinX) blurStrokeMinX = bx;
            if (by < blurStrokeMinY) blurStrokeMinY = by;
            if (bx > blurStrokeMaxX) blurStrokeMaxX = bx;
            if (by > blurStrokeMaxY) blurStrokeMaxY = by;
          }
          blurSegmentsDrawn += 1;
          paintBlurStroke();
          return { x: bx, y: by };
        }

        blurSurfaceEl.addEventListener('pointerdown', (e) => {
          if (!blurModeOn || blurStrokeActive) return;
          blurStrokeActive = true;
          blurPointerId = e.pointerId;
          blurSurfaceEl.setPointerCapture(e.pointerId);
          blurSurfaceRect = blurSurfaceEl.getBoundingClientRect();
          blurLastX = e.clientX;
          blurLastY = e.clientY;
          blurSegmentsDrawn = 0;
          blurStrokePts = [];
          blurStrokeEl = null;
          e.preventDefault();
        });
        blurSurfaceEl.addEventListener('pointermove', (e) => {
          if (!blurStrokeActive || e.pointerId !== blurPointerId) return;
          // Emit only after enough movement — scaled to the brush size —
          // so a slow drag doesn't rebuild the mask on every pointer event.
          const dist = Math.hypot(e.clientX - blurLastX, e.clientY - blurLastY);
          if (dist < Math.max(2, blurThickness / 6)) return;
          const last = addBlurSegment(blurLastX, blurLastY, e.clientX, e.clientY);
          blurLastX = last.x;
          blurLastY = last.y;
        });
        const endBlurStroke = (e, commitDot) => {
          if (e.pointerId !== blurPointerId) return;
          blurStrokeActive = false;
          blurPointerId = null;
          blurSurfaceRect = null;
          // A click without a drag still paints a dot — but only on a
          // genuine pointerup, never a pointercancel (a canceled stroke
          // shouldn't commit anything).
          if (commitDot && blurSegmentsDrawn === 0) {
            addBlurSegment(blurLastX, blurLastY, blurLastX, blurLastY);
          }
          blurStrokeEl = null;
          blurStrokePts = [];
        };
        blurSurfaceEl.addEventListener('pointerup', (e) => endBlurStroke(e, true));
        blurSurfaceEl.addEventListener('pointercancel', (e) => endBlurStroke(e, false));

        // Remember last settings: re-activate the tool that was in use the
        // last time a recording ran (setTool also clears blur mode).
        if (drawPrefs?.tool && TOOL_BUTTONS.includes(drawPrefs.tool)) {
          setTool(drawPrefs.tool);
        }
      }

      // ---------- Keep the control bar out of the recorded video ----------
      // The widget is a real page element, so wherever it sits on the page
      // it ends up in the getDisplayMedia capture. The crop only covers
      // the selection box, though — so park the bar in the roomiest
      // viewport margin OUTSIDE the selection: it stays on screen and
      // fully usable, but can never appear in the footage. Only when the
      // selection leaves no room at all (it covers the viewport) do we
      // fall back to auto-hide (fade to a ghost when idle, reappear on
      // mouse movement).
      function placeWidgetOutsideRecording() {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 12;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        // Measure with the color row counted in (it's display:none until a
        // draw tool activates, but then it adds ~110px), so the bar can't
        // grow into the selection mid-recording.
        const colorRowEl = widgetEl.querySelector('.srp-color-row');
        const prevDisplay = colorRowEl ? colorRowEl.style.display : null;
        if (colorRowEl) colorRowEl.style.setProperty('display', 'flex', 'important');
        const w = widgetEl.offsetWidth || 400;
        const h = widgetEl.offsetHeight || 44;
        if (colorRowEl) colorRowEl.style.setProperty('display', prevDisplay || 'none', 'important');
        // All four are written as important inline styles: #srp-widget
        // pins bottom/right !important in the stylesheet, and the drag
        // handler (which writes left/top the same way) must keep winning
        // over this placement afterwards.
        const set = (prop, val) => widgetEl.style.setProperty(prop, val, 'important');
        const selCX = selection.x + selection.width / 2;
        const selCY = selection.y + selection.height / 2;
        const mL = selection.x;
        const mR = vw - (selection.x + selection.width);
        const mT = selection.y;
        const mB = vh - (selection.y + selection.height);
        const needW = w + pad * 2;
        const needH = h + pad * 2;
        let placed = false;
        if (mR >= needW) {
          set('right', pad + 'px'); set('left', 'auto');
          const topPos = clamp(selCY - h / 2, pad, vh - h - pad);
          set('top', topPos + 'px'); set('bottom', 'auto');
          // Popups open ABOVE the bar; if the bar sits high enough that
          // they'd clip off the top of the viewport, flip them below.
          widgetEl.classList.toggle('srp-widget-popup-below', topPos < 460);
          placed = true;
        } else if (mL >= needW) {
          set('left', pad + 'px'); set('right', 'auto');
          const topPos = clamp(selCY - h / 2, pad, vh - h - pad);
          set('top', topPos + 'px'); set('bottom', 'auto');
          widgetEl.classList.toggle('srp-widget-popup-below', topPos < 460);
          placed = true;
        } else if (mT >= needH) {
          set('top', pad + 'px'); set('bottom', 'auto');
          set('left', clamp(selCX - w / 2, pad, vw - w - pad) + 'px'); set('right', 'auto');
          // Parked in the top margin: the blur/color popups would open
          // above the bar, off-screen — flip them to open below.
          widgetEl.classList.add('srp-widget-popup-below');
          placed = true;
        } else if (mB >= needH) {
          set('bottom', pad + 'px'); set('top', 'auto');
          set('left', clamp(selCX - w / 2, pad, vw - w - pad) + 'px'); set('right', 'auto');
          widgetEl.classList.remove('srp-widget-popup-below');
          placed = true;
        }
        if (!placed) {
          widgetEl.classList.add('srp-widget-auto-hide');
          let hideTimer = null;
          const reveal = () => {
            widgetEl.classList.remove('srp-widget-auto-hidden');
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
              if (!document.body.contains(widgetEl)) return;
              const openPopup = widgetEl.querySelector('.srp-blur-popup.srp-open, .srp-color-picker.srp-open');
              if (!openPopup) widgetEl.classList.add('srp-widget-auto-hidden');
            }, 4000);
          };
          ['pointermove', 'pointerdown', 'click', 'keydown'].forEach((type) => trackListener(document, type, reveal));
          reveal();
        }
      }
      placeWidgetOutsideRecording();

      // ---------- Collapse / expand the whole toolbar ----------
      // The full bar (timer + all the drawing tools + colors) is wide and
      // can cover a lot of the page. A chevron toggle shrinks it to just
      // the essential recording controls (handle, timer, pause, screenshot,
      // stop) so the page underneath is fully visible and clickable. The
      // state is remembered across recordings.
      const { widgetCollapsed } = await chrome.storage.local.get('widgetCollapsed');
      const collapseBtn = widgetEl.querySelector('#srp-btn-collapse');
      function applyToolbarCollapsed(collapsed) {
        widgetEl.classList.toggle('srp-collapsed', collapsed);
        collapseBtn.textContent = collapsed ? '⟨' : '⟩';
        collapseBtn.title = collapsed ? 'Expand toolbar' : 'Collapse toolbar';
        collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        if (collapsed) {
          // Deactivate any active draw tool / blur mode (DOM-driven, so
          // this works whether or not annotate is enabled) — otherwise
          // the hidden toolbar would still leave the canvas/surface
          // swallowing clicks meant for the page. Also close the color
          // picker if it was open, so it doesn't reappear on expand.
          const activeToolBtn = widgetEl.querySelector('.srp-tool-btn.srp-active');
          if (activeToolBtn) activeToolBtn.click();
          const pickerEl = widgetEl.querySelector('.srp-color-picker');
          if (pickerEl) pickerEl.classList.remove('srp-open');
        }
      }
      applyToolbarCollapsed(!!widgetCollapsed);
      collapseBtn.addEventListener('click', () => {
        const nowCollapsed = !widgetEl.classList.contains('srp-collapsed');
        applyToolbarCollapsed(nowCollapsed);
        chrome.storage.local.set({ widgetCollapsed: nowCollapsed }).catch(() => {});
      });

      // Draggable widget (drag by the grip handle only, so the buttons
      // stay clickable).
      (function makeWidgetDraggable() {
        const handle = widgetEl.querySelector('.srp-drag-handle');
        let dragging = false;
        let dragPointerId = null;
        let offsetX = 0;
        let offsetY = 0;
        handle.addEventListener('pointerdown', (e) => {
          if (dragging) return;
          dragging = true;
          dragPointerId = e.pointerId;
          handle.setPointerCapture(e.pointerId);
          const rect = widgetEl.getBoundingClientRect();
          offsetX = e.clientX - rect.left;
          offsetY = e.clientY - rect.top;
          // setProperty(..., 'important') matters here: #srp-widget pins
          // bottom/right !important as its default corner position, which
          // silently beat a plain inline 'auto' reset — the widget looked
          // draggable (handle, listeners, everything wired up) but never
          // actually moved.
          widgetEl.style.setProperty('right', 'auto', 'important');
          widgetEl.style.setProperty('bottom', 'auto', 'important');
          e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
          if (!dragging || e.pointerId !== dragPointerId) return;
          // setProperty(..., 'important') to match placeWidgetOutsideRecording:
          // the widget's position is always written as important inline
          // styles (the stylesheet pins bottom/right !important), so a
          // plain inline left/top would lose to an important placement
          // value and the bar would stop moving horizontally.
          widgetEl.style.setProperty('left', `${e.clientX - offsetX}px`, 'important');
          widgetEl.style.setProperty('top', `${e.clientY - offsetY}px`, 'important');
        });
        const endWidgetDrag = (e) => {
          if (e.pointerId !== dragPointerId) return;
          dragging = false;
          dragPointerId = null;
        };
        handle.addEventListener('pointerup', endWidgetDrag);
        handle.addEventListener('pointercancel', endWidgetDrag);
      })();

      const dotEl = widgetEl.querySelector('#srp-dot');
      const timerEl = widgetEl.querySelector('#srp-timer');
      const pauseBtn = widgetEl.querySelector('#srp-btn-pause');
      const shotBtn = widgetEl.querySelector('#srp-btn-shot');
      const stopBtn = widgetEl.querySelector('#srp-btn-stop');

      // Timestamp-based rather than a naive per-tick counter: (1) it can't
      // drift if a setInterval tick is ever delayed, and (2) writing the
      // timestamps to storage lets any other context — the popup, in
      // particular, when reopened mid-recording — reconstruct the exact
      // same elapsed time on demand, which a local-only counter can't do.
      let recordStartTime = Date.now();
      let totalPausedMs = 0;
      let pauseStartedAt = 0;
      let timerInterval = null;

      function currentElapsedSeconds() {
        const pausedSoFar = totalPausedMs + (pauseStartedAt ? Date.now() - pauseStartedAt : 0);
        return Math.max(0, Math.floor((Date.now() - recordStartTime - pausedSoFar) / 1000));
      }

      function renderTimer() {
        const secs = currentElapsedSeconds();
        const mins = String(Math.floor(secs / 60)).padStart(2, '0');
        const s = String(secs % 60).padStart(2, '0');
        timerEl.textContent = `${mins}:${s}`;
      }

      function startTimer() {
        if (timerInterval) return;
        renderTimer();
        timerInterval = setInterval(renderTimer, 1000);
      }
      function stopTimer() {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      startTimer();

      function doPauseResume() {
        if (!mediaRecorder) return;
        if (mediaRecorder.state === 'recording') {
          mediaRecorder.pause();
          stopTimer();
          pauseStartedAt = Date.now();
          dotEl.classList.add('srp-paused');
          pauseBtn.textContent = '▶';
          chrome.storage.local.set({ isPaused: true, pauseStartedAt });
          chrome.runtime.sendMessage({ action: 'RECORDING_PAUSED' }).catch(() => {});
        } else if (mediaRecorder.state === 'paused') {
          mediaRecorder.resume();
          totalPausedMs += Date.now() - pauseStartedAt;
          pauseStartedAt = 0;
          renderTimer();
          startTimer();
          dotEl.classList.remove('srp-paused');
          pauseBtn.textContent = '⏸';
          chrome.storage.local.set({ isPaused: false, totalPausedMs, pauseStartedAt: null });
          chrome.runtime.sendMessage({ action: 'RECORDING_RESUMED' }).catch(() => {});
        }
      }

      function doStop() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      }

      function doScreenshot() {
        // No page flash: the old full-page white flash (#srp-shot-flash)
        // was also page DOM, so the area-mode recording captured it INTO
        // the video — the "screenshot blink" visible in footage. The
        // green badge ✓ (flashBadgeSuccess in background.js) is the
        // feedback now; it can't be recorded.
        // The toolbar is page DOM too, so it must be hidden while the
        // capture runs or it gets baked into the PNG. background.js also
        // sends PRE/POST_SCREENSHOT (which covers the keyboard shortcut),
        // but hiding here first makes the button path independent of that
        // round-trip — the widget is already gone when the capture
        // starts, and restored once the file is downloaded. The 80ms
        // lets the browser paint the hide before the capture message
        // even leaves (captureVisibleTab grabs the compositor's state).
        widgetEl.classList.add('srp-widget-hidden-for-shot');
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'CAPTURE_SCREENSHOT' })
            .catch(() => {})
            .finally(() => widgetEl.classList.remove('srp-widget-hidden-for-shot'));
        }, 80);
      }

      pauseBtn.addEventListener('click', doPauseResume);
      shotBtn.addEventListener('click', doScreenshot);
      stopBtn.addEventListener('click', doStop);

      // Keyboard shortcuts and any other extension surface (e.g. a
      // future popup "stop" click while this content script is the
      // active recorder) reach this recording through background.js,
      // which relays here via chrome.tabs.sendMessage.
      const bgMessageListener = (message, sender, sendResponse) => {
        // Answered synchronously so the background's crash-recovery check
        // (recoverFromCrash) can confirm this recording is still alive
        // before it mistakes a throttled-but-live recording for a crash.
        if (message.action === 'RECOVERY_PING') {
          sendResponse({ alive: true });
          return;
        }
        if (message.action === 'STOP_AREA_RECORDING') doStop();
        else if (message.action === 'PAUSE_AREA_RECORDING') {
          if (mediaRecorder.state === 'recording') doPauseResume();
        } else if (message.action === 'RESUME_AREA_RECORDING') {
          if (mediaRecorder.state === 'paused') doPauseResume();
        } else if (message.action === 'PRE_SCREENSHOT') {
          // A screenshot captures the whole viewport — hide the toolbar
          // (page DOM, so it would be baked into the PNG along with any
          // open blur/color popup). POST_SCREENSHOT reveals it once
          // background.js has downloaded the file.
          widgetEl.classList.add('srp-widget-hidden-for-shot');
        } else if (message.action === 'POST_SCREENSHOT') {
          widgetEl.classList.remove('srp-widget-hidden-for-shot');
        }
      };
      chrome.runtime.onMessage.addListener(bgMessageListener);

      mediaRecorder.onstop = async () => {
        renderLoopActive = false;
        stopTimer();
        clearInterval(recoveryTimer);
        const finalDurationSec = currentElapsedSeconds();
        chrome.runtime.onMessage.removeListener(bgMessageListener);
        cleanupFns.forEach((fn) => fn());
        cleanupFns.length = 0;
        if (typeof SRPEffects !== 'undefined' && typeof SRPEffects.stop === 'function') SRPEffects.stop();
        document.body.removeAttribute('data-srp-active');

        [widgetEl, webcamBubbleEl, annotateCanvasEl, blurSurfaceEl].forEach((el) => {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        });
        textBoxes.forEach((box) => box.wrap.remove());
        textBoxes.length = 0;
        blurBars.forEach((bar) => bar.remove());
        blurBars.length = 0;

        fullStream.getTracks().forEach((track) => track.stop());
        if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
        if (micStream) micStream.getTracks().forEach((track) => track.stop());
        // The canvas-capture stream (and the mixed audio track on it) isn't
        // in any of the above — stop it explicitly so the capture loop and
        // the mic processor are fully released on stop.
        if (croppedStream) croppedStream.getTracks().forEach((track) => track.stop());

        // Clear the recording state right away (before the async download
        // + history upload below) so the next start is never blocked by
        // an unfinished save.
        chrome.storage.local.set({ isRecording: false, isPaused: false });
        chrome.runtime.sendMessage({ action: 'AREA_RECORDING_STOPPED' }).catch(() => {});

        const blob = new Blob(chunks, { type: recorderMime });

        if (blob.size === 0) {
          // Nothing was encoded (e.g. stopped instantly) — skip the empty
          // file entirely.
          console.warn('Area recording produced 0 bytes — skipped empty file');
          return;
        }

        const thumbnail = canvas.toDataURL('image/jpeg', 0.5);

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `area-recording-${Date.now()}.${srpMimeExtension(recorderMime)}`;
        a.click();
        URL.revokeObjectURL(url);

        try {
          const buffer = await blob.arrayBuffer();
          // Sent in fixed-size chunks rather than as one message: Chrome
          // caps chrome.runtime.sendMessage payloads at roughly ~32MB,
          // which even a short 1080p (let alone 4K) recording exceeds —
          // that previously made the SAVE_RECORDING message throw and get
          // dropped for anything past about 30-60 seconds, even though
          // the direct download above always succeeded regardless. The
          // background script reassembles these before writing to
          // IndexedDB (see handleRecordingChunk in background.js).
          const transferId = `xfer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const CHUNK_SIZE = 8 * 1024 * 1024;
          const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / CHUNK_SIZE));

          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const chunk = buffer.slice(start, Math.min(start + CHUNK_SIZE, buffer.byteLength));
            await chrome.runtime.sendMessage({
              action: 'SAVE_RECORDING_CHUNK',
              transferId,
              chunkIndex: i,
              totalChunks,
              // Chrome's extension messaging JSON-serializes message payloads
              // (an ArrayBuffer arrives on the receiving side as an empty
              // {} — verified on Chrome 151), so binary chunks are
              // base64-encoded here and decoded in background.js before the
              // recording is reassembled.
              chunk: srpArrayBufferToBase64(chunk),
              meta: i === totalChunks - 1
                ? {
                    mimeType: recorderMime,
                    thumbnail,
                    mode: savedMode,
                    duration: finalDurationSec,
                    resolution: `${cropWidth}x${cropHeight}`
                  }
                : undefined
            });
          }
        } catch (e) {
          console.warn('Could not save recording to history:', e);
        }
      };

      mediaRecorder.start(1000);

      // --- Crash-recovery checkpoints ---
      // Every ~5s the recorded-so-far bytes are appended (delta-only) to
      // the background's recovery snapshot in IndexedDB. If Chrome crashes
      // or the extension reloads mid-recording, the snapshot survives and
      // background.js offers it back ("⚠ Recording recovered"). Sent as
      // base64 — Chrome's extension messaging destroys binary payloads
      // (see SAVE_RECORDING_CHUNK). While paused nothing is appended, so
      // a lightweight heartbeat keeps the snapshot marked as live and
      // prevents a false "recovered" for a recording that's merely paused.
      // Number of chunks already checkpointed. Tracking chunk COUNT (not a
      // byte offset into a re-materialized buffer) keeps each tick O(delta)
      // — materializing the whole recording every 5s to slice out the new
      // bytes would be O(n²) over a long recording (hundreds of MB of
      // copies per minute).
      let recoverySentChunks = 0;
      // In-flight guard: if one tick's send + service-worker round-trip ever
      // exceeded 5s, the next tick would overlap it and two concurrent
      // RECOVERY_APPENDs could both read the same checkpoint sequence number,
      // silently dropping a chunk (a hole in the recovered file).
      let recoveryBusy = false;
      const recoveryTimer = setInterval(async () => {
        if (recoveryBusy) return;
        recoveryBusy = true;
        try {
          if (!mediaRecorder) return;
          if (mediaRecorder.state !== 'recording') {
            chrome.runtime.sendMessage({ action: 'RECOVERY_HEARTBEAT' }).catch(() => {});
            return;
          }
          if (chunks.length <= recoverySentChunks) return;
          const fresh = chunks.slice(recoverySentChunks);
          const blob = new Blob(fresh, { type: recorderMime });
          recoverySentChunks = chunks.length;
          if (blob.size === 0) return;
          const buffer = await blob.arrayBuffer();
          chrome.runtime.sendMessage({
            action: 'RECOVERY_APPEND',
            chunk: srpArrayBufferToBase64(buffer),
            mode: savedMode,
            resolution: `${cropWidth}x${cropHeight}`,
            mimeType: recorderMime
          }).catch(() => {});
        } catch (e) {
          // Recovery must never be able to affect the recording itself.
        } finally {
          recoveryBusy = false;
        }
      }, 5000);

      chrome.storage.local.set({
        isRecording: true,
        isPaused: false,
        recordStartTime,
        totalPausedMs: 0,
        pauseStartedAt: null
      });
      chrome.runtime.sendMessage({ action: 'AREA_RECORDING_STARTED', mode: config.mode }).catch(() => {});

      videoTrack.onended = () => {
        if (mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
        }
      };

    } catch (err) {
      renderLoopActive = false;
      cleanupFns.forEach((fn) => fn());
      cleanupFns.length = 0;
      if (typeof SRPEffects !== 'undefined' && typeof SRPEffects.stop === 'function') SRPEffects.stop();
      document.body.removeAttribute('data-srp-active');
      if (fullStream) fullStream.getTracks().forEach((track) => track.stop());
      if (webcamStream) webcamStream.getTracks().forEach((track) => track.stop());
      if (micStream) micStream.getTracks().forEach((track) => track.stop());
      [widgetEl, webcamBubbleEl, annotateCanvasEl, blurSurfaceEl].forEach((el) => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      textBoxes.forEach((box) => box.wrap.remove());
      textBoxes.length = 0;
      blurBars.forEach((bar) => bar.remove());
      blurBars.length = 0;

      if (err.name === 'NotAllowedError') {
        console.log('User cancelled screen capture selection.');
      } else {
        console.error('Screen recording error:', err.name, err.message);
        showFatalMessage('Recording failed to start (' + err.name + ') — see console for details.');
      }
      notifyAreaRecordingStopped();
    }
  }
})();
