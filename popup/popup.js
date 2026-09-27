document.addEventListener('DOMContentLoaded', async () => {
  const configForm = document.getElementById('configForm');
  const modeAreaBtn = document.getElementById('modeAreaBtn');
  const modeScreenBtn = document.getElementById('modeScreenBtn');
  const modeSelect = document.getElementById('modeSelect');
  const fpsSelect = document.getElementById('fpsSelect');
  const qualitySelect = document.getElementById('qualitySelect');
  const outputFormatSelect = document.getElementById('outputFormatSelect');
  const qualityHint = document.getElementById('qualityHint');
  const countdownToggle = document.getElementById('countdownToggle');
  const countdownGroup = document.getElementById('countdownGroup');
  const countdownHint = document.getElementById('countdownHint');
  const showCursor = document.getElementById('showCursor');
  const clickEffectsToggle = document.getElementById('clickEffectsToggle');
  const audioSourceSelect = document.getElementById('audioSourceSelect');
  const audioHint = document.getElementById('audioHint');
  const captionsToggle = document.getElementById('captionsToggle');
  const captionsLangGroup = document.getElementById('captionsLangGroup');
  const captionsLangSelect = document.getElementById('captionsLangSelect');
  const captionsSizeSelect = document.getElementById('captionsSizeSelect');
  const captionsHint = document.getElementById('captionsHint');
  const webcamToggle = document.getElementById('webcamToggle');
  const webcamTestGroup = document.getElementById('webcamTestGroup');
  const testCamBtn = document.getElementById('testCamBtn');
  const testCamStatus = document.getElementById('testCamStatus');
  const webcamPositionGroup = document.getElementById('webcamPositionGroup');
  const webcamPositionSelect = document.getElementById('webcamPositionSelect');
  const webcamShapeSelect = document.getElementById('webcamShapeSelect');
  const webcamDragHint = document.getElementById('webcamDragHint');
  const annotateGroup = document.getElementById('annotateGroup');
  const annotateToggle = document.getElementById('annotateToggle');
  const annotateSub = document.getElementById('annotateSub');
  const startBtn = document.getElementById('startBtn');
  const startError = document.getElementById('startError');
  const historyBtn = document.getElementById('historyBtn');

  const recordingStatus = document.getElementById('recordingStatus');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const statusTimer = document.getElementById('statusTimer');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const forceResetBtn = document.getElementById('forceResetBtn');

  const { recordConfig, isRecording } = await chrome.storage.local.get(['recordConfig', 'isRecording']);

  // Populate the caption language dropdown from the single source of
  // truth in shared/captions.js (SRP_CAPTION_LANGUAGES) — the same list
  // the recorder's recognition engine accepts.
  if (typeof SRP_CAPTION_LANGUAGES !== 'undefined') {
    for (const lang of SRP_CAPTION_LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.label;
      captionsLangSelect.appendChild(opt);
    }
  }
  // Same single-source-of-truth pattern for the text size presets.
  if (typeof SRP_CAPTION_SIZES !== 'undefined') {
    for (const s of SRP_CAPTION_SIZES) {
      const opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      captionsSizeSelect.appendChild(opt);
    }
  }

  // v2.7.1: WebM is the default container now — it records cleanly with
  // no H.264 macroblock-padding quirks and keeps text pixel-perfect.
  // Anyone still on the OLD default ('mp4' they never explicitly picked)
  // is migrated here exactly once; a deliberately chosen MP4
  // (formatTouched) is left alone.
  let formatTouched = false;
  let audioSourceTouched = false;
  if (recordConfig) {
    if (recordConfig.outputFormat === 'mp4' && !recordConfig.formatTouched) {
      recordConfig.outputFormat = 'webm';
      recordConfig.formatTouched = true;
      chrome.storage.local.set({ recordConfig });
    } else {
      formatTouched = !!recordConfig.formatTouched;
    }
    modeSelect.value = recordConfig.mode || modeSelect.value;
    fpsSelect.value = String(recordConfig.fps || 60);
    qualitySelect.value = recordConfig.quality || '1080p';
    outputFormatSelect.value = recordConfig.outputFormat || 'webm';
    countdownToggle.checked = recordConfig.countdown !== false;
    showCursor.checked = recordConfig.cursor !== false;
    // Earlier builds defaulted to System Audio Only while Voice Enhance
    // was visibly enabled. That can transcribe the mic for captions but
    // intentionally leaves the voice OUT of the recorded audio. Migrate
    // that untouched old default once; deliberate source choices remain.
    audioSourceTouched = !!recordConfig.audioSourceTouched;
    if (!audioSourceTouched && (!recordConfig.audioSource || recordConfig.audioSource === 'system')) {
      recordConfig.audioSource = 'both';
      recordConfig.audioSourceTouched = true;
      audioSourceTouched = true;
      chrome.storage.local.set({ recordConfig });
    }
    audioSourceSelect.value = recordConfig.audioSource || 'both';
    captionsToggle.checked = !!recordConfig.captions;
    // English (US) is the only supported language — a stale config from
    // an older multi-language build must resolve to it, never to an
    // empty (or unselectable) dropdown value.
    const storedLang = recordConfig.captionsLang || 'en-US';
    captionsLangSelect.value = [...captionsLangSelect.options].some((o) => o.value === storedLang)
      ? storedLang
      : 'en-US';
    captionsSizeSelect.value = recordConfig.captionsSize || 'medium';
    webcamToggle.checked = !!recordConfig.webcam;
    webcamPositionSelect.value = recordConfig.webcamPosition || 'bottom-right';
    webcamShapeSelect.value = recordConfig.webcamShape || 'circle';
    annotateToggle.checked = recordConfig.annotate !== false;
    clickEffectsToggle.checked = recordConfig.clickEffects !== false;
  }

  function setModeButtons() {
    const isArea = modeSelect.value === 'area';
    modeAreaBtn.classList.toggle('active', isArea);
    modeAreaBtn.setAttribute('aria-selected', String(isArea));
    modeScreenBtn.classList.toggle('active', !isArea);
    modeScreenBtn.setAttribute('aria-selected', String(!isArea));
  }

  // Build the config exactly as a recording start would. The annotate
  // toggle keeps its RAW state (not mode-forced) so switching modes in
  // the popup can't silently forget whether the user had it on.
  function currentConfig() {
    return {
      mode: modeSelect.value,
      fps: parseInt(fpsSelect.value, 10),
      quality: qualitySelect.value,
      outputFormat: outputFormatSelect.value,
      countdown: countdownToggle.checked,
      cursor: showCursor.checked,
      // RNNoise voice cleanup is always on for microphone recording.
      // The hard mute gate is intentionally off so quiet words cannot be
      // swallowed while RNNoise is loading or on soft/low-energy speech.
      noiseReduction: true,
      noiseGate: false,
      audioSource: audioSourceSelect.value,
      captions: captionsToggle.checked,
      captionsLang: captionsLangSelect.value || 'en-US',
      captionsSize: captionsSizeSelect.value || 'medium',
      webcam: webcamToggle.checked,
      webcamPosition: webcamPositionSelect.value,
      webcamShape: webcamShapeSelect.value,
      annotate: annotateToggle.checked,
      clickEffects: clickEffectsToggle.checked,
      audioSourceTouched,
      // True once the user has touched the format select (or been
      // migrated) — distinguishes an explicit MP4 choice from the old
      // mp4 default, so the one-time webm migration never fights a
      // deliberate pick.
      formatTouched: formatTouched || outputFormatSelect.value !== 'mp4'
    };
  }

  // Remember settings the moment they're changed — not only when a
  // recording starts. Closing the popup without recording used to lose
  // every change. The saved recordConfig also feeds the keyboard
  // shortcut path and the next popup open.
  function persistConfig() {
    chrome.storage.local.set({ recordConfig: currentConfig() });
  }

  // Flipping the format select marks it as an explicit user choice (see
  // formatTouched above). Runs before the form-level change listener,
  // so persistConfig saves the flag.
  outputFormatSelect.addEventListener('change', () => { formatTouched = true; });
  audioSourceSelect.addEventListener('change', () => { audioSourceTouched = true; });

  configForm.addEventListener('change', persistConfig);

  function syncVisibility() {
    setModeButtons();
    const isArea = modeSelect.value === 'area';
    webcamTestGroup.classList.toggle('hidden', !webcamToggle.checked);
    webcamPositionGroup.classList.toggle('hidden', !webcamToggle.checked);
    // The webcam bubble is draggable in BOTH modes: as a real page
    // element in area mode, and via the floating preview (or the widget
    // mini-map) in screen mode — say where instead of hiding the hint.
    webcamDragHint.textContent = isArea
      ? 'Drag the bubble anywhere on the page once recording starts.'
      : 'Drag the bubble in the floating preview to reposition it while recording.';
    webcamDragHint.classList.toggle('hidden', !webcamToggle.checked);
    // The Drawing + Text toggle stays VISIBLE in both modes so users
    // know the feature exists — it's just disabled (greyed out) in
    // screen mode, where there's no page surface to draw on.
    annotateGroup.classList.toggle('disabled', !isArea);
    annotateToggle.disabled = !isArea;
    annotateSub.textContent = isArea ? 'pen, shapes, arrows, highlight & text' : 'Area mode only';
    // The countdown runs inside the area-selection content script, which
    // screen mode never loads — so the toggle does nothing there. Disable
    // it (like annotate) rather than silently ignoring the user's choice.
    countdownGroup.classList.toggle('disabled', !isArea);
    countdownToggle.disabled = !isArea;
    countdownHint.classList.toggle('hidden', isArea);
    // Quality (bitrate preset) always applies; the *resolution* half of
    // it only applies in screen mode — area mode always captures your
    // exact selection at native resolution so the crop stays pixel
    // accurate. Surface that so "I picked 4K but it looks the same
    // size" isn't a mystery.
    qualityHint.classList.toggle('hidden', !isArea);
    // Captions work in both modes; the language picker + hint just follow
    // the toggle.
    const captionsOn = captionsToggle.checked;
    captionsLangGroup.classList.toggle('hidden', !captionsOn);
    captionsHint.classList.toggle('hidden', !captionsOn);
    // RNNoise cleanup + safe leveling only affect the mic track.
    // The hard mute gate is intentionally disabled to preserve quiet words,
    // so these hints describe the source without promising silence between phrases.
    const audioHints = {
      both: 'Records system sound and your microphone. Voice cleanup and safe leveling apply automatically to the mic.',
      mic: 'Records your microphone with voice cleanup and safe leveling. System sound is not included.',
      system: 'System audio only — your microphone voice will NOT be recorded. Choose System + Microphone to include it.',
      none: 'No audio will be recorded, including your microphone.'
    };
    audioHint.textContent = audioHints[audioSourceSelect.value] || audioHints.both;
  }
  syncVisibility();
  modeSelect.addEventListener('change', syncVisibility);
  modeAreaBtn.addEventListener('click', () => {
    modeSelect.value = 'area';
    syncVisibility();
    persistConfig(); // programmatic value set doesn't fire 'change'
  });
  modeScreenBtn.addEventListener('click', () => {
    modeSelect.value = 'screen';
    syncVisibility();
    persistConfig();
  });
  webcamToggle.addEventListener('change', syncVisibility);
  captionsToggle.addEventListener('change', syncVisibility);
  audioSourceSelect.addEventListener('change', syncVisibility);

  // Instant, unambiguous check of the camera permission BEFORE recording —
  // if this shows blocked, the extension's own camera permission is not
  // granted (granting it to a website like YouTube does nothing for the
  // offscreen document's request).
  testCamBtn.addEventListener('click', async () => {
    testCamStatus.textContent = 'Checking…';
    testCamStatus.className = 'cam-status';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      testCamStatus.textContent = '✓ Camera ready — bubble will work';
      testCamStatus.classList.add('ok');
    } catch (err) {
      testCamStatus.textContent =
        err.name === 'NotAllowedError'
          ? '✗ Blocked — allow Camera for "Screen Recorder Pro" at chrome://settings/content/camera'
          : '✗ Unavailable — camera blocked or in use by another app (e.g. OBS)';
      testCamStatus.classList.add('bad');
    }
  });

  // --- Live status while a recording is already in progress ---
  //
  // Elapsed time is computed from the same absolute recordStartTime /
  // totalPausedMs / pauseStartedAt timestamps that offscreen.js and
  // selector.js write to storage — not a local counter — so reopening
  // the popup mid-recording (or mid-pause) shows the true elapsed time
  // immediately, instead of restarting from 00:00.
  let statusInterval = null;

  async function renderStatus() {
    const { recordStartTime, totalPausedMs, pauseStartedAt, isPaused, activeMode } =
      await chrome.storage.local.get(['recordStartTime', 'totalPausedMs', 'pauseStartedAt', 'isPaused', 'activeMode']);

    statusLabel.textContent = activeMode === 'area' ? 'Recording selected area' : 'Recording screen / window';
    statusDot.classList.toggle('paused', !!isPaused);
    pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';

    if (recordStartTime) {
      const now = Date.now();
      const pausedSoFar = (totalPausedMs || 0) + (isPaused && pauseStartedAt ? now - pauseStartedAt : 0);
      const secs = Math.max(0, Math.floor((now - recordStartTime - pausedSoFar) / 1000));
      const mins = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      statusTimer.textContent = `${mins}:${s}`;
    }
  }

  function showRecordingStatus() {
    configForm.classList.add('hidden');
    recordingStatus.classList.remove('hidden');
    renderStatus();
    if (!statusInterval) statusInterval = setInterval(renderStatus, 1000);
  }

  function showConfigForm() {
    recordingStatus.classList.add('hidden');
    configForm.classList.remove('hidden');
    clearInterval(statusInterval);
    statusInterval = null;
  }

  if (isRecording) {
    showRecordingStatus();
  }

  // Keeps the popup's status in sync if pause/resume/stop happens via
  // another surface (keyboard shortcut, the floating widget) while the
  // popup happens to be open.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'RECORDING_PAUSED' || message.action === 'RECORDING_RESUMED') {
      renderStatus();
    } else if (message.action === 'RECORDING_STARTED' || message.action === 'AREA_RECORDING_STARTED') {
      showRecordingStatus();
    } else if (
      message.action === 'RECORDING_STOPPED' ||
      message.action === 'AREA_RECORDING_STOPPED' ||
      message.action === 'RECORDING_FAILED'
    ) {
      showConfigForm();
    }
  });

  function setStarting(isStarting) {
    startBtn.disabled = isStarting;
    // Update only the label span so the pulsing record dot (and the
    // rest of the button's markup) survives the "Starting…" state.
    const label = startBtn.querySelector('.btn-label');
    if (label) label.textContent = isStarting ? 'Starting…' : 'Start Recording';
  }

  function showStartError(message) {
    startError.textContent = message;
    startError.classList.remove('hidden');
  }

  startBtn.addEventListener('click', async () => {
    startError.classList.add('hidden');
    setStarting(true);

    const config = {
      ...currentConfig(),
      // Screen mode has no page surface to draw on — annotate is
      // area-only, so force it off for screen starts.
      annotate: modeSelect.value === 'area' && annotateToggle.checked
    };

    // Persist the RAW settings (unforced annotate) on start too — the
    // forced value above is only for the recorder; it must not become
    // what the popup remembers for next time.
    persistConfig();

    // Pre-flight camera/mic permission HERE, in this visible popup, for
    // screen mode — the actual requests later come from the hidden
    // offscreen document, whose permission prompt is invisible and was
    // getting dismissed before the user could see it ("Permission
    // dismissed"), silently killing the webcam bubble and mic. Granting
    // here persists for the extension's origin, so the offscreen requests
    // then succeed with no prompt at all. This popup is the extension's
    // own origin, so the permission is granted to "Screen Recorder Pro"
    // itself — not to any website.
    const wantsCamera = config.mode === 'screen' && config.webcam;
    // Mic permission is also pre-flighted when live captions are on:
    // the Web Speech API captures the mic itself, and it needs the same
    // extension-origin mic permission the audio mixer's mic track uses.
    const wantsMic = config.mode === 'screen' && (
      config.audioSource === 'mic' ||
      config.audioSource === 'both' ||
      config.captions
    );
    if (wantsCamera || wantsMic) {
      try {
        // Mic requests carry the same constraints the recorder will use,
        // so the permission granted here matches what actually gets
        // captured later. Mic enhancements are always on, but Chrome's
        // built-in noiseSuppression is deliberately NOT requested — RNNoise
        // does the noise removal, and Chrome's suppression has erased soft
        // voices on some platforms (silent recordings while captions
        // still heard the voice).
        const stream = await navigator.mediaDevices.getUserMedia({
          video: wantsCamera,
          audio: wantsMic
            ? { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 }
            : false
        });
        // The permission is what matters; release the stream immediately
        // (the real camera/mic streams are acquired by the recorder).
        stream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        // Denied/blocked — recording still proceeds without those sources.
        // Tell the user RIGHT HERE why the bubble will be missing, instead
        // of letting it look broken later. NotAllowedError = dismissed /
        // denied permission; anything else = no camera or camera in use.
        if (wantsCamera) {
          showStartError(
            err.name === 'NotAllowedError'
              ? 'Camera permission denied — the webcam bubble will be OFF. Allow the camera for "Screen Recorder Pro" (not the website), then start again.'
              : 'Camera unavailable (blocked or in use) — the webcam bubble will be off.'
          );
        } else if (config.captions) {
          // Mic denied with captions requested — the recording still
          // proceeds (audio source may not even be the mic), captions
          // just won't render. Say so right here instead of a confusing
          // silent absence.
          showStartError(
            err.name === 'NotAllowedError'
              ? 'Microphone permission denied — live captions will be OFF. Allow the microphone for "Screen Recorder Pro", then start again.'
              : 'Microphone unavailable — live captions will be off for this recording.'
          );
        }
      }
    }

    let result;
    try {
      if (config.mode === 'area') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        result = await chrome.runtime.sendMessage({
          action: 'START_AREA_RECORDING',
          config,
          tabId: tab ? tab.id : null
        });
      } else {
        result = await chrome.runtime.sendMessage({ action: 'START_FULL_RECORDING', config });
      }
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    if (result && result.ok) {
      window.close();
    } else {
      setStarting(false);
      showStartError((result && result.error) || "Can't record this page — try a regular webpage tab.");
    }
  });

  pauseBtn.addEventListener('click', async () => {
    const { isPaused } = await chrome.storage.local.get('isPaused');
    chrome.runtime.sendMessage({ action: isPaused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING' });
    // Optimistic UI update; the broadcast listener above reconciles it
    // once the actual pause/resume completes.
    setTimeout(renderStatus, 150);
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_RECORDING' });
    window.close();
  });

  // If a recording previously crashed or the browser was closed mid-
  // recording, storage can be left thinking a recording is active and
  // block every new start. This gives the user a visible way out.
  forceResetBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'RESET_RECORDING_STATE' });
    showConfigForm();
  });

  historyBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
    window.close();
  });
});
