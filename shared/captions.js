// Live-caption engine + canvas drawing helpers.
// Loaded as a plain classic script (no import/export) so it can be used
// as-is via <script src> in offscreen.html / popup.html and via
// chrome.scripting.executeScript "files" for the area-recording content
// script, where all listed files share one global scope.
//
// "Live captions" transcribes the user's microphone speech with the Web
// Speech API (SpeechRecognition) while recording and BURNS the subtitle
// text into the recorded frames: each render loop calls srpDrawCaptions
// after drawing the video, so the captions are baked into the pixels —
// no player subtitle support needed, the text is part of the video
// itself.
//
// Where recognition runs: the offscreen document (screen mode) and the
// selector content script (area mode). Both are regular DOM pages —
// SpeechRecognition historically worked in MV2 hidden background pages
// (the same kind of hidden page an offscreen document is), so the
// recognition engine here is deliberately context-agnostic: it just
// takes a Recognition constructor and calls back with caption text.
//
// Declared with var + an existing-value guard so RE-INJECTION is safe
// (starting a second area recording on the same tab re-runs this file;
// function declarations are redeclaration-safe, which is why only this
// data global needs the guard).

var SRP_CAPTION_LANGUAGES = SRP_CAPTION_LANGUAGES || [
  // English (US) is the only supported spoken language by design — the
  // popup, recorder, and fallbacks all resolve to this one tag, so live
  // captions always transcribe the same dialect and stale configs from
  // earlier multi-language builds are normalized back to it.
  { code: 'en-US', label: 'English (US)' }
];

// Creates the caption engine. opts:
//   Recognition  — constructor for the recognition object (defaults to
//                  window.SpeechRecognition || webkitSpeechRecognition).
//   lang         — BCP-47 tag (e.g. 'en-US').
//   onCaption    — (text) called whenever the caption line changes; text
//                  is '' when there's nothing to show.
//   onError      — (reason) called for FATAL failures (mic denied,
//                  service denied, unsupported) — the caller should keep
//                  recording and tell the user why captions are missing.
//   maxFinalSentences — how many finalized sentences stay on screen
//                  (default 1).
//   finalHoldMs  — how long a finalized sentence stays visible before
//                  fading (default 2000ms — long enough to read, short
//                  enough to track the voice stopping).
//   restartDelayMs — base delay before restarting a dead session
//                  (default 100ms — Chrome ends a continuous session on
//                  silence, so the gap between phrases is kept as short
//                  as possible to stay synced; grows with backoff on
//                  repeated errors).
//   interimStaleMs — how long a partial can sit without updates before
//                  it's locked in as a sentence (default 1000ms — the
//                  anti-freeze watchdog; also promotes an older partial
//                  when a newer utterance starts, killing the old
//                  "stuck run-on" caption).
//   silenceRestartMs — how long a session can go without ANY result
//                  before it's treated as a zombie and force-restarted
//                  (default 6000ms — Chrome can leave a continuous
//                  session silently dead: mic open, no results, and no
//                  onend/onerror ever firing again).
//
// Lifecycle rules (Chrome specifics):
//   - continuous + interimResults give a live partial line; a final
//     result locks the sentence in.
//   - Chrome ends a session on silence (onend) even while continuous, so
//     the engine restarts itself on onend while active, holding the last
//     finalized sentence visible for finalHoldMs so subtitles don't blink
//     out between sentences.
//   - onerror 'not-allowed' / 'service-not-allowed' are fatal (retrying
//     would just fail again — the mic permission isn't there); every
//     other error (no-speech, network, audio-capture, aborted) is
//     transient and triggers a backoff restart.
// Returns { start, stop }.
function srpCreateCaptionEngine(opts) {
  const o = opts || {};
  const Recognition = o.Recognition ||
    (typeof SpeechRecognition !== 'undefined' ? SpeechRecognition :
      (typeof webkitSpeechRecognition !== 'undefined' ? webkitSpeechRecognition : null));
  let lang = o.lang || 'en-US';
  try {
    // Canonicalization catches malformed/stale values from older saved
    // configs and gives Chrome the exact BCP-47 form its service expects.
    lang = Intl.getCanonicalLocales(lang)[0] || 'en-US';
  } catch (e) {
    lang = 'en-US';
  }
  const onCaption = typeof o.onCaption === 'function' ? o.onCaption : function () {};
  const onError = typeof o.onError === 'function' ? o.onError : function () {};
  const maxFinalSentences = o.maxFinalSentences || 1;
  const finalHoldMs = o.finalHoldMs || 2000;
  const restartDelayMs = o.restartDelayMs || 100;

  let rec = null;
  let running = false;   // user asked for captions (start() called)
  let stopped = false;   // stop() called — never restart again
  let fatal = false;     // mic/service denied — never restart again
  let finals = [];       // finalized sentences currently on screen
  // Live partials keyed by their result index. Each entry tracks when it
  // last changed so stale text can't linger: Chrome leaves an older
  // partial unfinalized when new speech starts (and never finalizes it on
  // silence), and gluing every non-final transcript together is what
  // produced the old "stuck run-on" caption — old + new speech welded
  // into one never-clearing line. Instead, a newer result index promotes
  // older partials to finals, and a staleness watchdog promotes anything
  // that stops updating, so the caption always tracks what is being said
  // NOW and can never freeze.
  const interims = new Map(); // result index -> { text, updatedAt }
  let interimTimer = null;    // staleness watchdog
  const interimStaleMs = o.interimStaleMs || 1000; // quiet gap before a partial locks in
  // Session-alive watchdog: Chrome can leave a continuous session
  // silently dead (no results, and onend/onerror never fire), which made
  // captions randomly stop detecting speech until the user gave up.
  // lastActivity is bumped by any result; a periodic probe force-restarts
  // a session that has been silent past silenceRestartMs.
  let lastActivity = 0;
  let silenceTimer = null;
  const silenceRestartMs = o.silenceRestartMs || 6000;
  let holdTimer = null;
  let restartTimer = null;
  let restartCount = 0;

  function latestInterimIndex() {
    let max = -1;
    for (const idx of interims.keys()) if (idx > max) max = idx;
    return max;
  }

  function interimText() {
    const parts = [];
    for (const [, entry] of interims) parts.push(entry.text);
    return parts.join(' ').trim();
  }

  function emit() {
    const parts = finals.slice(-maxFinalSentences);
    const live = interimText();
    const text = (parts.length ? parts.join(' ') : '') + (live ? (parts.length ? ' ' : '') + live : '');
    onCaption(text.trim());
  }

  function clearHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    finals = [];
    if (interims.size === 0) emit();
  }

  // Locks the pending partials in as completed sentences. Used when a
  // newer utterance starts (the older partial is a finished sentence
  // Chrome forgot to finalize), when a session dies (onend/error — the
  // last words must survive the restart, not vanish), and by the
  // staleness watchdog (user stopped mid-sentence — the partial should
  // stay for the hold duration, then clear, instead of freezing forever).
  function promoteInterimsToFinals() {
    if (interims.size === 0) return;
    for (const [, entry] of interims) {
      if (entry && entry.text) {
        finals.push(entry.text);
        if (finals.length > maxFinalSentences) finals.shift();
      }
    }
    interims.clear();
    if (interimTimer) { clearTimeout(interimTimer); interimTimer = null; }
  }

  // Watches the live partial: if it stops updating for interimStaleMs
  // (speech paused/chrome stalled), promote it so it clears via the
  // normal hold instead of staying on screen indefinitely.
  function armInterimWatchdog() {
    if (interimTimer) clearTimeout(interimTimer);
    interimTimer = setTimeout(() => {
      interimTimer = null;
      if (interims.size === 0) return;
      const now = Date.now();
      let promoted = false;
      for (const [idx, entry] of interims) {
        if (now - entry.updatedAt >= interimStaleMs) {
          interims.delete(idx);
          if (entry.text) {
            finals.push(entry.text);
            if (finals.length > maxFinalSentences) finals.shift();
            promoted = true;
          }
        }
      }
      if (promoted) scheduleHold();
      emit();
      if (interims.size > 0) armInterimWatchdog();
    }, interimStaleMs);
  }

  function scheduleHold() {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(clearHold, finalHoldMs);
  }

  // Arms the session-alive probe. Checks every (silenceRestartMs/2) so a
  // zombie session gets restarted ~half a window after it goes silent;
  // a restart is only forced when nothing is already pending and the
  // session is genuinely quiet (no results — live speech keeps
  // lastActivity fresh, so an actively-listening session is never
  // disturbed).
  function armSilenceWatchdog() {
    if (silenceTimer) clearInterval(silenceTimer);
    lastActivity = Date.now();
    silenceTimer = setInterval(() => {
      if (stopped || !running || fatal) return;
      if (restartTimer) return;      // a restart is already on the way
      if (rec && Date.now() - lastActivity > silenceRestartMs) {
        // Lock the pending words in, then swap in a fresh session — the
        // same path silence (onend) uses.
        promoteInterimsToFinals();
        scheduleHold();
        restartCount = 0;
        scheduleRestart(restartDelayMs);
      }
    }, Math.max(250, Math.min(silenceRestartMs / 2, 5000)));
  }

  function scheduleRestart(delay) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(startRecognition, delay);
  }

  function startRecognition() {
    if (stopped || !running || fatal) return;
    if (rec) {
      // Detach handlers BEFORE abort so a stray onend/onerror from the
      // teardown can't schedule a bogus restart.
      try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.abort(); } catch (e) {}
      rec = null;
    }
    let instance;
    try {
      instance = new Recognition();
    } catch (e) {
      fatal = true;
      onError('unsupported');
      return;
    }
    rec = instance;
    instance.lang = lang;
    // Chrome 139+ can prefer an installed on-device pack. Those packs are
    // frequently English-only, which made every other selected language
    // appear dead. Live captions need Chrome's multilingual online speech
    // service, so opt out of local-only processing when this property is
    // available. Older Chrome simply ignores the assignment.
    if ('processLocally' in instance) instance.processLocally = false;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    // A fresh session has no live partial yet — drop any interim left
    // over from the previous session (the on-screen text becomes just
    // the held finals until new speech arrives).
    if (interimTimer) { clearTimeout(interimTimer); interimTimer = null; }
    interims.clear();
    armSilenceWatchdog();
    emit();

    instance.onresult = (event) => {
      lastActivity = Date.now();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res && res[0] ? String(res[0].transcript || '').trim() : '';
        if (res.isFinal) {
          interims.delete(i);
          if (transcript) {
            finals.push(transcript);
            if (finals.length > maxFinalSentences) finals.shift();
          }
          scheduleHold();
        } else if (transcript) {
          // A NEW result index means a fresh utterance started while an
          // older partial was still unfinalized (Chrome leaves it pending
          // on silence). Lock the older partial in as a completed
          // sentence rather than gluing it onto the live line — that
          // glue-up is exactly the old "stuck run-on" caption where old
          // and new speech welded together and never cleared.
          if (interims.size > 0 && i > latestInterimIndex()) {
            promoteInterimsToFinals();
          }
          interims.set(i, { text: transcript, updatedAt: Date.now() });
          armInterimWatchdog();
        }
      }
      emit();
    };

    instance.onerror = (event) => {
      const err = event && event.error;
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'language-not-supported') {
        fatal = true;
        onError(err || 'not-allowed');
        return;
      }
      // Transient (no-speech, network, audio-capture, aborted, …) — the
      // session died, so lock the pending words in before backing off
      // and trying again.
      if (!stopped && running && !fatal) {
        promoteInterimsToFinals();
        scheduleHold();
        restartCount += 1;
        const backoff = Math.min(restartDelayMs * Math.pow(1.6, Math.min(restartCount - 1, 6)), 3000);
        scheduleRestart(backoff);
      }
    };

    instance.onend = () => {
      // Chrome ends a continuous session on silence. Lock any pending
      // partial in (the session is dead — Chrome won't finalize it now),
      // hold the last words briefly, then restart the session to keep
      // listening.
      if (!stopped && running && !fatal) {
        promoteInterimsToFinals();
        scheduleHold();
        restartCount = 0;
        scheduleRestart(restartDelayMs);
      }
    };

    try {
      instance.start();
    } catch (e) {
      // start() throws if the session is already live — treat as
      // transient and retry shortly.
      if (!stopped && running && !fatal) scheduleRestart(restartDelayMs);
    }
  }

  return {
    start() {
      if (running || stopped) return;
      running = true;
      if (!Recognition) {
        fatal = true;
        onError('unsupported');
        return;
      }
      startRecognition();
    },
    stop() {
      stopped = true;
      running = false;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (interimTimer) { clearTimeout(interimTimer); interimTimer = null; }
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      interims.clear();
      if (rec) {
        try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.abort(); } catch (e) {}
        rec = null;
      }
      onCaption('');
    }
  };
}

// Wraps caption text into lines that fit maxWidth (measured in the
// current canvas font). measure is a function (text) => width in px —
// passed in so Node tests can stub it without a real canvas.
function srpWrapCaptionLines(text, measure, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    // Scripts may not use spaces, and URLs/technical tokens may be wider
    // than the whole caption box. Split those by Unicode code point so a
    // single token can never escape across the screen.
    if (measure(word) > maxWidth) {
      if (line) { lines.push(line); line = ''; }
      let part = '';
      for (const char of Array.from(word)) {
        const candidatePart = part + char;
        if (part && measure(candidatePart) > maxWidth) {
          lines.push(part);
          part = char;
        } else {
          part = candidatePart;
        }
      }
      line = part;
      continue;
    }
    const candidate = line ? line + ' ' + word : word;
    if (!line || measure(candidate) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Caption text size presets (chosen in the popup before recording and
// shipped to the recorder in recordConfig.captionsSize). Values are
// fontScale fractions of the frame width, with hard caps so 1080p/4K
// recordings stay subtitle-sized rather than growing into banner text.
var SRP_CAPTION_SIZES = SRP_CAPTION_SIZES || [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' }
];
var SRP_CAPTION_FONT_SCALES = SRP_CAPTION_FONT_SCALES || {
  small: 0.014,
  medium: 0.017,
  large: 0.021
};

var SRP_CAPTION_FONT_CAPS = SRP_CAPTION_FONT_CAPS || {
  small: 30,
  medium: 38,
  large: 46
};

// Draws the caption bar at the bottom center of a recording canvas.
// Callers draw this AFTER the video frame so the text sits on top. A
// no-op when text is empty. opts:
//   maxLines  — how many wrapped lines to show (default 2).
//   size      — 'small' | 'medium' | 'large' (default 'medium'), maps to
//               a fontScale below; explicitly passed fontScale wins.
//   fontScale — font size as a fraction of canvas width (overrides size;
//               medium ≈ 0.017, ~33px on a 1920px frame).
function srpDrawCaptions(ctx, canvasW, canvasH, text, opts) {
  if (!text || !ctx) return;
  const o = opts || {};
  const maxLines = o.maxLines || 2;
  const size = o.size || 'medium';
  const fontScale = o.fontScale ||
    SRP_CAPTION_FONT_SCALES[size] || SRP_CAPTION_FONT_SCALES.medium;
  const fontCap = SRP_CAPTION_FONT_CAPS[size] || SRP_CAPTION_FONT_CAPS.medium;
  const fontSize = Math.max(16, Math.min(fontCap, Math.round(canvasW * fontScale), Math.round(canvasH * 0.042)));
  const font = '600 ' + fontSize + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.save();
  ctx.font = font;
  const measure = (s) => ctx.measureText(s).width;
  const maxTextWidth = Math.round(canvasW * 0.68);
  // Only the newest words belong on screen. This prevents a long-running
  // interim result from turning into a screen-wide paragraph.
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const compactText = words.length > 18 ? words.slice(-18).join(' ') : String(text).trim();
  const wrapped = srpWrapCaptionLines(compactText, measure, maxTextWidth);
  const lines = wrapped.slice(-maxLines);
  if (lines.length === 0) {
    ctx.restore();
    return;
  }
  const lineHeight = Math.round(fontSize * 1.25);
  const padX = Math.round(fontSize * 0.58);
  const padY = Math.round(fontSize * 0.34);
  let widest = 0;
  for (const l of lines) {
    const w = measure(l);
    if (w > widest) widest = w;
  }
  const boxW = Math.min(Math.round(canvasW * 0.74), widest + padX * 2);
  const boxH = lines.length * lineHeight + padY * 2;
  const margin = Math.round(canvasH * 0.035);
  const x = Math.round((canvasW - boxW) / 2);
  const y = Math.round(canvasH - margin - boxH);
  ctx.fillStyle = 'rgba(7, 8, 16, 0.76)';
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, Math.round(fontSize * 0.3));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], canvasW / 2, y + padY + lineHeight * (i + 0.5));
  }
  ctx.restore();
}

// Node test hook — the browser build never defines `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SRP_CAPTION_LANGUAGES,
    SRP_CAPTION_SIZES,
    SRP_CAPTION_FONT_SCALES,
    SRP_CAPTION_FONT_CAPS,
    srpCreateCaptionEngine,
    srpWrapCaptionLines,
    srpDrawCaptions
  };
}
