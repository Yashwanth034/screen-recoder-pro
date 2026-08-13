// Shared resolution/bitrate presets.
// Loaded as a plain classic script (no import/export) so it can be used
// as-is via <script src> in offscreen.html/history.html and via
// chrome.scripting.executeScript "files" for the area-recording content
// script, where all listed files share one global scope.
// Bitrates are tuned for crisp TEXT in screen recordings at the target
// resolution with fast motion. The app's default container is WebM now
// (the popup sets outputFormat 'webm' — see background.js), while this
// library still prefers MP4/H.264 (see srpPickMimeType) when no
// preference is given, which needs roughly half the bitrate of VP8 for
// the same quality; the old numbers (6/12/50 Mbps) looked noticeably
// soft on text-heavy content, which is exactly what a screen recording
// is mostly made of, so they were raised again (15/30/120 Mbps) to keep
// 1080p/4K H.264 sharp. Note Chrome ignores the target for static
// frames (the I-frame gets a fixed budget), so these matter for MOTION
// — scrolling, videos playing inside the recording — where the encoder
// spends up to the ceiling. These are deliberately generous: file size
// is cheap, squinting at blurred text is not. The 4K number matters
// extra because "4K" in screen mode captures a 3840x2160 (or larger
// native-monitor) feed — a high ceiling keeps that upscaled feed
// sharp. Declared with var + an existing-value guard so RE-INJECTION
// is safe: starting a second area recording on the same tab re-runs
// this file via chrome.scripting.executeScript, and redeclaring a
// top-level const/let throws "Identifier ... has already been
// declared" (function declarations are redeclaration-safe, which is
// why only these data globals need the guard). var + || keeps the
// first injection's value and silently no-ops on every later one.
var SRP_QUALITY_PRESETS = SRP_QUALITY_PRESETS || {
  '720p': { width: 1280, height: 720, bitrate: 15000000 },
  '1080p': { width: 1920, height: 1080, bitrate: 30000000 },
  '4k': { width: 3840, height: 2160, bitrate: 120000000 }
};

function srpGetPreset(name) {
  return SRP_QUALITY_PRESETS[name] || SRP_QUALITY_PRESETS['1080p'];
}

// Scales a preset's bitrate to the pixel count actually being encoded.
// This matters most for area mode, whose capture resolution is always
// the native size of whatever region was selected — never the preset's
// own width/height (that's deliberate, to keep the crop math exact; see
// selector.js) — so a flat preset bitrate meant a small selection was
// needlessly oversized and a large one was visibly under-bitrated,
// showing up as compression artifacts especially during fast motion
// (e.g. dragging the webcam bubble).
//
// The ratio is floored at 0.5 — bitrates still scale DOWN (a tiny crop
// doesn't need 1080p's full bitrate) but never below half the preset.
// Without any floor, the preset ratios exactly cancel the pixel ratio —
// "1080p" on a 1080p monitor computed to the same bitrate as "4K" on
// that same monitor (1920*1080 / 3840*2160 is precisely the 4x inverse
// of the bitrate ratio), so the Quality dropdown did almost nothing on
// most real displays and text never looked sharper. The 0.5 floor keeps
// the choice meaningful (1080p→20 Mbps, 4K→40 Mbps on a 1080p monitor)
// without ballooning small selections to full-size files.
// --- MediaRecorder container selection (MP4 first) ---
//
// MP4 is preferred because the resulting file plays in any player/editor
// (Windows, phones, CapCut, Premiere) without conversion — the #1 reason
// browser recordings get rejected elsewhere. The audio codec inside the
// MP4 depends on the platform: macOS/Windows Chrome can encode AAC, but
// Linux Chrome typically CANNOT (isTypeSupported reports mp4a.40.2
// unsupported) — it does support H.264 video + Opus audio in MP4
// instead. Opus is higher-quality than AAC and plays on Windows/Android/
// VLC/most editors (only iPhones/iMovie lack Opus). The candidate list
// therefore tries every mp4 combo the browser reports, strictly gated on
// isTypeSupported, before falling back to WebM exactly as before. VP9 is
// avoided as a WebM fallback: on some systems (notably Linux) recording
// a raw display stream with VP9 can silently produce zero bytes and stop
// immediately. VP8 is mature and bulletproof everywhere, so it's the
// WebM fallback of choice.

// Preference-ordered list of mime types the current browser reports it
// can record, best first. rec is injectable for tests; it defaults to
// the real global MediaRecorder (absent in non-browser contexts).
// preferWebm is the popup's manual escape hatch: it excludes MP4
// entirely so a user who hits any MP4 quirk on their machine can force
// the battle-tested WebM path.
function srpMimeCandidates(rec, preferWebm) {
  const R = rec || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
  const out = [];
  if (R && typeof R.isTypeSupported === 'function') {
    const candidates = preferWebm
      ? ['video/webm;codecs=vp8', 'video/webm;codecs=vp9']
      : [
          // H.264 + AAC — the most universally playable MP4 (best on
          // Apple devices), available on macOS/Windows Chrome. HIGH
          // profile (avc1.64001E) is requested FIRST: CABAC entropy
          // coding plus the 8x8 transform make text edges noticeably
          // crisper than Baseline (avc1.42E01E) at the same bitrate —
          // Chrome encodes with exactly the profile in the string
          // (verified: High @ level 4.2 on Linux) — and every modern
          // player/editor handles High. Baseline stays as the fallback
          // for machines that only report it.
          'video/mp4;codecs=avc1.64001E,mp4a.40.2',
          'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
          // H.264 + Opus — what Linux Chrome can actually record (AAC
          // encoding is unavailable there). Same High-profile-first
          // ordering; plays on Windows/Android/VLC/most editors.
          'video/mp4;codecs=avc1.64001E,opus',
          'video/mp4;codecs=avc1.42E01E,opus',
          // AV1 + Opus in MP4 — last MP4 resort before WebM.
          'video/mp4;codecs=av01.0.08M.08,opus',
          'video/webm;codecs=vp8',
          'video/webm;codecs=vp9'
        ];
    for (const m of candidates) {
      try {
        if (R.isTypeSupported(m)) out.push(m);
      } catch (e) {
        // Malformed codec string — skip it.
      }
    }
  }
  if (out.length === 0) out.push('video/webm');
  return out;
}

// The single best mimeType for a new recording on this browser.
function srpPickMimeType(rec, preferWebm) {
  return srpMimeCandidates(rec, preferWebm)[0];
}

// True when a mime string is an MP4 (ISOBMFF) container.
function srpIsMp4Mime(mime) {
  return typeof mime === 'string' && mime.indexOf('video/mp4') === 0;
}

// File extension matching a recording's container — callers save real
// MP4 files as .mp4 instead of mislabeled .webm.
function srpMimeExtension(mime) {
  return srpIsMp4Mime(mime) ? 'mp4' : 'webm';
}

// The pixel alignment a recorded frame must have for the container being
// recorded. H.264 (MP4) encodes on 16x16 macroblocks: Chrome pads the
// frame to that boundary and the MP4 container does NOT crop the padding
// back off, so the padded rows (edge-replicated by the encoder) play
// back as a visible duplicated/green strip at the BOTTOM of the video —
// the "double bottom" artifact, which is exactly why the same recording
// looks clean in WebM (VP8/VP9 are cropped correctly and only need even
// dimensions). Canvas pipelines must round width and height DOWN to a
// multiple of the returned unit so the encoder never pads anything.
// Accepts the resolved mimeType string or a preferWebm boolean.
function srpAlignUnit(mimeOrPreferWebm) {
  const isMp4 = typeof mimeOrPreferWebm === 'string'
    ? srpIsMp4Mime(mimeOrPreferWebm)
    : !mimeOrPreferWebm;
  return isMp4 ? 16 : 2;
}

// Computes the canvas size a recording should use for a capture whose
// DECODED frames are realW x realH, given the container's alignment unit
// (16 for H.264/MP4, 2 for VP8/VP9/WebM — see srpAlignUnit). Two
// strategies:
//
//   PAD — captures within one macroblock row of the standard 16:9 frame
//   (a full screen minus taskbar, e.g. 1920x1080) are padded UP to the
//   aligned 16:9 height (1920x1088) with the page drawn at NATIVE 1:1
//   pixels and black below. The bar is at most 16px — invisible on
//   playback — and the file keeps a standard aspect ratio, so players
//   render it ~1:1 instead of stretching the odd height ~1.15x to fill
//   the screen (that upscale is exactly what makes recorded text look
//   enlarged and blurred). 1920x1088 (not 1080) because 1080 is not a
//   multiple of 16 and H.264 would pad it anyway (see srpAlignUnit).
//
//   CROP — everything else: round the frame DOWN to the alignment unit
//   (loses at most unit-1 px) so the encoder has nothing to pad. Used
//   for window-sized captures (a maximized window is 1920x1017 or
//   1920x942 on 1080p screens — padding those would BAKE a big black
//   bar into the video) and small/tall windows (which would get a huge
//   black bar instead).
//
// Returns { w, h, drawW, drawH, pad } where w x h is the canvas the
// caller must create and drawW x drawH is how the source should be
// drawn into it: native 1:1 in the pad case (that's what keeps text
// pixel-perfect) or scaled to fill in the crop case.
function srpRecordingCanvasSize(realW, realH, alignUnit) {
  const unit = alignUnit || 2;
  const w = realW - (realW % unit);
  // Standard 16:9 height for this width, rounded UP to the unit.
  const targetH = Math.ceil((realW * 9) / 16 / unit) * unit;
  // Pad only when the capture is essentially the full 16:9 frame — its
  // height within one H.264 macroblock row (16px) of the target, so the
  // pad bar is at most 16px and invisible on playback. Anything shorter
  // is a window-sized capture; padding it would put a big black bar at
  // the bottom of the recording, so those crop to their aligned size
  // instead (no black screen, at most unit-1 px lost).
  if (realH < targetH && realH >= targetH - 16) {
    return { w, h: targetH, drawW: Math.min(realW, w), drawH: realH, pad: true };
  }
  const h = realH - (realH % unit);
  return { w, h, drawW: w, drawH: h, pad: false };
}

// Builds the MediaRecorder with the best available container, walking
// down the candidate list if construction throws (isTypeSupported has
// been known to lie at the edges). Returns { recorder, mimeType } so
// callers can label blobs, filenames, history entries and recovery
// checkpoints with the format that was actually recorded. preferWebm
// passes through to srpMimeCandidates (the popup's manual WebM escape
// hatch).
function srpCreateMediaRecorder(stream, bitrate, rec, preferWebm) {
  const R = rec || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
  const candidates = srpMimeCandidates(R, preferWebm);
  for (const mimeType of candidates) {
    try {
      return { recorder: new R(stream, { mimeType, videoBitsPerSecond: bitrate }), mimeType };
    } catch (e) {
      // Unsupported in practice — try the next candidate.
    }
  }
  // Every candidate threw (shouldn't happen — the last one is plain
  // 'video/webm'). Let the browser pick its own default.
  const mimeType = candidates[candidates.length - 1];
  return { recorder: new R(stream, { videoBitsPerSecond: bitrate }), mimeType };
}

function srpScaledBitrate(qualityName, actualWidth, actualHeight) {
  const preset = srpGetPreset(qualityName);
  const referencePixels = preset.width * preset.height;
  const actualPixels = Math.max(1, actualWidth * actualHeight);
  // Floor at 0.5 so the chosen quality always matters (see above); scale
  // up freely when the capture is larger than the preset (e.g. a 4K
  // monitor with the 1080p preset gets 4x the 1080p bitrate).
  const ratio = Math.max(actualPixels / referencePixels, 0.5);
  const scaled = Math.round(preset.bitrate * ratio);
  // Clamped so a tiny selection doesn't collapse to an unwatchable
  // bitrate and a very large one doesn't balloon the file size for
  // marginal visual return. (With the 0.5 floor, the low clamp only
  // ever binds for the smallest captures.)
  return Math.min(Math.max(scaled, 2500000), 120000000);
}

// --- Blank-frame (blue-screen) detection helpers ---
//
// Shared by the watchdogs in offscreen.js and selector.js, which detect
// when Chrome's hardware-accelerated video decode renders fullscreen
// video through a GPU overlay that getDisplayMedia can't capture — the
// captured frames come out as one solid color (usually blue). Both
// contexts load this file, so the thresholds and math live in one place.
//
// A frame counts as "blank" when its luminance variance is near zero AND
// the mean sits between these extremes: genuinely black (mean below the
// min) and genuinely white (mean above the max) content are legitimately
// recordable, so they never trip the alarm — the classic dead captures
// (blue/black-ish frames) fall in the middle.
var SRP_BLANK_VARIANCE = SRP_BLANK_VARIANCE || 8;
var SRP_BLANK_MIN_MEAN = SRP_BLANK_MIN_MEAN || 3;
var SRP_BLANK_MAX_MEAN = SRP_BLANK_MAX_MEAN || 210;

// Computes { mean, variance } of luminance for a region of a canvas —
// the signal the blue-screen watchdog keys on. Returns null if the read
// fails (callers pass small regions or the small preview canvas, so this
// is cheap).
function srpFrameStats(ctx, x, y, w, h) {
  try {
    const img = ctx.getImageData(x, y, w, h).data;
    let sum = 0;
    let sumSq = 0;
    const px = img.length / 4;
    for (let i = 0; i < img.length; i += 4) {
      const lum = 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
      sum += lum;
      sumSq += lum * lum;
    }
    const mean = sum / px;
    return { mean, variance: Math.max(0, sumSq / px - mean * mean) };
  } catch (e) {
    return null;
  }
}

// Node test hook — the browser build never defines `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    srpGetPreset,
    srpScaledBitrate,
    srpMimeCandidates,
    srpPickMimeType,
    srpIsMp4Mime,
    srpMimeExtension,
    srpAlignUnit,
    srpRecordingCanvasSize,
    srpCreateMediaRecorder,
    SRP_QUALITY_PRESETS
  };
}
