// Recording History video editor.
//
// Loads one recording from IndexedDB and turns it into a small multitrack
// editor:
//   - VIDEO track: cut the recording into clips (split / delete / trim /
//     reorder), and ADD clips from other video files. Each clip has its
//     own volume + mute.
//   - AUDIO track: import music / voice-over files and place them over
//     the video at any output position, each with its own volume.
//   - CROP: draw a rectangle on the preview; applied at export.
//   - EXPORT: re-encodes through a canvas pipeline with everything mixed
//     through Web Audio. Two fast paths keep it quick: no edits at all →
//     the original file is copied instantly; a lower export resolution
//     drastically cuts encode time for big captures.
//
// Pure math lives in ../shared/editorMath.js (unit-tested); this file is
// the DOM glue around it.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const previewLayer = $('previewLayer');
  const stage = $('stage');
  const stageLoading = $('stageLoading');
  const stageError = $('stageError');
  const playBtn = $('playBtn');
  const timeCurrent = $('timeCurrent');
  const timeTotal = $('timeTotal');
  const clipCountEl = $('clipCount');
  const timeline = $('timeline');
  const ruler = $('ruler');
  const videoClipsLayer = $('videoClipsLayer');
  const audioClipsLayer = $('audioClipsLayer');
  const playheadEl = $('playhead');
  const splitBtn = $('splitBtn');
  const deleteBtn = $('deleteBtn');
  const undoBtn = $('undoBtn');
  const redoBtn = $('redoBtn');
  const resetBtn = $('resetBtn');
  const addVideoBtn = $('addVideoBtn');
  const addAudioBtn = $('addAudioBtn');
  const videoFileInput = $('videoFileInput');
  const audioFileInput = $('audioFileInput');
  const cropToggleBtn = $('cropToggleBtn');
  const cropClearBtn = $('cropClearBtn');
  const cropOverlay = $('cropOverlay');
  const cropRect = $('cropRect');
  const cropDims = $('cropDims');
  const loopBtn = $('loopBtn');
  const cropPresets = $('cropPresets');
  const clipAudioControls = $('clipAudioControls');
  const clipVolume = $('clipVolume');
  const clipVolumeVal = $('clipVolumeVal');
  const clipMute = $('clipMute');
  const audioClipControls = $('audioClipControls');
  const audioClipVolume = $('audioClipVolume');
  const audioClipVolumeVal = $('audioClipVolumeVal');
  const audioClipDeleteBtn = $('audioClipDeleteBtn');
  const clipAudioNote = $('clipAudioNote');
  const exportBtn = $('exportBtn');
  const exportSummary = $('exportSummary');
  const exportProgressWrap = $('exportProgressWrap');
  const exportProgressFill = $('exportProgressFill');
  const exportProgressLabel = $('exportProgressLabel');
  const cancelExportBtn = $('cancelExportBtn');
  const exportResSelect = $('exportResSelect');
  const noAudioChk = $('noAudioChk');
  const fileInfo = $('fileInfo');

  const MIN_CLIP = 0.25;

  const state = {
    record: null,
    mainDuration: 0,
    sources: new Map(),   // id -> { id, name, url, mimeType, duration, kind: 'video'|'audio' }
    videoClips: [],       // { id, sourceId, start, end, volume, muted, audioExtracted } (start/end = SOURCE seconds)
    audioClips: [],       // { id, sourceId, start, end, volume }         (start/end = OUTPUT seconds)
    playhead: 0,
    curIndex: 0,
    crop: null,
    cropAspect: null,
    cropMode: false,
    playing: false,
    exporting: false,
    loop: false,
    undoStack: [],
    redoStack: [],
    waveforms: new Map(), // sourceId -> Float32Array of peak samples (0..1)
    selectedVideoId: null,
    selectedAudioId: null
  };

  // The recording's own audio is represented by a dedicated AUDIO clip
  // on the A lane ("extracted audio track") so it can be split, trimmed,
  // moved, muted or deleted independently of the video. The main video
  // clip is then pure picture: its inherent audio is forced off so the
  // extracted clip is the single source of that sound (otherwise it
  // would play twice). Added video files keep their own audio (volume /
  // mute controls still apply to them).
  const MAIN_AUDIO_CLIP_ID = 'ac-main';

  // Preview: one video element per source, only the active one visible.
  const previewEls = new Map();        // sourceId -> <video>
  const previewAudioEls = new Map();   // audioClipId -> <audio>
  // Export: one hidden element + gain node per source / audio clip.
  const exportEls = new Map();         // sourceId -> { el, gain }
  const exportAudioEls = new Map();    // audioClipId -> { el, gain, didStart }
  let audioCtx = null;
  let audioDest = null;
  let masterGain = null;
  let exportCtx = null;

  // ---------- Small helpers ----------

  function formatSize(bytes) {
    if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function totalDur() {
    return srpTotalDuration(state.videoClips);
  }

  function shortName(name, max = 14) {
    const base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
    return base.length > max ? base.slice(0, max - 1) + '…' : base;
  }

  function snapshotState() {
    return {
      videoClips: state.videoClips.map((c) => ({ ...c })),
      audioClips: state.audioClips.map((a) => ({ ...a })),
      crop: state.crop ? { ...state.crop } : null
    };
  }

  function restoreSnapshot(s) {
    state.videoClips = s.videoClips;
    state.audioClips = s.audioClips;
    state.crop = s.crop;
    renderTimeline();
    renderCropOverlay();
    updateSelectionUI();
    updateExportSummary();
    updateUndoBtn();
  }

  // Pushes a GIVEN snapshot (usually one captured BEFORE a mutation).
  // Drag gestures capture `before` on pointerdown and push it on release,
  // so Undo restores the pre-drag state — snapshotting the post-drag
  // state instead made Undo a silent no-op for every drag.
  function pushUndoSnapshot(snap) {
    state.undoStack.push(snap);
    state.redoStack.length = 0;
    if (state.undoStack.length > 50) state.undoStack.shift();
    updateUndoBtn();
  }

  function pushUndo() {
    pushUndoSnapshot(snapshotState());
  }

  function undo() {
    const s = state.undoStack.pop();
    if (!s) return;
    state.redoStack.push(snapshotState());
    restoreSnapshot(s);
  }

  function redo() {
    const s = state.redoStack.pop();
    if (!s) return;
    state.undoStack.push(snapshotState());
    restoreSnapshot(s);
  }

  function updateUndoBtn() {
    undoBtn.disabled = state.exporting || state.undoStack.length === 0;
    redoBtn.disabled = state.exporting || state.redoStack.length === 0;
  }

  // ---------- Init ----------

  async function init() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) return showLoadError('No recording selected.');
    const record = await SRPDB.getRecording(id).catch(() => null);
    if (!record || !record.buffer) return showLoadError('Recording not found — it may have been deleted.');
    state.record = record;
    document.title = 'Editing recording — Screen Recorder Pro';
    const ext = srpMimeExtension(record.mimeType).toUpperCase();
    fileInfo.textContent = `${ext} · ${formatSize(record.size)}`;

    const url = URL.createObjectURL(new Blob([record.buffer], { type: record.mimeType || 'video/webm' }));
    state.sources.set('main', {
      id: 'main',
      name: 'Main recording',
      url,
      mimeType: record.mimeType || 'video/webm',
      duration: record.duration || 0,
      kind: 'video',
      // Retain the raw bytes so the audio track can be decoded for the
      // waveform. Copying the ArrayBuffer keeps the IDB record intact.
      rawData: record.buffer.slice(0)
    });

    const meta = await new Promise((resolve) => {
      const probe = document.createElement('video');
      probe.preload = 'auto';
      probe.src = url;
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          if (isFinite(probe.duration) && probe.duration > 0) {
            state.sources.get('main').duration = probe.duration;
          }
          resolve(true);
        }
      };
      const failed = () => {
        if (settled) return;
        settled = true;
        showLoadError("Can't play this recording in the editor.");
        resolve(false);
      };
      probe.addEventListener('loadedmetadata', done, { once: true });
      probe.addEventListener('error', failed, { once: true });
      setTimeout(done, 8000);
    });
    if (!meta) return;

    stageLoading.classList.add('hidden');
    state.mainDuration = state.sources.get('main').duration || 1;
    state.videoClips = [{
      id: 'vc-main',
      sourceId: 'main',
      start: 0,
      end: state.mainDuration,
      volume: 1,
      muted: false,
      // The recording's audio lives on the extracted A-lane clip; the
      // video clip itself is picture-only (its own audio forced off).
      audioExtracted: true
    }];
    // Extracted audio track: the main recording's sound as an
    // independently editable AUDIO clip spanning the full output.
    state.audioClips = [{
      id: MAIN_AUDIO_CLIP_ID,
      sourceId: 'main',
      start: 0,
      end: state.mainDuration,
      volume: 1
    }];

    stage.style.aspectRatio = '16 / 9';
    // Anchor the stage aspect to the real frame once the main video loads.
    ensurePreviewEl('main');
    const mainEl = previewEls.get('main');
    const fixAspect = () => {
      if (mainEl.videoWidth && mainEl.videoHeight) {
        stage.style.aspectRatio = `${mainEl.videoWidth} / ${mainEl.videoHeight}`;
      }
    };
    mainEl.addEventListener('loadedmetadata', fixAspect, { once: true });
    mainEl.addEventListener('loadeddata', fixAspect);

    renderTimeline();
    renderCropOverlay();
    updateExportSummary();
    // Kick off the audio-waveform decode (best-effort; renders when ready).
    ensureWaveform('main').then(() => renderTimeline()).catch(() => {});
  }

  function showLoadError(msg) {
    stageLoading.classList.add('hidden');
    stageError.textContent = msg;
    stageError.classList.remove('hidden');
  }

  // ---------- Preview elements ----------

  function ensurePreviewEl(sourceId) {
    let el = previewEls.get(sourceId);
    if (el) return el;
    const src = state.sources.get(sourceId);
    el = document.createElement('video');
    el.playsInline = true;
    el.preload = 'auto';
    el.muted = false;
    el.src = src.url;
    previewLayer.appendChild(el);
    previewEls.set(sourceId, el);
    return el;
  }

  function ensurePreviewAudioEl(audioClipId) {
    let el = previewAudioEls.get(audioClipId);
    if (el) return el;
    const ac = state.audioClips.find((a) => a.id === audioClipId);
    if (!ac) return null;
    const src = state.sources.get(ac.sourceId);
    el = document.createElement('audio');
    el.preload = 'auto';
    el.src = src.url;
    document.body.appendChild(el);
    previewAudioEls.set(audioClipId, el);
    return el;
  }

  // Shows the video clip at idx (paused) on its source's element. Setting
  // currentTime before the element has metadata silently does nothing, so
  // a pending target is parked in dataset and applied by the loop.
  function showClipAt(idx, sourceTime) {
    const clip = state.videoClips[idx];
    if (!clip) return;
    state.curIndex = idx;
    previewEls.forEach((e) => {
      e.pause();
      e.classList.remove('active');
    });
    const el = ensurePreviewEl(clip.sourceId);
    el.classList.add('active');
    // Picture-only clips (the main recording, whose audio is on the
    // extracted A-lane clip) never play their inherent audio — otherwise
    // the sound would double up with the audio track.
    el.volume = clip.muted || clip.audioExtracted ? 0 : clip.volume;
    if (typeof sourceTime === 'number') {
      if (el.readyState >= 1) {
        el.currentTime = Math.max(0, Math.min(sourceTime, Math.max(0, clip.end - 0.001)));
      } else {
        el.dataset.pendingSeek = String(Math.max(0, Math.min(sourceTime, Math.max(0, clip.end - 0.001))));
      }
    }
  }

  function activatePreviewClip(idx) {
    showClipAt(idx, state.videoClips[idx] ? state.videoClips[idx].start : 0);
    const el = previewEls.get(state.videoClips[idx] ? state.videoClips[idx].sourceId : 'main');
    if (el) el.play().catch(() => {});
  }

  // ---------- Timeline rendering ----------

  function renderRuler() {
    ruler.innerHTML = '';
    const total = totalDur();
    const TICKS = 10;
    for (let i = 0; i <= TICKS; i++) {
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = `${(i / TICKS) * 100}%`;
      const label = document.createElement('span');
      label.className = 'ruler-label';
      label.textContent = srpFormatTime((total * i) / TICKS);
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
  }

  function renderTimeline() {
    const total = totalDur();
    renderRuler();

    videoClipsLayer.innerHTML = '';
    state.videoClips.forEach((c, i) => {
      const left = total > 0 ? (srpCumulative(state.videoClips, i) / total) * 100 : 0;
      const width = total > 0 ? ((c.end - c.start) / total) * 100 : 0;
      const el = document.createElement('div');
      el.className = 'clip video-clip';
      if (c.muted || c.volume < 0.999) el.classList.add('muted');
      el.dataset.index = String(i);
      el.dataset.id = c.id;
      el.style.left = `${left}%`;
      el.style.width = `${Math.max(0.8, width)}%`;
      const src = state.sources.get(c.sourceId);
      const inner = document.createElement('div');
      inner.className = 'clip-inner';
      inner.textContent = `${srpFormatTime(c.end - c.start)}${src && src.id !== 'main' ? ' · ' + shortName(src.name) : ''}`;
      const lh = document.createElement('span');
      lh.className = 'clip-handle left';
      const rh = document.createElement('span');
      rh.className = 'clip-handle right';
      el.appendChild(lh);
      el.appendChild(inner);
      el.appendChild(rh);
      videoClipsLayer.appendChild(el);
    });

    audioClipsLayer.innerHTML = '';
    state.audioClips.forEach((a, i) => {
      const left = total > 0 ? (a.start / total) * 100 : 0;
      const width = total > 0 ? ((a.end - a.start) / total) * 100 : 0;
      const el = document.createElement('div');
      el.className = 'clip audio-clip';
      el.dataset.index = String(i);
      el.dataset.id = a.id;
      el.style.left = `${left}%`;
      el.style.width = `${Math.max(0.8, width)}%`;
      const src = state.sources.get(a.sourceId);
      // Audio-clip name: the extracted main track gets a clear label
      // instead of the generic source name.
      const label = a.id === MAIN_AUDIO_CLIP_ID ? 'Recording audio' : (src ? src.name : 'audio');
      const inner = document.createElement('div');
      inner.className = 'clip-inner';
      inner.textContent = `${shortName(label)} · ${srpFormatTime(a.end - a.start)}`;
      const lh = document.createElement('span');
      lh.className = 'clip-handle left';
      const rh = document.createElement('span');
      rh.className = 'clip-handle right';
      el.appendChild(lh);
      el.appendChild(inner);
      el.appendChild(rh);
      // Waveform backdrop (drawn from the source's decoded peaks, scaled
      // to the portion of the clip shown).
      const peaks = state.waveforms.get(a.sourceId);
      if (peaks) {
        const canvas = document.createElement('canvas');
        canvas.className = 'audio-wave';
        el.appendChild(canvas);
        requestAnimationFrame(() => drawWaveform(canvas, peaks, a, width));
      }
      audioClipsLayer.appendChild(el);
    });

    updatePlayheadUI();
  }

  // Draws a source's peak array into an audio-clip canvas, showing the
  // source window the clip currently covers (audio clips play their
  // source from offset 0 when the output hits a.start, so the window is
  // [0, end-start] of the source). Degrades gracefully when the canvas
  // has no size yet (deferred via requestAnimationFrame).
  function drawWaveform(canvas, peaks, clip, widthPct) {
    const w = Math.max(8, Math.round(canvas.clientWidth || 100));
    const h = Math.max(8, canvas.clientHeight || 30);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const srcDur = srcDuration(clip.sourceId) || 1;
    const windowLen = Math.min(clip.end - clip.start, srcDur);
    const count = Math.max(2, Math.floor(peaks.length * (windowLen / srcDur)));
    const mid = h / 2;
    const barW = Math.max(1, w / count);
    // Audio clips play their source from offset 0 when the output reaches
    // a.start, so the visible window always starts at source 0.
    for (let i = 0; i < count; i++) {
      const v = peaks[Math.min(peaks.length - 1, i)] || 0;
      const bh = Math.max(1, v * h * 0.9);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(i * barW, mid - bh / 2, Math.max(1, barW - 0.5), bh);
    }
  }

  function updatePlayheadUI() {
    const total = totalDur();
    state.playhead = Math.min(state.playhead, Math.max(0, total));
    playheadEl.style.left = `${total > 0 ? (state.playhead / total) * 100 : 0}%`;
    timeCurrent.textContent = srpFormatTime(state.playhead);
    timeTotal.textContent = srpFormatTime(total);
    const vn = state.videoClips.length;
    const an = state.audioClips.length;
    clipCountEl.textContent = an > 0 ? `${vn} video · ${an} audio` : `${vn} clip${vn === 1 ? '' : 's'}`;
    splitBtn.disabled = state.exporting || !canSplit();
    // Delete stays enabled while any clip can be removed: a deletable
    // video clip exists, or an audio clip is selected (the extracted
    // main audio track can be deleted even with a single video clip).
    deleteBtn.disabled = state.exporting ||
      !(state.selectedAudioId || state.videoClips.length > 1);
    const cur = state.videoClips[state.curIndex];
    videoClipsLayer.querySelectorAll('.clip').forEach((el) => {
      el.classList.toggle('current', !!cur && el.dataset.id === cur.id);
      el.classList.toggle('selected', el.dataset.id === state.selectedVideoId);
    });
    audioClipsLayer.querySelectorAll('.clip').forEach((el) => {
      el.classList.toggle('selected', el.dataset.id === state.selectedAudioId);
    });
  }

  // Split is enabled when the playhead sits strictly inside the SELECTED
  // clip (audio or video), or — with nothing selected — inside the video
  // clip under the playhead.
  function canSplit() {
    const total = totalDur();
    if (state.playhead <= 0 || state.playhead >= total) return false;
    if (state.selectedAudioId) {
      const ac = state.audioClips.find((a) => a.id === state.selectedAudioId);
      return !!ac &&
        state.playhead > ac.start + MIN_CLIP + 0.01 &&
        state.playhead < ac.end - MIN_CLIP - 0.01;
    }
    let idx = srpClipIndexAt(state.playhead, state.videoClips);
    if (idx < 0) return false;
    if (state.selectedVideoId && state.videoClips[idx].id !== state.selectedVideoId) {
      idx = state.videoClips.findIndex((v) => v.id === state.selectedVideoId);
      if (idx < 0) return false;
    }
    const local = state.playhead - srpCumulative(state.videoClips, idx);
    const len = state.videoClips[idx].end - state.videoClips[idx].start;
    return local > MIN_CLIP + 0.01 && local < len - MIN_CLIP - 0.01;
  }

  function timelinePosFromEvent(e) {
    const rect = timeline.getBoundingClientRect();
    const total = totalDur();
    if (total <= 0) return 0;
    const frac = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(total, frac * total));
  }

  function setPlayhead(out, fromUser) {
    state.playhead = Math.max(0, Math.min(totalDur(), out));
    if (fromUser && !state.playing) {
      const info = srpOutputToSource(state.playhead, state.videoClips);
      if (info) showClipAt(info.clipIndex, info.sourceTime);
    }
    updatePlayheadUI();
  }

  // ---------- Selection ----------

  function selectVideo(id) {
    state.selectedVideoId = id;
    state.selectedAudioId = null;
    updateSelectionUI();
    updatePlayheadUI();
  }

  function selectAudio(id) {
    state.selectedAudioId = id;
    state.selectedVideoId = null;
    updateSelectionUI();
    updatePlayheadUI();
  }

  function updateSelectionUI() {
    const vc = state.videoClips.find((c) => c.id === state.selectedVideoId);
    const ac = state.audioClips.find((a) => a.id === state.selectedAudioId);
    clipAudioControls.classList.toggle('hidden', !vc);
    if (vc) {
      clipVolume.value = String(Math.round(vc.volume * 100));
      clipVolumeVal.textContent = `${Math.round(vc.volume * 100)}%`;
      clipMute.checked = vc.muted;
    }
    audioClipControls.classList.toggle('hidden', !ac);
    if (ac) {
      audioClipVolume.value = String(Math.round(ac.volume * 100));
      audioClipVolumeVal.textContent = `${Math.round(ac.volume * 100)}%`;
    }
  }

  // ---------- Timeline pointer interactions ----------

  const drag = { kind: null, index: -1, edge: 0, moved: false, startOut: 0, before: null };

  timeline.addEventListener('pointerdown', (e) => {
    if (state.exporting || totalDur() <= 0) return;

    const videoClipEl = e.target.closest('.video-clip');
    const audioClipEl = e.target.closest('.audio-clip');

    if (videoClipEl) {
      const handle = e.target.closest('.clip-handle');
      if (handle) {
        drag.kind = 'trim';
        drag.edge = handle.classList.contains('left') ? -1 : 1;
      } else {
        drag.kind = 'move';
        videoClipEl.classList.add('dragging');
      }
      drag.index = parseInt(videoClipEl.dataset.index, 10);
      drag.moved = false;
      drag.before = snapshotState();
      selectVideo(videoClipEl.dataset.id);
      // A tap (or drag start) on a clip also moves the playhead to the
      // click position — scrub-by-tap works everywhere on the timeline.
      setPlayhead(timelinePosFromEvent(e), true);
    } else if (audioClipEl) {
      const handle = e.target.closest('.clip-handle');
      if (handle) {
        drag.kind = 'atrim';
        drag.edge = handle.classList.contains('left') ? -1 : 1;
      } else {
        drag.kind = 'amove';
        audioClipEl.classList.add('dragging');
        // Anchor to the OUTPUT position under the pointer, not the clip's
        // start — otherwise even a click (1px of pointermove) snaps the
        // clip so its start lands under the cursor. With the pointer
        // anchor, dragging preserves the grab offset and a click moves
        // nothing.
        drag.startOut = timelinePosFromEvent(e);
      }
      drag.index = parseInt(audioClipEl.dataset.index, 10);
      drag.moved = false;
      drag.before = snapshotState();
      selectAudio(audioClipEl.dataset.id);
    } else {
      // Ruler / lane background — scrub. Also clears the clip selection
      // so a later split cuts every lane again (without this there was
      // no way to get back to the "split all" behavior).
      drag.kind = 'scrub';
      selectVideo(null);
      if (state.playing) stopPreview();
      setPlayhead(timelinePosFromEvent(e), true);
    }

    if (drag.kind) {
      timeline.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });

  timeline.addEventListener('pointermove', (e) => {
    if (!drag.kind) return;
    const out = timelinePosFromEvent(e);

    if (drag.kind === 'scrub') {
      setPlayhead(out, true);
      return;
    }

    if (drag.kind === 'trim') {
      drag.moved = true;
      const clip = state.videoClips[drag.index];
      if (!clip) return;
      const cum = srpCumulative(state.videoClips, drag.index);
      if (drag.edge < 0) {
        const ns = Math.max(0, Math.min(out - cum, clip.end - MIN_CLIP));
        if (Math.abs(ns - clip.start) > 0.001) {
          state.videoClips = srpTrimClip(state.videoClips, drag.index, -1, clip.start - ns, MIN_CLIP);
          renderTimeline();
        }
      } else {
        const ne = Math.max(clip.start + MIN_CLIP, Math.min(out - cum, srcDuration(clip.sourceId)));
        if (Math.abs(ne - clip.end) > 0.001) {
          state.videoClips = srpTrimClip(state.videoClips, drag.index, 1, clip.end - ne, MIN_CLIP);
          renderTimeline();
        }
      }
      return;
    }

    if (drag.kind === 'move') {
      drag.moved = true;
      const targetIndex = srpClipIndexAt(out, state.videoClips);
      if (targetIndex >= 0 && targetIndex !== drag.index) {
        const next = state.videoClips.slice();
        const [moved] = next.splice(drag.index, 1);
        next.splice(targetIndex, 0, moved);
        state.videoClips = next;
        drag.index = targetIndex;
        renderTimeline();
      }
      return;
    }

    if (drag.kind === 'atrim') {
      drag.moved = true;
      const ac = state.audioClips[drag.index];
      if (!ac) return;
      const dur = srcDuration(ac.sourceId);
      if (drag.edge < 0) {
        const ns = Math.max(0, Math.min(out, ac.end - MIN_CLIP));
        if (Math.abs(ns - ac.start) > 0.001) {
          state.audioClips[drag.index] = { ...ac, start: ns };
          renderTimeline();
        }
      } else {
        const ne = Math.max(ac.start + MIN_CLIP, Math.min(out, ac.start + dur));
        if (Math.abs(ne - ac.end) > 0.001) {
          state.audioClips[drag.index] = { ...ac, end: ne };
          renderTimeline();
        }
      }
      return;
    }

    if (drag.kind === 'amove') {
      drag.moved = true;
      const ac = state.audioClips[drag.index];
      if (!ac) return;
      const delta = out - drag.startOut;
      if (Math.abs(delta) > 0.001) {
        // Shift BOTH edges by the same amount so the length is preserved;
        // clamp the shift so the clip can't start before 0.
        const shift = Math.max(delta, -ac.start);
        if (Math.abs(shift) > 0.001) {
          state.audioClips[drag.index] = { ...ac, start: ac.start + shift, end: ac.end + shift };
          drag.startOut = out;
          renderTimeline();
        }
      }
    }
  });

  const endDrag = (e) => {
    if (!drag.kind) return;
    const kind = drag.kind;
    const didMove = drag.moved;
    const before = drag.before;
    drag.kind = null;
    drag.before = null;
    try { timeline.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    videoClipsLayer.querySelectorAll('.clip.dragging').forEach((el) => el.classList.remove('dragging'));
    audioClipsLayer.querySelectorAll('.clip.dragging').forEach((el) => el.classList.remove('dragging'));
    // Push the PRE-drag snapshot so Undo restores the layout as it was
    // before the gesture.
    if (didMove && (kind === 'trim' || kind === 'move' || kind === 'atrim' || kind === 'amove') && before) {
      pushUndoSnapshot(before);
    }
    updatePlayheadUI();
    updateExportSummary();
  };

  timeline.addEventListener('pointerup', endDrag);
  timeline.addEventListener('pointercancel', endDrag);

  function srcDuration(sourceId) {
    const src = state.sources.get(sourceId);
    return src ? Math.max(0, src.duration) : 0;
  }

  // ---------- Clip actions ----------

  // Splits at the playhead. With a clip SELECTED (video or audio) only
  // that clip is cut — the other lane is left untouched. With nothing
  // selected, the video clip under the playhead AND every audio clip
  // whose window contains the playhead are cut (keeps the extracted
  // track in sync with the picture). Returns the number of splits made.
  function splitAtPlayhead() {
    if (!canSplit()) return 0;
    const before = snapshotState();
    let changed = false;
    const ph = state.playhead;

    if (state.selectedAudioId) {
      // Audio clip selected → cut ONLY that audio clip.
      const idx = state.audioClips.findIndex((a) => a.id === state.selectedAudioId);
      if (idx >= 0 && ph > state.audioClips[idx].start + 0.05 && ph < state.audioClips[idx].end - 0.05) {
        const a = state.audioClips[idx];
        const next = state.audioClips.slice();
        next.splice(idx, 1,
          { ...a, id: a.id + '-L', end: ph },
          { ...a, id: a.id + '-R', start: ph }
        );
        state.audioClips = next;
        state.selectedAudioId = next[idx].id;
        changed = true;
      }
    } else if (state.selectedVideoId) {
      // Video clip selected → cut ONLY that video clip.
      const idx = state.videoClips.findIndex((v) => v.id === state.selectedVideoId);
      if (idx >= 0) {
        const next = srpSplitAt(state.videoClips, idx, ph);
        if (next !== state.videoClips) {
          state.videoClips = next;
          state.selectedVideoId = next[idx].id;
          changed = true;
        }
      }
    } else {
      // Nothing selected → cut the video clip under the playhead AND
      // every audio clip whose [start, end) contains the playhead,
      // keeping every lane cut at the same instant.
      const idx = srpClipIndexAt(ph, state.videoClips);
      const next = srpSplitAt(state.videoClips, idx, ph);
      if (next !== state.videoClips) {
        state.videoClips = next;
        changed = true;
      }
      const newAudio = [];
      for (const a of state.audioClips) {
        if (ph > a.start + 0.05 && ph < a.end - 0.05) {
          newAudio.push(
            { ...a, id: a.id + '-L', end: ph },
            { ...a, id: a.id + '-R', start: ph }
          );
          changed = true;
        } else {
          newAudio.push(a);
        }
      }
      if (changed) state.audioClips = newAudio;
    }
    if (changed) {
      pushUndoSnapshot(before);
      renderTimeline();
      updateExportSummary();
    }
    return changed ? 1 : 0;
  }

  // Deletes the SELECTED clip if one is selected (video or audio), else
  // the video clip under the playhead. Deleting the last video clip is
  // refused (the timeline must never be empty); audio clips — including
  // the extracted main track — can always be removed.
  function deleteSelectedOrUnderPlayhead() {
    if (state.selectedAudioId) {
      const ac = state.audioClips.find((a) => a.id === state.selectedAudioId);
      if (ac) {
        const before = snapshotState();
        state.audioClips = state.audioClips.filter((a) => a.id !== ac.id);
        state.selectedAudioId = null;
        pushUndoSnapshot(before);
        pruneUnusedMedia();
        renderTimeline();
        updateSelectionUI();
        updateExportSummary();
        return;
      }
    }
    if (state.selectedVideoId) {
      const vc = state.videoClips.find((c) => c.id === state.selectedVideoId);
      if (vc && state.videoClips.length > 1) {
        const before = snapshotState();
        state.videoClips = state.videoClips.filter((c) => c.id !== vc.id);
        state.selectedVideoId = null;
        pushUndoSnapshot(before);
        pruneUnusedMedia();
        renderTimeline();
        updateSelectionUI();
        updateExportSummary();
        return;
      }
    }
    if (state.videoClips.length <= 1) return;
    const idx = srpClipIndexAt(state.playhead, state.videoClips);
    const cum = srpCumulative(state.videoClips, idx);
    const before = snapshotState();
    state.videoClips = srpRemoveClip(state.videoClips, idx);
    state.playhead = Math.min(state.playhead, cum);
    pushUndoSnapshot(before);
    pruneUnusedMedia();
    renderTimeline();
    updateExportSummary();
  }

  function resetAll() {
    // The default state is: full video clip + the extracted recording
    // audio spanning the whole recording. A reset on that state is a
    // no-op (no undo entry for nothing).
    const untouched =
      state.videoClips.length === 1 &&
      state.audioClips.length === 1 &&
      state.audioClips[0].id === MAIN_AUDIO_CLIP_ID &&
      state.audioClips[0].start === 0 &&
      state.audioClips[0].end === state.mainDuration &&
      !state.crop && state.playhead === 0;
    if (untouched) return;
    pushUndo();
    state.videoClips = [{
      id: 'vc-main',
      sourceId: 'main',
      start: 0,
      end: state.mainDuration,
      volume: 1,
      muted: false,
      audioExtracted: true
    }];
    // Keep the extracted recording audio — it's part of the original
    // recording, not an edit. Restore it to its full span (undoing any
    // splits/trims) and drop imported music / voice-over clips.
    state.audioClips = [{
      id: MAIN_AUDIO_CLIP_ID,
      sourceId: 'main',
      start: 0,
      end: state.mainDuration,
      volume: 1
    }];
    state.selectedVideoId = null;
    state.selectedAudioId = null;
    state.crop = null;
    state.playhead = 0;
    pruneUnusedMedia();
    renderTimeline();
    renderCropOverlay();
    updateSelectionUI();
    updateExportSummary();
  }

  // ---------- Adding media (video clips + audio clips) ----------

  // Separate Video / Audio tabs make it obvious which lane a new clip
  // lands in — video on the V lane, audio on the A lane.
  const mediaTabs = $('mediaTabs');
  const mediaVideoPane = $('mediaVideoPane');
  const mediaAudioPane = $('mediaAudioPane');
  mediaTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.media-tab');
    if (!tab) return;
    const kind = tab.dataset.media;
    mediaTabs.querySelectorAll('.media-tab').forEach((t) => t.classList.toggle('active', t === tab));
    mediaVideoPane.classList.toggle('hidden', kind !== 'video');
    mediaAudioPane.classList.toggle('hidden', kind !== 'audio');
  });

  addVideoBtn.addEventListener('click', () => videoFileInput.click());
  addAudioBtn.addEventListener('click', () => audioFileInput.click());
  videoFileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) addMediaSource(f, 'video');
    e.target.value = '';
  });
  audioFileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) addMediaSource(f, 'audio');
    e.target.value = '';
  });

  async function addMediaSource(file, kind) {
    try {
      const url = URL.createObjectURL(file);
      const duration = await probeMediaDuration(url, kind);
      const id = (kind === 'video' ? 'v' : 'a') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      state.sources.set(id, {
        id,
        name: file.name,
        url,
        mimeType: file.type || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4'),
        duration,
        kind,
        // Bytes for the waveform (added files are only ever read here;
        // the blob URL is what preview/export actually consume).
        rawData: await file.arrayBuffer()
      });
      ensureWaveform(id).then(() => renderTimeline()).catch(() => {});
      pushUndo();
      if (kind === 'video') {
        state.videoClips.push({ id: 'vc' + Math.random().toString(36).slice(2, 7), sourceId: id, start: 0, end: duration, volume: 1, muted: false });
      } else {
        state.audioClips.push({ id: 'ac' + Math.random().toString(36).slice(2, 7), sourceId: id, start: 0, end: duration, volume: 1 });
      }
      renderTimeline();
      updateExportSummary();
    } catch (err) {
      console.error('[Editor] could not add media:', err);
      exportProgressLabel.textContent = 'Could not add that file';
    }
  }

  function probeMediaDuration(url, kind) {
    return new Promise((resolve, reject) => {
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.src = url;
      let settled = false;
      const cleanup = () => { el.removeAttribute('src'); try { el.load(); } catch (_) { /* noop */ } };
      const done = () => {
        if (settled) return;
        settled = true;
        const d = el.duration;
        cleanup();
        resolve(isFinite(d) && d > 0 ? d : 1);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('load failed'));
      };
      el.addEventListener('loadedmetadata', done, { once: true });
      el.addEventListener('error', fail, { once: true });
      setTimeout(fail, 15000);
    });
  }

  function removeSelectedAudioClip() {
    const ac = state.audioClips.find((a) => a.id === state.selectedAudioId);
    if (!ac) return;
    pushUndo();
    state.audioClips = state.audioClips.filter((a) => a.id !== ac.id);
    state.selectedAudioId = null;
    pruneUnusedMedia();
    renderTimeline();
    updateSelectionUI();
    updateExportSummary();
  }

  // Frees the hidden elements / gain nodes of sources and audio clips that
  // are no longer referenced by any clip. The source registry and its blob
  // URL are intentionally KEPT (undo can restore a clip referencing them;
  // URLs are all revoked on unload anyway) — this just prevents elements
  // and Web Audio nodes from piling up across a long editing session.
  function pruneUnusedMedia() {
    const used = new Set();
    for (const c of state.videoClips) used.add(c.sourceId);
    for (const a of state.audioClips) used.add(a.sourceId);

    for (const [sid, el] of previewEls) {
      if (sid !== 'main' && !used.has(sid)) {
        el.pause();
        el.remove();
        previewEls.delete(sid);
      }
    }
    for (const [sid, wrap] of exportEls) {
      if (sid !== 'main' && !used.has(sid)) {
        wrap.el.pause();
        wrap.el.remove();
        try { wrap.gain.disconnect(); } catch (_) { /* already gone */ }
        exportEls.delete(sid);
      }
    }
    for (const [acId, el] of previewAudioEls) {
      if (!state.audioClips.some((a) => a.id === acId)) {
        el.pause();
        el.remove();
        previewAudioEls.delete(acId);
      }
    }
    for (const [acId, wrap] of exportAudioEls) {
      if (!state.audioClips.some((a) => a.id === acId)) {
        wrap.el.pause();
        wrap.el.remove();
        try { wrap.gain.disconnect(); } catch (_) { /* already gone */ }
        exportAudioEls.delete(acId);
      }
    }
  }

  // ---------- Audio waveforms ----------

  // Decodes a source's audio and reduces it to a small array of peak
  // samples (0..1) used to draw the waveform on its A-lane clips.
  // Cached per source; failures (no audio track, weird codec) just leave
  // the cache empty and the clip renders without a waveform.
  function sourceRawData(sourceId) {
    const src = state.sources.get(sourceId);
    if (!src) return null;
    if (src.rawData) return src.rawData;
    return null;
  }

  function ensureWaveform(sourceId) {
    if (state.waveforms.has(sourceId)) return Promise.resolve(state.waveforms.get(sourceId));
    const src = state.sources.get(sourceId);
    const raw = src && src.rawData;
    if (!raw) return Promise.resolve(null);
    return new Promise((resolve) => {
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
      ctx.decodeAudioData(raw.slice(0), (buffer) => {
        try {
          const data = buffer.getChannelData(0);
          const SAMPLES = 256;
          const peaks = new Float32Array(SAMPLES);
          const step = Math.max(1, Math.floor(data.length / SAMPLES));
          for (let i = 0; i < SAMPLES; i++) {
            let max = 0;
            for (let j = i * step; j < Math.min((i + 1) * step, data.length); j++) {
              const v = Math.abs(data[j]);
              if (v > max) max = v;
            }
            peaks[i] = max;
          }
          state.waveforms.set(sourceId, peaks);
          resolve(peaks);
        } catch (e) {
          resolve(null);
        }
      }, () => resolve(null))
        // Chrome rejects the promise it returns even when the error
        // callback fires (a recording without an audio track fails
        // decode with EncodingError) — without this catch the rejected
        // promise is unhandled and logs an exception to the console on
        // every such recording.
        .catch(() => resolve(null));
    });
  }

  // ---------- Preview playback (plays the EDITED sequence) ----------

  function togglePlay() {
    if (state.exporting) return;
    if (state.playing) stopPreview();
    else startPreview();
  }

  // Toggles loop playback: at the end of the sequence, playback restarts
  // from the top instead of stopping (nice for checking cuts in a loop).
  function toggleLoop() {
    state.loop = !state.loop;
    loopBtn.classList.toggle('active', state.loop);
    loopBtn.title = state.loop ? 'Loop playback: on' : 'Loop playback';
  }

  function startPreview() {
    if (totalDur() <= 0.02) return;
    if (state.playhead >= totalDur() - 0.05) state.playhead = 0;
    state.curIndex = srpClipIndexAt(state.playhead, state.videoClips);
    const info = srpOutputToSource(state.playhead, state.videoClips);
    if (info) activatePreviewClip(info.clipIndex);
    state.playing = true;
    playBtn.textContent = '❚❚';
    requestAnimationFrame(previewLoop);
  }

  function previewLoop() {
    if (!state.playing) return;
    const clips = state.videoClips;
    const idx = state.curIndex;
    const clip = clips[idx];
    if (!clip) {
      stopPreview();
      return;
    }
    const el = previewEls.get(clip.sourceId);
    if (!el) {
      stopPreview();
      return;
    }

    // Apply a parked seek once the element has metadata.
    if (el.dataset.pendingSeek !== undefined && el.readyState >= 1) {
      el.currentTime = parseFloat(el.dataset.pendingSeek);
      delete el.dataset.pendingSeek;
    }

    if (!el.seeking && el.readyState >= 2) {
      if (el.currentTime >= clip.end - 0.03 || el.ended) {
        if (idx < clips.length - 1) {
          state.curIndex = idx + 1;
          activatePreviewClip(state.curIndex);
        } else if (state.loop) {
          // Loop: rewind to the top and keep playing.
          state.playhead = 0;
          state.curIndex = 0;
          activatePreviewClip(0);
          updatePlayheadUI();
        } else {
          stopPreview();
          setPlayhead(totalDur(), false);
          return;
        }
      } else {
        const cum = srpCumulative(clips, idx);
        state.playhead = cum + Math.min(el.currentTime - clip.start, clip.end - clip.start);
        updatePlayheadUI();
        manageAudioPreview(state.playhead);
      }
    }
    requestAnimationFrame(previewLoop);
  }

  function manageAudioPreview(outT) {
    for (const ac of state.audioClips) {
      const el = previewAudioEls.get(ac.id);
      const inWin = outT >= ac.start && outT < ac.end;
      if (inWin) {
        const e = el || ensurePreviewAudioEl(ac.id);
        if (e) {
          if (e.paused) {
            e.currentTime = Math.max(0, outT - ac.start);
            e.play().catch(() => {});
          }
          e.volume = ac.volume;
        }
      } else if (el && !el.paused) {
        el.pause();
      }
    }
  }

  function stopPreview() {
    state.playing = false;
    playBtn.textContent = '▶';
    previewEls.forEach((e) => e.pause());
    previewAudioEls.forEach((e) => e.pause());
  }

  // ---------- Crop ----------

  function toggleCropMode() {
    state.cropMode = !state.cropMode;
    renderCropOverlay();
  }

  function clearCrop() {
    if (!state.crop) return;
    pushUndo();
    state.crop = null;
    renderCropOverlay();
    updateExportSummary();
  }

  function renderCropOverlay() {
    cropOverlay.classList.toggle('hidden', !state.cropMode);
    cropToggleBtn.classList.toggle('active', state.cropMode);
    cropToggleBtn.textContent = state.cropMode ? '✂ Crop Mode: ON' : '✂ Crop Mode';
    cropClearBtn.disabled = state.exporting || !state.crop;
    renderCropRect();
  }

  function stageNorm(e) {
    const rect = stage.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    };
  }

  function applyAspect(w, h) {
    if (!state.cropAspect) return { w, h };
    return { w, h: w / state.cropAspect };
  }

  // Crop drawing uses a raw two-point model ({ x0, y0, x1, y1 }) during
  // the drag so any direction (up/down/left/right) works identically;
  // the normalized { x, y, w, h } rectangle is derived from the two
  // points and clamped only at commit time.
  const cropDrag = { mode: null, sx: 0, sy: 0, x0: 0, y0: 0, start: null, initial: null };

  cropOverlay.addEventListener('pointerdown', (e) => {
    if (!state.cropMode || state.exporting) return;
    const p = stageNorm(e);
    const handle = e.target.closest('.crop-handle');
    // "Inside the crop": DOM-first — the press landed on the crop rect
    // itself (or its dims label), which is how center-drag-to-move is
    // actually hit-tested. The coordinate fallback covers the corner case
    // where the pointer is inside the rect but the target is the overlay
    // (e.g. the rect's ::before dimming shadow swallowing events).
    const onRect = !!e.target.closest && !!e.target.closest('#cropRect');
    const inside = (onRect || (state.crop &&
      p.x >= state.crop.x && p.x <= state.crop.x + state.crop.w &&
      p.y >= state.crop.y && p.y <= state.crop.y + state.crop.h));

    if (handle) {
      cropDrag.mode = handle.classList.contains('tl') ? 'tl'
        : handle.classList.contains('tr') ? 'tr'
        : handle.classList.contains('bl') ? 'bl'
        : handle.classList.contains('br') ? 'br'
        : handle.classList.contains('ml') ? 'ml'
        : handle.classList.contains('mr') ? 'mr'
        : handle.classList.contains('tm') ? 'tm'
        : 'bm';
    } else if (inside && state.crop) {
      cropDrag.mode = 'move';
    } else {
      // Fresh draw — raw two-corner model, no seeded rectangle.
      cropDrag.mode = 'draw';
      cropDrag.x0 = p.x;
      cropDrag.y0 = p.y;
      state.crop = { x: p.x, y: p.y, w: 0.02, h: 0.02 };
      cropRect.classList.remove('hidden');
      renderCropRect();
    }
    cropDrag.sx = p.x;
    cropDrag.sy = p.y;
    cropDrag.start = state.crop ? { ...state.crop } : null;
    cropDrag.initial = state.crop ? { ...state.crop } : null;
    cropDrag.before = snapshotState();
    cropOverlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  cropOverlay.addEventListener('pointermove', (e) => {
    if (!cropDrag.mode) return;
    const p = stageNorm(e);
    const s = cropDrag.start;
    if (!s) return;

    if (cropDrag.mode === 'draw') {
      const x = Math.min(cropDrag.x0, p.x);
      const y = Math.min(cropDrag.y0, p.y);
      let w = Math.abs(p.x - cropDrag.x0);
      let h = Math.abs(p.y - cropDrag.y0);
      if (w < 0.005 && h < 0.005) return;
      const adj = applyAspect(Math.max(w, 0.005), Math.max(h, 0.005));
      state.crop = srpClampCrop({ x, y, w: adj.w, h: adj.h });
    } else if (cropDrag.mode === 'move') {
      state.crop = srpClampCrop({
        x: s.x + (p.x - cropDrag.sx),
        y: s.y + (p.y - cropDrag.sy),
        w: s.w,
        h: s.h
      });
    } else {
      // Corner/edge resize — the opposite side stays fixed.
      const mode = cropDrag.mode;
      const touchLeft = mode.includes('l');
      const touchRight = mode.includes('r');
      const touchTop = mode.includes('t');
      const touchBottom = mode.includes('b');
      const fixedL = touchLeft ? p.x : s.x;
      const fixedR = touchRight ? p.x : s.x + s.w;
      const fixedT = touchTop ? p.y : s.y;
      const fixedB = touchBottom ? p.y : s.y + s.h;
      let x = Math.min(fixedL, fixedR);
      let y = Math.min(fixedT, fixedB);
      let w = Math.abs(fixedR - fixedL);
      let h = Math.abs(fixedB - fixedT);
      const adj = applyAspect(Math.max(w, 0.005), Math.max(h, 0.005));
      state.crop = srpClampCrop({ x, y, w: adj.w, h: adj.h });
    }
    renderCropRect();
  });

  const endCropDrag = (e) => {
    if (!cropDrag.mode) return;
    const mode = cropDrag.mode;
    cropDrag.mode = null;
    try { cropOverlay.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    // A click that never grew into a rectangle is a mis-draw — drop it.
    if (mode === 'draw' && state.crop && state.crop.w < 0.03 && state.crop.h < 0.03) {
      state.crop = null;
    }
    // Push the PRE-drag snapshot so Undo restores the crop as it was
    // before the gesture (snapshotting after the change made Undo a
    // silent no-op for crop moves/resizes).
    if (cropDrag.before && JSON.stringify(cropDrag.before.crop) !== JSON.stringify(state.crop)) {
      pushUndoSnapshot(cropDrag.before);
    }
    cropDrag.initial = null;
    cropDrag.before = null;
    renderCropOverlay();
    updateExportSummary();
  };

  cropOverlay.addEventListener('pointerup', endCropDrag);
  cropOverlay.addEventListener('pointercancel', endCropDrag);

  function renderCropRect() {
    if (!state.crop) {
      cropRect.classList.add('hidden');
      return;
    }
    cropRect.classList.remove('hidden');
    cropRect.style.left = `${state.crop.x * 100}%`;
    cropRect.style.top = `${state.crop.y * 100}%`;
    cropRect.style.width = `${state.crop.w * 100}%`;
    cropRect.style.height = `${state.crop.h * 100}%`;
    const active = [...previewEls.values()].find((el) => el.classList.contains('active')) || previewEls.get('main');
    const srcW = active ? active.videoWidth || 0 : 0;
    const srcH = active ? active.videoHeight || 0 : 0;
    cropDims.textContent = srcW && srcH
      ? `${Math.round(srcW * state.crop.w)} × ${Math.round(srcH * state.crop.h)}`
      : '';
  }

  cropPresets.addEventListener('click', (e) => {
    const btn = e.target.closest('.crop-preset');
    if (!btn) return;
    cropPresets.querySelectorAll('.crop-preset').forEach((b) => b.classList.toggle('active', b === btn));
    state.cropAspect = btn.dataset.aspect ? parseFloat(btn.dataset.aspect) : null;
  });

  // ---------- Export ----------

  function ensureExportGraph() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioDest = audioCtx.createMediaStreamDestination();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(audioDest);
  }

  function makeHiddenMediaEl(tag, url) {
    const el = document.createElement(tag);
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = false;
    el.src = url;
    el.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
    document.body.appendChild(el);
    return el;
  }

  function ensureSourceExportVideo(sourceId) {
    let wrap = exportEls.get(sourceId);
    if (wrap) return wrap;
    const src = state.sources.get(sourceId);
    const el = makeHiddenMediaEl('video', src.url);
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    const node = audioCtx.createMediaElementSource(el);
    node.connect(gain);
    gain.connect(masterGain);
    wrap = { el, gain };
    exportEls.set(sourceId, wrap);
    return wrap;
  }

  function ensureAudioClipExportEl(audioClipId) {
    let wrap = exportAudioEls.get(audioClipId);
    if (wrap) return wrap;
    const ac = state.audioClips.find((a) => a.id === audioClipId);
    if (!ac) return null;
    const src = state.sources.get(ac.sourceId);
    const el = makeHiddenMediaEl('audio', src.url);
    const gain = audioCtx.createGain();
    gain.gain.value = ac.volume;
    const node = audioCtx.createMediaElementSource(el);
    node.connect(gain);
    gain.connect(masterGain);
    wrap = { el, gain, didStart: false };
    exportAudioEls.set(audioClipId, wrap);
    return wrap;
  }

  function waitForSeek(video) {
    return new Promise((resolve) => {
      if (!video.seeking) return resolve();
      const timer = setTimeout(done, 3000);
      function done() {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        resolve();
      }
      video.addEventListener('seeked', done);
    });
  }

  function nextVideoFrame(video) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(done);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(done));
      }
      // rVFC only fires when the browser actually PRESENTS a new frame; a
      // seek to an already-displayed position (contiguous clips) can
      // present nothing — fall back so the export never hangs.
      setTimeout(done, 1500);
    });
  }

  function waitMetadata(el, ms) {
    return new Promise((resolve) => {
      if (el.readyState >= 1) return resolve();
      const timer = setTimeout(done, ms || 5000);
      function done() {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', done);
        resolve();
      }
      el.addEventListener('loadedmetadata', done, { once: true });
    });
  }

  function drawExportFrame(video, crop, outW, outH) {
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    if (!sw || !sh) return;
    const sx = crop ? Math.round(crop.x * sw) : 0;
    const sy = crop ? Math.round(crop.y * sh) : 0;
    const srw = crop ? Math.max(1, Math.round(crop.w * sw)) : sw;
    const srh = crop ? Math.max(1, Math.round(crop.h * sh)) : sh;
    exportCtx.drawImage(video, sx, sy, srw, srh, 0, 0, outW, outH);
  }

  function exportDims(srcW, srcH) {
    const res = exportResSelect.value;
    let w = srcW;
    let h = srcH;
    if (state.crop) {
      w = Math.max(2, Math.round(srcW * state.crop.w));
      h = Math.max(2, Math.round(srcH * state.crop.h));
    }
    const max = res === '1080p' ? 1920 : res === '720p' ? 1280 : Infinity;
    const scale = Math.min(1, max / Math.max(w, h));
    let outW = Math.max(2, Math.round(w * scale));
    let outH = Math.max(2, Math.round(h * scale));
    // Round the export canvas down to the container's alignment unit.
    // The export container follows the source file (MP4 recording →
    // MP4 export, WebM → WebM), and with it the requirement: H.264
    // (MP4) pads to 16x16 macroblocks without cropping the padding, so
    // it plays back as the duplicated strip at the bottom (the same
    // MP4-only "double bottom" artifact as screen recording); WebM
    // (VP8/VP9) is cropped correctly and only needs even. Loses at
    // most unit-1 pixels, never visible.
    const preferWebm = srpMimeExtension(state.record.mimeType) === 'webm';
    const alignUnit = srpAlignUnit(srpPickMimeType(null, preferWebm));
    outW -= outW % alignUnit;
    outH -= outH % alignUnit;
    return { w: outW, h: outH };
  }

  // True when nothing differs from the untouched original — the export
  // then copies the source bytes instead of re-encoding.
  function isNoEdit() {
    if (noAudioChk.checked) return false; // video-only is an edit
    if (exportResSelect.value !== 'original') return false;
    const c = state.videoClips;
    if (c.length !== 1) return false;
    const v = c[0];
    if (v.sourceId !== 'main') return false;
    if (Math.abs(v.start) > 0.001 || Math.abs(v.end - state.mainDuration) > 0.001) return false;
    if (v.muted || v.volume < 0.999) return false;
    if (state.crop) return false;
    // The extracted audio track is created by default on load, so the
    // only "no edit" audio state is EXACTLY the default: one audio clip
    // on the main track, full length, full volume. Anything else (added
    // clips, trims, moves, deletes, volume changes) is a real edit.
    const a = state.audioClips;
    if (a.length !== 1) return false;
    if (a[0].id !== MAIN_AUDIO_CLIP_ID) return false;
    if (a[0].sourceId !== 'main') return false;
    if (Math.abs(a[0].start) > 0.001 || Math.abs(a[0].end - state.mainDuration) > 0.001) return false;
    if (a[0].volume < 0.999) return false;
    return true;
  }

  function flashExportDone(msg) {
    exportProgressWrap.classList.remove('hidden');
    exportProgressFill.style.width = '100%';
    exportProgressLabel.textContent = msg || 'Saved ✓';
    setTimeout(() => exportProgressWrap.classList.add('hidden'), 3200);
  }

  async function startExport() {
    if (state.exporting) return;
    const total = totalDur();
    if (total <= 0.02) {
      exportProgressLabel.textContent = 'Nothing to export';
      return;
    }

    // FAST PATH: untouched → hand back the original file instantly.
    if (isNoEdit()) {
      const ext = srpMimeExtension(state.record.mimeType);
      const blob = new Blob([state.record.buffer], { type: state.record.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited-${Date.now()}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      flashExportDone('Saved ✓ (no edits — original)');
      return;
    }

    ensureExportGraph();
    try { await audioCtx.resume(); } catch (_) { /* audio stays silent if blocked */ }

    // Prepare every needed source element before recording starts.
    const neededSources = new Set(state.videoClips.map((c) => c.sourceId));
    for (const sid of neededSources) {
      const wrap = ensureSourceExportVideo(sid);
      await waitMetadata(wrap.el, 5000);
    }
    for (const ac of state.audioClips) ensureAudioClipExportEl(ac.id);

    let srcW = 0;
    let srcH = 0;
    for (const sid of neededSources) {
      const wrap = exportEls.get(sid);
      if (wrap.el.videoWidth && wrap.el.videoHeight) {
        srcW = wrap.el.videoWidth;
        srcH = wrap.el.videoHeight;
        break;
      }
    }
    if (!srcW || !srcH) {
      exportProgressLabel.textContent = 'Cannot read video';
      return;
    }

    const dims = exportDims(srcW, srcH);
    const outW = dims.w;
    const outH = dims.h;
    const crop = state.crop;

    // Everything from here on is one try/finally so NO failure can leave
    // the UI locked in an exporting state.
    let recorder = null;
    let started = false;
    let cancelled = false;
    let mimeType = 'video/webm';
    const chunks = [];
    try {
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      exportCtx = canvas.getContext('2d', { alpha: false });

      const stream = canvas.captureStream(30);
      if (!noAudioChk.checked) {
        const audioTrack = audioDest ? audioDest.stream.getAudioTracks()[0] : null;
        if (audioTrack) stream.addTrack(audioTrack);
      }

      const bitrate = srpScaledBitrate('1080p', outW, outH);
      const preferWebm = srpMimeExtension(state.record.mimeType) === 'webm';
      const info = srpCreateMediaRecorder(stream, bitrate, null, preferWebm);
      recorder = info.recorder;
      mimeType = info.mimeType;

      state.exporting = true;
      exportBtn.disabled = true;
      splitBtn.disabled = true;
      deleteBtn.disabled = true;
      updateUndoBtn();
      exportProgressWrap.classList.remove('hidden');
      exportProgressLabel.textContent = '0%';
      exportProgressFill.style.width = '0%';

      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      cancelExportBtn.onclick = () => { cancelled = true; exportProgressLabel.textContent = 'Cancelling…'; };

      recorder.start(500);
      started = true;

      const exportStartTime = Date.now();
      let done = 0;
      for (let i = 0; i < state.videoClips.length && !cancelled; i++) {
        const clip = state.videoClips[i];
        const clipLen = clip.end - clip.start;

        // Pause EVERYTHING (video + audio clips) so the seek gap isn't
        // recorded and nothing drifts against the output clock.
        for (const w of exportEls.values()) w.el.pause();
        for (const w of exportAudioEls.values()) { w.el.pause(); w.didStart = false; }

        recorder.pause();
        const act = exportEls.get(clip.sourceId);
        act.el.currentTime = clip.start;
        await waitForSeek(act.el);
        await nextVideoFrame(act.el);
        drawExportFrame(act.el, crop, outW, outH);
        for (const w of exportEls.values()) w.gain.gain.value = 0;
        act.gain.gain.value = clip.muted || clip.audioExtracted ? 0 : clip.volume;
        recorder.resume();
        await act.el.play().catch(() => {});

        await new Promise((resolve, reject) => {
          let lastT = -1;
          let lastAdvance = Date.now();
          const fail = (err) => reject(err);
          const loop = () => {
            try {
              if (cancelled) return resolve();
              const t = act.el.currentTime;
              if (t >= clip.end - 0.02 || act.el.ended) {
                done += clipLen;
                return resolve();
              }
              // Stall guard: a source that fails to decode never advances
              // currentTime — fail the export instead of spinning forever.
              if (t !== lastT) {
                lastT = t;
                lastAdvance = Date.now();
              } else if (Date.now() - lastAdvance > 3000) {
                return fail(new Error('source video stalled during export'));
              }
              drawExportFrame(act.el, crop, outW, outH);
              const outT = done + Math.max(0, Math.min(t - clip.start, clipLen));
              manageAudioExport(outT);
              const pct = Math.min(1, outT / total);
              const p = Math.max(0.01, pct);
              exportProgressFill.style.width = `${(pct * 100).toFixed(1)}%`;
              const elapsedSec = (Date.now() - exportStartTime) / 1000;
              const etaSec = (elapsedSec / p) * (1 - p);
              const etaLabel = isFinite(etaSec) ? srpFormatTime(etaSec) : '…';
              exportProgressLabel.textContent = `${Math.round(pct * 100)}% · ETA ${etaLabel}`;
              requestAnimationFrame(loop);
            } catch (err) {
              fail(err);
            }
          };
          requestAnimationFrame(loop);
        });
      }
    } catch (err) {
      console.error('[Editor] export failed:', err);
      exportProgressLabel.textContent = 'Export failed';
    } finally {
      try { if (started && recorder && recorder.state === 'recording') recorder.pause(); } catch (_) { /* already stopped */ }
      for (const w of exportEls.values()) w.el.pause();
      for (const w of exportAudioEls.values()) { w.el.pause(); w.didStart = false; }
      try { if (recorder) recorder.stop(); } catch (_) { /* never started */ }
      if (started && recorder) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3000);
          recorder.onstop = () => { clearTimeout(t); resolve(); };
          recorder.onerror = () => { clearTimeout(t); resolve(); };
        });
      }
      finishExport(chunks, mimeType, cancelled);
    }
  }

  // Drives audio clips in real time during export. On entry to a clip's
  // window the element seeks to its exact offset ((outputTime - start))
  // and plays; it is paused when the window ends. At video clip
  // boundaries everything is paused together, so re-entry re-seeks to the
  // same offset — no drift.
  function manageAudioExport(outT) {
    for (const ac of state.audioClips) {
      const w = exportAudioEls.get(ac.id);
      if (!w) continue;
      const inWin = outT >= ac.start && outT < ac.end;
      if (inWin) {
        w.gain.gain.value = ac.volume;
        if (!w.didStart) {
          w.didStart = true;
          w.el.currentTime = Math.max(0, outT - ac.start);
          w.el.play().catch(() => {});
        } else if (w.el.paused && !w.el.ended) {
          w.el.play().catch(() => {});
        }
      } else {
        w.didStart = false;
        if (!w.el.paused) w.el.pause();
      }
    }
  }

  function finishExport(chunks, mimeType, cancelled) {
    state.exporting = false;
    exportBtn.disabled = false;
    cancelExportBtn.onclick = null;
    updatePlayheadUI();
    updateUndoBtn();

    if (cancelled || chunks.length === 0) {
      exportProgressLabel.textContent = cancelled ? 'Cancelled' : 'No data recorded';
      setTimeout(() => exportProgressWrap.classList.add('hidden'), 2000);
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edited-${Date.now()}.${srpMimeExtension(mimeType)}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    exportProgressFill.style.width = '100%';
    exportProgressLabel.textContent = 'Saved ✓';
    setTimeout(() => exportProgressWrap.classList.add('hidden'), 2500);
  }

  // ---------- Export summary ----------

  function updateExportSummary() {
    const total = totalDur();
    const parts = [`${total.toFixed(1)}s output`];
    if (state.audioClips.length) parts.push(`${state.audioClips.length} audio clip${state.audioClips.length === 1 ? '' : 's'}`);
    if (state.crop) parts.push('crop set');
    const res = exportResSelect.value;
    if (res !== 'original') parts.push(`export ${res}`);
    exportSummary.textContent = parts.join(' · ');
  }

  // ---------- Audio controls ----------

  // Volume and mute are continuous inputs (every 'input' event mutates
  // the clip), so the undo snapshot must be captured at the START of the
  // gesture — snapshotting after the fact made Undo a silent no-op.
  let pendingClipSnapshot = null;

  clipVolume.addEventListener('input', () => {
    if (!pendingClipSnapshot) pendingClipSnapshot = snapshotState();
    const vc = state.videoClips.find((c) => c.id === state.selectedVideoId);
    if (!vc) return;
    vc.volume = parseInt(clipVolume.value, 10) / 100;
    clipVolumeVal.textContent = `${clipVolume.value}%`;
    const active = [...previewEls.values()].find((el) => el.classList.contains('active'));
    if (active) active.volume = vc.muted ? 0 : vc.volume;
    renderTimeline();
  });

  clipVolume.addEventListener('change', () => {
    if (pendingClipSnapshot) {
      pushUndoSnapshot(pendingClipSnapshot);
      pendingClipSnapshot = null;
    }
  });

  clipMute.addEventListener('change', () => {
    const vc = state.videoClips.find((c) => c.id === state.selectedVideoId);
    if (!vc) return;
    const before = snapshotState();
    vc.muted = clipMute.checked;
    const active = [...previewEls.values()].find((el) => el.classList.contains('active'));
    if (active) active.volume = vc.muted ? 0 : vc.volume;
    pushUndoSnapshot(before);
    renderTimeline();
  });

  // Same pre-gesture snapshot pattern as the video volume above: the
  // snapshot is captured on the first 'input' (before any mutation) and
  // pushed on 'change' so Undo restores the pre-slide volume.
  let pendingAudioClipSnapshot = null;

  audioClipVolume.addEventListener('input', () => {
    if (!pendingAudioClipSnapshot) pendingAudioClipSnapshot = snapshotState();
    const ac = state.audioClips.find((a) => a.id === state.selectedAudioId);
    if (!ac) return;
    ac.volume = parseInt(audioClipVolume.value, 10) / 100;
    audioClipVolumeVal.textContent = `${audioClipVolume.value}%`;
    renderTimeline();
  });

  audioClipVolume.addEventListener('change', () => {
    if (pendingAudioClipSnapshot) {
      pushUndoSnapshot(pendingAudioClipSnapshot);
      pendingAudioClipSnapshot = null;
    }
  });
  audioClipDeleteBtn.addEventListener('click', removeSelectedAudioClip);

  // ---------- Wiring ----------

  playBtn.addEventListener('click', togglePlay);
  splitBtn.addEventListener('click', splitAtPlayhead);
  deleteBtn.addEventListener('click', deleteSelectedOrUnderPlayhead);
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  loopBtn.addEventListener('click', toggleLoop);
  resetBtn.addEventListener('click', resetAll);
  cropToggleBtn.addEventListener('click', toggleCropMode);
  cropClearBtn.addEventListener('click', clearCrop);
  exportBtn.addEventListener('click', startExport);
  exportResSelect.addEventListener('change', updateExportSummary);

  document.addEventListener('keydown', (e) => {
    if (state.exporting) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 's' || e.key === 'S') {
      splitAtPlayhead();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedOrUnderPlayhead();
    } else if (e.key === 'l' || e.key === 'L') {
      toggleLoop();
    } else if (e.key === 'c' || e.key === 'C') {
      toggleCropMode();
    }
  });

  window.addEventListener('beforeunload', () => {
    previewEls.forEach((e) => e.pause());
    previewAudioEls.forEach((e) => e.pause());
    for (const src of state.sources.values()) URL.revokeObjectURL(src.url);
    if (audioCtx && typeof audioCtx.close === 'function') audioCtx.close().catch(() => {});
  });

  init();
})();
