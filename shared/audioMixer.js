// Mixes any number of audio tracks (e.g. system audio + microphone) into
// a single track using the Web Audio API, so a MediaRecorder only ever
// has to deal with one audio track. Returns null if no tracks were given.
//
// NOTE: this creates an AudioContext, which browsers may start in a
// "suspended" state until a user gesture occurs. Both call sites (the
// offscreen document and the area-recording content script) invoke this
// right after a getDisplayMedia/getUserMedia permission prompt, which
// counts as a user gesture chain, so this resumes automatically in
// practice. If audio is ever silent, resuming the returned context
// explicitly is the first thing to check.
//
// MICROPHONE ENHANCEMENT (options.noiseReduction, default true) — the MIC
// track is processed by a real-time enhancement chain, layered on top of
// Chrome's built-in echo cancellation + input AGC (see offscreen.js /
// selector.js; Chrome's own noiseSuppression is deliberately NOT requested
// there — RNNoise below owns noise removal, and Chrome's built-in
// suppression has erased soft voices on some platforms). Input AGC is
// important before RNNoise: low-sensitivity microphones otherwise arrive
// below the model's usable speech range. The slower leveler below only
// evens the already-denoised output:
//
//   1. High-pass: rolls off fan/AC/room rumble below ~65 Hz (cheap, and
//      covers the brief window while RNNoise is still loading), then a
//      200 Hz low-shelf that trims the excess sub-200 Hz boom laptop
//      mics/rooms add (see the DE-BOOM note above) — before the AGC so
//      loudness is re-normalized afterwards.
//   2. RNNoise denoise (WASM, vendored in shared/vendor/rnnoise.js): a
//      small neural network that removes steady broadband noise (fan hum,
//      traffic, birds) far better than a static filter.
//   3. Voice-preservation blend: RNNoise's own VAD decides what is
//      speech, so its denoised output should never be allowed to erase
//      what it classified as speech. If a frame scores as speech (VAD >=
//      voicePreserveVad) with real input level but the denoised output
//      collapses below a fraction of the input (soft / accented / distant
//      voices can be damaged this way), a smoothed portion of the RAW
//      pre-denoise frame is blended back in — a live voice can never be
//      fully erased, while fan/music (VAD ~0) never trigger the blend.
//   4. Voice-safe pass-through: production recordings keep the hard
//      voice-activity gate disabled. Real-speech QA showed that a hard gate
//      can swallow quiet words and can mute most of the mic while RNNoise
//      is still loading. The gate implementation remains below as an
//      explicitly configurable/testable fallback, but normal recording
//      config forces it off.
//   5. Auto-gain: a slowly-tracked peak normalizer boosts quiet mics,
//      followed by a soft limiter so the boost can't clip.
//   6. Presence EQ: a subtle high-shelf restores speech definition after
//      denoising without changing the system-audio path.
//
// NOISE GATE (options.noiseGate) — mutes the microphone entirely unless
// a voice is detected, so fan hum, music and other non-speech sounds
// only ever reach the recording while the user is actually speaking
// (and even then RNNoise has already attenuated them). When the user
// stops talking, the gate closes and the mic is dead silent; when they
// start again, it reopens within a few frames.
//
// Decision inputs — a COMBINED score per 10 ms frame:
//   1. RNNoise's VAD probability (best speech/music discriminator);
//   2. INPUT energy (RMS of the raw pre-denoise frame) — the critical
//      hold signal. Chrome's NS/AGC + RNNoise can drive the VAD to ~0
//      even mid-phrase, and a VAD-only gate then chops the voice; input
//      energy stays high for the whole phrase (speech is ~10-15 dB above
//      room background), so the gate holds open. A piecewise-linear
//      map (closeFloor 0.014 <-> openFloor 0.035) turns raw RMS into a
//      0..1 score;
//   3. Denoiser-null fallback: a plain min(1, rms/0.035) energy score
//      when Voice Enhance is off (no RNNoise to lean on).
// Score = max of the above; the gate opens once the SMOOTHED score
// holds above 0.4 for a few consecutive frames (speech onsets sustain,
// music/knock spikes collapse) and closes once it drops below 0.3 for
// a ~200 ms hangover (smoothing + hangover are the hysteresis).
//
// FAIL-SAFE — the gate must never erase a live microphone. Quiet or
// soft voices (weak AGC, distant mic) can sit below RNNoise's VAD bar
// and below the old energy floors, which left the mic permanently
// muted — a silent recording with no way to recover. So:
//   * the energy floors are lowered so real input from ~0.022 RMS up
//     opens the gate on its own (previously speech had to reach ~0.034);
//   * a one-way fail-open latch tracks how long the gate has stayed
//     closed while the raw input carries clearly-audible audio (>
//     gateUnlockFloor, 0.05 — well above room tone and brief knocks).
//     If that accumulates past ~1.5 s (gateUnlockFrames), the speech
//     detector is clearly failing for this input — the gate permanently
//     unlocks and leaves the mic live for the rest of the recording
//     (RNNoise still suppresses steady background on the denoised
//     path). A latch that re-armed would chop the first second of every
//     phrase, which is the failure this gate exists to avoid.
// The gain envelope fades over ~2-3 frames so opening/closing never
// clicks. Requires the mic path to run the DSP chain, which happens
// whenever Voice Enhance is on OR the gate is enabled (see
// srpMixAudioTracks).
//
// SYSTEM-ONLY audio is returned untouched. When system audio is mixed
// with a microphone, it is attenuated slightly to leave room for speech;
// the combined bus then gets one final safety ceiling/headroom stage.
//
// DE-BOOM LOW-SHELF — measured on a real laptop-mic recording, sub-200 Hz
// made up ~38% of the mic signal (vs ~16% for a natural male voice): the
// mic's proximity boom + room rumble buries the 200-500 Hz band where
// voice clarity lives, which is what makes speech sound muffled even
// though the high-frequency content is fine. A low-shelf at 200 Hz trims
// that excess (see the mic chain below). It sits BEFORE the AGC so the
// leveler re-normalizes and overall loudness is preserved.
function srpCreateMixSafetyLimiter(audioCtx) {
  const shaper = audioCtx.createWaveShaper();
  const n = 32768;
  const curve = new Float32Array(n);
  const knee = 0.82;
  const span = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    const y = a <= knee
      ? a
      : knee + span * Math.tanh((a - knee) / span);
    curve[i] = sign * y;
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  return shaper;
}

function srpMixAudioTracks(tracks, options) {
  const { noiseReduction, noiseGate, micTrack, systemMixGain } = options || {};
  const valid = tracks.filter(Boolean);
  if (valid.length === 0) return null;

  // A single non-mic track (e.g. system-only audio) needs no processing
  // at all — pass the original track straight through, which also skips
  // creating an AudioContext (the original behavior).
  const hasMic = valid.some((track) => micTrack === track);
  const processMic = hasMic && noiseReduction !== false;
  // The DSP chain runs when Voice Enhance is on, and also when only the
  // noise gate is enabled (it needs the per-frame processing; without
  // RNNoise it falls back to energy-based voice detection).
  const runMicDsp = processMic || !!noiseGate;
  if (valid.length === 1 && !hasMic) {
    return valid[0];
  }

  let audioCtx;
  try {
    audioCtx = new AudioContext({ sampleRate: 48000 });
  } catch (e) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const destination = audioCtx.createMediaStreamDestination();
  const mixBus = audioCtx.createGain();
  const mixSafety = srpCreateMixSafetyLimiter(audioCtx);
  const mixHeadroom = audioCtx.createGain();
  mixHeadroom.gain.value = 0.86;
  mixBus.connect(mixSafety);
  mixSafety.connect(mixHeadroom);
  mixHeadroom.connect(destination);
  const mixingMicAndSystem = hasMic && valid.some((track) => micTrack !== track);
  let micProcessor = null;

  valid.forEach((track) => {
    const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
    let output = source;
    if (micTrack === track) {
      // Gentle low-end roll-off: a 65 Hz high-pass keeps the full voice
      // range (male fundamentals start ~85 Hz) intact while cutting
      // fan/AC/room rumble (mostly below ~100 Hz).
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 65;
      highpass.Q.value = 0.7;
      source.connect(highpass);
      // De-boom low-shelf (see the module header): laptop mics + rooms
      // inject excess sub-200 Hz energy that buries the voice's clarity
      // band. Trimming it before the AGC means the leveler re-normalizes
      // afterwards, so loudness is preserved while the voice gets clearer.
      const deboom = audioCtx.createBiquadFilter();
      deboom.type = 'lowshelf';
      deboom.frequency.value = 200;
      deboom.gain.value = processMic ? -2 : -2;
      highpass.connect(deboom);
      let voiceOutput = deboom;
      if (runMicDsp) {
        // RNNoise denoise (only when Voice Enhance is on) + voice-safe
        // auto-gain; the opt-in noise gate mutes the mic unless speech is
        // detected. rnnoise:false keeps the denoiser off when the user
        // turned Voice Enhance off but still wants the gate.
        const proc = srpCreateMicProcessor(audioCtx, deboom, {
          noiseGate,
          rnnoise: processMic
        });
        micProcessor = proc;
        voiceOutput = proc.node;
      } else {
        // Denoising off still gets a basic clarity/level chain. This does
        // not remove ambient sound; it only catches peaks and keeps quiet
        // speech usable, while browser input AGC handles weak microphones.
        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 18;
        compressor.ratio.value = 3;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.22;
        deboom.connect(compressor);
        voiceOutput = compressor;
      }
      // A small presence lift makes close speech easier to understand.
      const presence = audioCtx.createBiquadFilter();
      presence.type = 'highshelf';
      presence.frequency.value = 2600;
      presence.gain.value = processMic ? 1.5 : 1.0;
      voiceOutput.connect(presence);
      output = presence;
    } else if (mixingMicAndSystem) {
      const systemGain = audioCtx.createGain();
      // Area mode does not pass systemMixGain and therefore keeps the
      // historical 0.72 balance. Screen/window can request a voice-priority
      // mix without changing the shared Area audio path.
      systemGain.gain.value = systemMixGain != null ? systemMixGain : 0.72;
      output.connect(systemGain);
      output = systemGain;
    }
    output.connect(mixBus);
  });

  const outTrack = destination.stream.getAudioTracks()[0] || null;
  if (micProcessor) {
    // Free the WASM denoise state + processing node as soon as recording
    // stops, so long-lived tabs don't accumulate RNNoise memory across
    // recordings. Three independent triggers, all idempotent:
    //  1. the MIC INPUT track ending — both recorders stop the mic stream
    //     in their stop handlers, and the mixed destination track isn't
    //     always stopped (area mode), so this is the reliable one;
    //  2. the mixed output track ending;
    //  3. the AudioContext closing.
    const release = () => micProcessor.destroy();
    if (micTrack && micTrack.addEventListener) {
      micTrack.addEventListener('ended', release, { once: true });
    }
    if (outTrack) outTrack.addEventListener('ended', release, { once: true });
    audioCtx.addEventListener('statechange', () => {
      if (audioCtx.state === 'closed') release();
    }, { once: true });
  }

  return outTrack;
}

/* ================================================================
 * MIC ENHANCEMENT ENGINE — RNNoise (WASM) + voice-safe auto-gain
 * ================================================================
 *
 * Both host contexts (the offscreen document and the area-recording
 * content script) load shared/vendor/rnnoise.js BEFORE this file, so
 * self.SRPRnnoise (the vendored { Rnnoise, DenoiseState } pair) exists
 * here. Loading is lazy + cached: the WASM (~1.7 MB binary, embedded
 * base64 in the vendor script) is decoded and instantiated once per
 * context, asynchronously, while recording starts — the DSP runs in a
 * safe auto-gain-only mode until it's ready, so there's never a stall.
 */

let _srpRnnoisePromise = null;

function srpGetRnnoise() {
  if (_srpRnnoisePromise) return _srpRnnoisePromise;
  _srpRnnoisePromise = (async () => {
    try {
      if (typeof self === 'undefined' || !self.SRPRnnoise) {
        // The vendored script hasn't executed yet (it's deferred in the
        // offscreen document). Don't cache the miss — the next recording
        // retries, by which time it will have run.
        _srpRnnoisePromise = null;
        return null;
      }
      return await self.SRPRnnoise.Rnnoise.load();
    } catch (err) {
      // WASM unavailable — the DSP degrades to high-pass + auto-gain.
      return null;
    }
  })();
  return _srpRnnoisePromise;
}

// Pure DSP state machine — fully unit-testable with a mock denoiser
// (see tests/mic-dsp.test.js). Processes a continuous sample stream in
// fixed-size frames (RNNoise's 480 samples ≈ 10 ms at 48 kHz), padding
// the trailing partial frame so the output count EXACTLY matches the
// input count — no drift, no periodic zero-gaps on chunk boundaries.
class SRPMicDsp {
  constructor(opts) {
    const o = opts || {};
    this.frameSize = o.frameSize || 480;
    // denoiser: { processFrame(Float32Array(frameSize)) -> vad (0..1) } | null
    this.denoiser = o.denoiser || null;
    this.targetPeak = o.targetPeak != null ? o.targetPeak : 0.38; // ~-8.4 dBFS
    this.minGain = o.minGain != null ? o.minGain : 0.5;
    this.maxGain = o.maxGain != null ? o.maxGain : 4;             // up to +12 dB
    // Per-frame (~10 ms) smoothing coefficients. AGC direction matters:
    // gain cuts back FAST on loud onsets (avoid over-boost / pumping) and
    // rises GENTLY when the mic goes quiet (avoid gulping); the tracked
    // peak rises quickly but decays slowly.
    this.peakAttackCoef = 0.2;
    this.peakReleaseCoef = 0.01;
    // Boost rises in ~100 ms (was ~500 ms): a slow ramp made the first
    // moments of every recording swell up to +18 dB then pump back down
    // when speech arrived — the "broken mic" sound at recording start.
    this.gainAttackCoef = 0.2;
    this.gainReleaseCoef = 0.35; // fast cutback on loud onsets

    // Noise gate (opt-in via options.noiseGate) — see the module header.
    this.gateEnabled = !!o.noiseGate;
    // Hysteresis band: open once the smoothed score holds above
    // gateOpenVad for gateOpenFrames consecutive frames (speech sustains,
    // brief music/knock spikes don't), close only after it stays below
    // gateCloseVad for the hangover duration. 0.4/0.3 keeps quiet speech
    // (VAD ~0.4, low input energy) opening the mic while still closing
    // on room-level background (energy score ~0.06); see the module header.
    this.gateOpenVad = o.gateOpenVad != null ? o.gateOpenVad : 0.4;
    this.gateCloseVad = o.gateCloseVad != null ? o.gateCloseVad : 0.3;
    // Attack confirmation: sustained high score required before opening
    // so a single loud background spike can't unlock the mic for the
    // whole hangover. 3 frames = 30 ms — speech onsets clear it in
    // ~40 ms; quiet-but-real voices (VAD ~0.4) open too, where the old
    // 6-frame / 0.5 bar kept them muted forever.
    this.gateOpenFrames = o.gateOpenFrames != null ? o.gateOpenFrames : 3;
    // ~160 ms of grace after speech energy disappears so natural pauses
    // (syllable gaps, breaths) don't chop the mic, while background is
    // cut off promptly once talking stops. 1 frame = 10 ms.
    this.gateHangoverFrames = o.gateHangoverFrames != null ? o.gateHangoverFrames : 16;
    this.gateVadSmooth = o.gateVadSmooth != null ? o.gateVadSmooth : 0.35;
    // Envelope ramp per frame so gate open/close is click-free.
    this.gateAttackCoef = o.gateAttackCoef != null ? o.gateAttackCoef : 0.45;
    this.gateReleaseCoef = o.gateReleaseCoef != null ? o.gateReleaseCoef : 0.4;
    // Input-energy hysteresis floors (raw pre-denoise RMS, 0..1). With
    // Chrome's AGC on a normal mic, speech sits ~0.05-0.3 and room
    // background ~0.005-0.03; the floors map that band onto the score.
    // Lowered from 0.05/0.018 so speech from ~0.022 RMS (quiet mics)
    // opens the gate on energy alone instead of depending on VAD.
    this.gateEnergyOpenFloor = o.gateEnergyOpenFloor != null ? o.gateEnergyOpenFloor : 0.035;
    this.gateEnergyCloseFloor = o.gateEnergyCloseFloor != null ? o.gateEnergyCloseFloor : 0.014;
    // Fail-open latch (see the module header): if the gate stays closed
    // while the raw input carries clearly-audible audio (>= gateUnlock-
    // Floor 0.05 — well above room tone and brief knocks) for a sustained
    // accumulated stretch (gateUnlockFrames ≈ 1.5 s), the speech detector
    // is failing for this input — unlock permanently so the voice can
    // never be erased.
    this.gateUnlockFrames = o.gateUnlockFrames != null ? o.gateUnlockFrames : 150;
    this.gateUnlockFloor = o.gateUnlockFloor != null ? o.gateUnlockFloor : 0.05;
    // RMS (0..1) that counts as "energy = speech" when RNNoise isn't
    // loaded yet (~-29 dBFS: quiet speech sits above this, room tone
    // and distant music sit below it).
    this.gateEnergyThreshold = o.gateEnergyThreshold != null ? o.gateEnergyThreshold : 0.035;

    // Voice-preservation blend (see the module header step 3): RNNoise's
    // output may collapse for soft / accented / distant voices even when
    // its own VAD classified the frame as speech. The blend mixes a
    // portion of the raw pre-denoise frame back in whenever that happens,
    // smoothed per frame so it never pumps. A frame only counts when
    // VAD >= voicePreserveVad (0.5 — RNNoise is clearly calling it
    // speech) AND the raw peak is real audio (>= voicePreserveMinPeak)
    // AND the denoised peak fell below voicePreserveCollapse of the
    // input; the blend then rises to at most voicePreserveMix. Fan hum
    // and soft music score VAD well below 0.5 and never trigger it.
    this.voicePreserveVad = o.voicePreserveVad != null ? o.voicePreserveVad : 0.5;
    this.voicePreserveMinPeak = o.voicePreserveMinPeak != null ? o.voicePreserveMinPeak : 0.03;
    this.voicePreserveCollapse = o.voicePreserveCollapse != null ? o.voicePreserveCollapse : 0.5;
    this.voicePreserveMix = o.voicePreserveMix != null ? o.voicePreserveMix : 0.5;
    this.voicePreserveSmooth = o.voicePreserveSmooth != null ? o.voicePreserveSmooth : 0.2;

    this._inBuf = new Float32Array(this.frameSize * 2);
    this._inLen = 0;
    this._outBuf = new Float32Array(this.frameSize * 4);
    // Prime one RNNoise frame of silence. This creates a constant 10 ms
    // processing latency and guarantees every later Web Audio callback
    // can be filled from complete frames—without periodic zero tails.
    this._outLen = this.frameSize;
    this._frame = new Float32Array(this.frameSize);
    this._rawBuf = new Float32Array(this.frameSize); // pre-denoise copy for the preserve blend
    this._blend = 0; // smoothed voice-preservation mix (0..1)
    // Tracked peak starts small (not zero) so the very first frames keep
    // a sane gain target instead of jumping straight to the +18 dB cap;
    // the faster gain attack (above) then brings quiet mics up within
    // ~100 ms instead of a long startup swell.
    this._peak = 0.02;
    this._gain = 1;
    // Gate state: start muted — nothing has been said yet.
    this._gateOpen = false;
    this._gateGain = 0;
    this._vadSm = 0;
    this._silentFrames = 0;
    this._openStreak = 0;
    // Fail-open latch state (see the module header): once unlocked the
    // mic stays live for the whole recording.
    this._unlocked = false;
    this._closedAudioFrames = 0;
  }

  // Feed a chunk of Float32 samples (typically 4096 from a ScriptProcessor
  // event). Returns exactly chunk.length samples. Partial RNNoise frames
  // are retained for the next call instead of padded and processed on
  // every callback; that old padding introduced a small artificial edge
  // about every 85 ms and made otherwise clean speech sound grainy.
  process(chunk) {
    const frameSize = this.frameSize;
    const out = new Float32Array(chunk.length);
    this._ensureCap(this._inLen + chunk.length);
    this._inBuf.set(chunk, this._inLen);
    this._inLen += chunk.length;

    while (this._inLen >= frameSize) {
      this._frame.set(this._inBuf.subarray(0, frameSize));
      this._inBuf.copyWithin(0, frameSize, this._inLen);
      this._inLen -= frameSize;
      this._processFrame(this._frame);
      this._ensureOutCap(this._outLen + frameSize);
      this._outBuf.set(this._frame, this._outLen);
      this._outLen += frameSize;
    }

    // A fixed-size Web Audio callback cannot wait for the remaining part
    // of an RNNoise frame. The queue is pre-rolled with one silent frame,
    // giving a fixed 10 ms startup latency; thereafter it stays continuous.
    const available = Math.min(chunk.length, this._outLen);
    if (available > 0) {
      out.set(this._outBuf.subarray(0, available));
      this._outBuf.copyWithin(0, available, this._outLen);
      this._outLen -= available;
    }
    return out;
  }

  _ensureCap(n) {
    if (n <= this._inBuf.length) return;
    const nb = new Float32Array(Math.max(n, this._inBuf.length * 2));
    nb.set(this._inBuf.subarray(0, this._inLen));
    this._inBuf = nb;
  }

  _ensureOutCap(n) {
    if (n <= this._outBuf.length) return;
    const nb = new Float32Array(Math.max(n, this._outBuf.length * 2));
    nb.set(this._outBuf.subarray(0, this._outLen));
    this._outBuf = nb;
  }

  // Process one complete frame in place. Denoise, level, then limit,
  // then optionally gate.
  _processFrame(frame) {
    const n = frame.length;
    // 0) Capture the raw input energy BEFORE denoising — the noise gate's
    // hold signal (see the module header).
    let inputRms = 0;
    if (this.gateEnabled) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += frame[i] * frame[i];
      inputRms = Math.sqrt(sum / n);
    }
    // 1) Denoise. RNNoise expects 16-bit-PCM-scaled samples and returns a
    // per-frame voice-activity probability (0..1) — captured for the
    // opt-in noise gate below. When no denoiser is loaded the gate falls
    // back to an RMS energy estimate of this same frame.
    // 1b) Snapshot the raw pre-denoise frame for the voice-preservation
    // blend (step 3) before RNNoise overwrites the buffer.
    this._rawBuf.set(frame);
    let vad = 0;
    if (this.denoiser) {
      for (let i = 0; i < n; i++) frame[i] *= 32767;
      vad = this.denoiser.processFrame(frame) || 0;
      for (let i = 0; i < n; i++) frame[i] /= 32767;
    }

    // 1c) Voice-preservation blend: if the denoiser classified this frame
    // as speech but its output collapsed relative to the input, the voice
    // is being damaged — mix raw back in so it can never be erased. See
    // the module header step 3 for the exact trigger conditions.
    if (this.denoiser && vad >= this.voicePreserveVad) {
      let inPeak = 0, outPeak = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(this._rawBuf[i]);
        if (a > inPeak) inPeak = a;
        const b = Math.abs(frame[i]);
        if (b > outPeak) outPeak = b;
      }
      const collapse = inPeak >= this.voicePreserveMinPeak
        ? Math.min(1, Math.max(0, 1 - outPeak / inPeak))
        : 0;
      const target = collapse >= this.voicePreserveCollapse
        ? collapse * this.voicePreserveMix
        : 0;
      this._blend += this.voicePreserveSmooth * (target - this._blend);
      if (this._blend > 0.001) {
        const m = this._blend;
        for (let i = 0; i < n; i++) frame[i] = frame[i] * (1 - m) + this._rawBuf[i] * m;
      }
    } else {
      this._blend = 0;
    }

    // 2) Auto-gain on the denoised signal.
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(frame[i]);
      if (a > peak) peak = a;
    }
    const pCoef = peak > this._peak ? this.peakAttackCoef : this.peakReleaseCoef;
    this._peak += pCoef * (peak - this._peak);
    const rawGain = this._peak > 1e-4 ? this.targetPeak / this._peak : this.maxGain;
    const targetGain = Math.max(this.minGain, Math.min(this.maxGain, rawGain));
    const aCoef = targetGain > this._gain ? this.gainAttackCoef : this.gainReleaseCoef;
    this._gain += aCoef * (targetGain - this._gain);

    // 3) Apply gain, then a soft limiter so the boost never clips.
    const gn = this._gain;
    for (let i = 0; i < n; i++) {
      let x = frame[i] * gn;
      const a = Math.abs(x);
      if (a > 0.9) {
        x = (x < 0 ? -1 : 1) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
      }
      frame[i] = x;
    }

    // 4) Opt-in noise gate: mute everything unless a voice is detected.
    if (this.gateEnabled) this._applyGate(frame, vad, inputRms);
  }

  // Combined voice-activity + energy gate with attack confirmation,
  // smoothing/hangover hysteresis, and a one-way fail-open latch. The
  // smoothed SCORE (max of RNNoise VAD and input energy) opens the gate
  // only after holding above the open threshold for gateOpenFrames
  // consecutive frames, and closing requires it to stay below the close
  // threshold for gateHangoverFrames (~200 ms), so brief pauses within a
  // phrase keep the mic live. The energy term is what keeps the gate
  // open when RNNoise's VAD collapses mid-phrase. If the gate instead
  // stays shut for a sustained stretch while audible input flows, the
  // latch unlocks it permanently — a live mic must never be erased (see
  // the module header). The gain envelope ramps 0<->1 so opening/closing
  // never clicks.
  _applyGate(frame, vad, inputRms) {
    let energyScore = 0;
    if (this.denoiser) {
      // RNNoise is the reference: a piecewise-linear hysteresis map on
      // the raw input level. Speech sits above openFloor, room background
      // below closeFloor, and the quiet gap in between preserves state.
      const range = this.gateEnergyOpenFloor - this.gateEnergyCloseFloor;
      energyScore = range > 0
        ? Math.max(0, Math.min(1, (inputRms - this.gateEnergyCloseFloor) / range))
        : 0;
    } else {
      // No denoiser (Voice Enhance off): plain energy, no RNNoise to
      // attenuate any leak, so the bar stays at the original level.
      energyScore = Math.min(1, inputRms / this.gateEnergyThreshold);
    }
    const score = Math.max(vad, energyScore);

    // Fail-open latch: accumulate how long the gate stays closed while
    // the raw input carries audible audio (>= gateUnlockFloor). Once it
    // passes gateUnlockFrames the speech detector is failing for this
    // input — unlock permanently (see the module header). Normal inputs
    // never reach it: real speech opens the gate in ~30 ms via the score
    // path, resetting the counter before it can build up.
    if (!this._gateOpen && !this._unlocked) {
      if (inputRms >= this.gateUnlockFloor) {
        if (++this._closedAudioFrames >= this.gateUnlockFrames) this._unlocked = true;
      }
    } else {
      this._closedAudioFrames = 0;
    }

    this._vadSm += this.gateVadSmooth * (score - this._vadSm);
    if (this._unlocked) {
      // Unlocked: the mic stays live for the whole recording.
      this._gateOpen = true;
    } else if (this._gateOpen) {
      if (this._vadSm < this.gateCloseVad) {
        if (++this._silentFrames > this.gateHangoverFrames) this._gateOpen = false;
      } else {
        this._silentFrames = 0;
      }
    } else if (this._vadSm >= this.gateOpenVad) {
      if (++this._openStreak >= this.gateOpenFrames) {
        this._gateOpen = true;
        this._openStreak = 0;
      }
    } else {
      this._openStreak = 0;
    }
    const target = this._gateOpen ? 1 : 0;
    const coef = this._gateOpen ? this.gateAttackCoef : this.gateReleaseCoef;
    this._gateGain += coef * (target - this._gateGain);
    const g = this._gateGain;
    for (let i = 0; i < frame.length; i++) frame[i] *= g;
  }

}

// Builds the ScriptProcessorNode that runs SRPMicDsp on the mic path.
// input connects to `micInput` (the high-pass output); the returned
// { node, destroy() } wires micInput -> node so the caller only connects
// node -> destination. options (noiseGate, rnnoise) flow into the DSP:
// rnnoise:false keeps RNNoise off (Voice Enhance disabled) while still
// allowing the gate's energy-based detection.
function srpCreateMicProcessor(audioCtx, micInput, options) {
  const bufferSize = 1024;
  const node = audioCtx.createScriptProcessor(bufferSize, 1, 1);
  const dsp = new SRPMicDsp({ ...(options || {}) });
  let tornDown = false;

  // Attach RNNoise as soon as it finishes loading; until then the DSP
  // runs in auto-gain mode (no audible gap). Skipped entirely when the
  // caller asked for the denoiser to stay off (gate-only mode).
  if (options && options.rnnoise === false) {
    dsp.denoiser = null;
  } else {
    srpGetRnnoise().then((rn) => {
      if (!rn || tornDown) return;
      try {
        dsp.denoiser = rn.createDenoiseState();
        // Warm RNNoise's internal state with silence before live audio:
        // a cold DenoiseState garbles/crackles on the first real frames
        // (its noise model needs a few frames to settle) — the "broken
        // mic" sound right at the start of recordings.
        const warm = new Float32Array(dsp.frameSize);
        for (let i = 0; i < 10; i++) dsp.denoiser.processFrame(warm);
        console.log('[SRP] RNNoise noise suppression engine ready');
      } catch (err) {
        console.warn('[SRP] RNNoise unavailable, falling back to voice auto-gain:', err);
        dsp.denoiser = null;
      }
    });
  }

  node.onaudioprocess = (e) => {
    if (tornDown) return;
    const input = e.inputBuffer.getChannelData(0);
    // Mono downmix: ScriptProcessor's single input channel does the
    // standard downmix for us when the mic track is stereo.
    e.outputBuffer.getChannelData(0).set(dsp.process(input));
  };

  micInput.connect(node);

  return {
    node,
    destroy() {
      if (tornDown) return;
      tornDown = true;
      node.onaudioprocess = null;
      try { node.disconnect(); } catch (err) { /* already disconnected */ }
      if (dsp.denoiser) {
        try { dsp.denoiser.destroy(); } catch (err) { /* noop */ }
        dsp.denoiser = null;
      }
    }
  };
}

// Node test hook — the browser build never defines `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { srpMixAudioTracks, srpGetRnnoise, srpCreateMicProcessor, SRPMicDsp };
}
