// Pure math for the Recording History video editor (trim / cut / crop).
//
// No DOM, no chrome APIs — unit-tested in tests/editor-math.test.js.
// Loaded via <script src> in history/editor.html before editor.js, and
// via require() in the tests. All functions are pure: they take inputs
// and return new values, never mutating their arguments.
//
// The editor model: the SOURCE video (one recording) is cut into an
// ordered list of CLIPS, each { start, end } — seconds into the source.
// Clip order IS output order, so trimming a clip, cutting middle
// sections (split + delete) and reordering clips all operate on this
// list, and the OUTPUT timeline is simply the clips concatenated. Crop
// is a normalized (0..1) rectangle of the source frame.

// Validates/clamps an ordered clip list against the source duration.
// Drops malformed or sub-frame clips, clamps edges into [0, duration],
// and falls back to the full source when nothing usable remains.
// Returns a fresh array; never mutates the input.
function srpSanitizeClips(clips, sourceDuration) {
  const dur = Math.max(0, sourceDuration || 0);
  if (dur <= 0) return [];
  const out = [];
  for (const c of clips || []) {
    if (!c || typeof c.start !== 'number' || typeof c.end !== 'number') continue;
    if (!isFinite(c.start) || !isFinite(c.end)) continue;
    const s = Math.max(0, Math.min(c.start, dur));
    const e = Math.max(0, Math.min(c.end, dur));
    if (e - s < 0.05) continue; // sub-frame slice — meaningless
    out.push({ start: s, end: e });
  }
  if (out.length === 0) out.push({ start: 0, end: dur });
  return out;
}

// Total OUTPUT duration = sum of clip lengths.
function srpTotalDuration(clips) {
  return (clips || []).reduce((sum, c) => sum + (c.end - c.start), 0);
}

// Cumulative output time just before clips[index] begins.
function srpCumulative(clips, index) {
  let sum = 0;
  for (let i = 0; i < Math.min(index, clips.length); i++) sum += clips[i].end - clips[i].start;
  return sum;
}

// Maps an OUTPUT time (seconds into the edited sequence) to the source
// position it shows. Returns { clipIndex, sourceTime } or null when the
// output time is past the end. An output time exactly ON a clip
// boundary resolves to the START of the next clip (a scrub landing on a
// cut shows the first frame after the cut).
function srpOutputToSource(outputTime, clips) {
  let t = outputTime;
  for (let i = 0; i < clips.length; i++) {
    const len = clips[i].end - clips[i].start;
    if (t < len) return { clipIndex: i, sourceTime: clips[i].start + t };
    t -= len;
  }
  return null;
}

// Which clip index an output time falls inside (clamps to the last clip
// at/past the end). Returns -1 for an empty clip list.
function srpClipIndexAt(outputTime, clips) {
  if (!clips.length) return -1;
  let t = outputTime;
  for (let i = 0; i < clips.length; i++) {
    const len = clips[i].end - clips[i].start;
    if (t < len || i === clips.length - 1) return i;
    t -= len;
  }
  return clips.length - 1;
}

// Splits the clip at clips[index] at the given OUTPUT time. Returns a
// new array, or the original array unchanged when the split point is
// not strictly inside the clip (needs a usable slice on both sides).
// The two pieces keep every field of the original (sourceId, volume,
// mute, …) and get distinct ids (c.id + '-L' / '-R') so the editor can
// select and operate on either piece independently — the older
// bare-{start,end} output silently dropped those fields and broke
// preview/export after a split.
function srpSplitAt(clips, index, outputTime) {
  if (index < 0 || index >= clips.length) return clips;
  const c = clips[index];
  const len = c.end - c.start;
  const local = outputTime - srpCumulative(clips, index); // seconds into the clip
  if (local < 0.05 || local > len - 0.05) return clips;
  const next = clips.slice();
  next.splice(index, 1,
    { ...c, id: c.id ? c.id + '-L' : c.id, start: c.start, end: c.start + local },
    { ...c, id: c.id ? c.id + '-R' : c.id, start: c.start + local, end: c.end }
  );
  return next;
}

// Removes the clip at index. Returns a new array; a single-clip list is
// returned unchanged (the output must never be empty).
function srpRemoveClip(clips, index) {
  if (index < 0 || index >= clips.length || clips.length <= 1) return clips;
  return clips.filter((_, i) => i !== index);
}

// Trims one edge of a clip by an OUTPUT-time delta applied to the edge.
// dir: -1 trims the START edge (moves it forward), +1 trims the END
// edge (moves it backward). Returns a new array; out-of-range trims are
// clamped so every clip keeps at least MIN seconds.
function srpTrimClip(clips, index, dir, deltaSeconds, minLen) {
  if (index < 0 || index >= clips.length) return clips;
  const min = Math.max(0.05, minLen || 0.25);
  const c = clips[index];
  const len = c.end - c.start;
  if (len - deltaSeconds < min) return clips;
  const next = clips.slice();
  if (dir < 0) {
    next[index] = { start: c.start + deltaSeconds, end: c.end };
  } else {
    next[index] = { start: c.start, end: c.end - deltaSeconds };
  }
  return next;
}

// Clamps a normalized (0..1) crop rectangle so it stays inside the
// frame and never collapses to nothing. Returns null when the result
// would cover essentially the whole frame (i.e. no crop), and null for
// falsy input — callers treat null as "no crop".
function srpClampCrop(crop) {
  if (!crop) return null;
  const MIN = 0.02;
  let x = isFinite(crop.x) ? crop.x : 0;
  let y = isFinite(crop.y) ? crop.y : 0;
  let w = isFinite(crop.w) ? crop.w : 1;
  let h = isFinite(crop.h) ? crop.h : 1;
  // Clamp the origin first, THEN the size against the visible frame — a
  // rect dragged partially off-frame snaps to the on-screen portion.
  x = Math.max(0, Math.min(1 - MIN, x));
  y = Math.max(0, Math.min(1 - MIN, y));
  w = Math.max(MIN, Math.min(1 - x, w));
  h = Math.max(MIN, Math.min(1 - y, h));
  if (w >= 1 - 1e-4 && h >= 1 - 1e-4) return null; // whole frame — no-op
  // Round to 6 decimals so repeated drag/export math stays deterministic
  // (normalized coords — this is far finer than a pixel at any size).
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

// mm:ss — for the editor's time displays.
function srpFormatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Node test hook — the browser build never defines `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    srpSanitizeClips,
    srpTotalDuration,
    srpCumulative,
    srpOutputToSource,
    srpClipIndexAt,
    srpSplitAt,
    srpRemoveClip,
    srpTrimClip,
    srpClampCrop,
    srpFormatTime
  };
}
