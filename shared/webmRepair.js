// shared/webmRepair.js
//
// Repairs a crash-recovered MediaRecorder WebM so it actually plays.
//
// Why this exists: a normally-stopped MediaRecorder writes its container
// finalization (Segment duration, Cues seek index) ONLY when stop() is
// called. When Chrome crashes mid-recording, the recovery snapshot is a
// byte-accurate prefix of the stream — the Segment size is still the
// streaming "unknown" marker, there is no Duration/Cues, and the cut
// almost always lands in the MIDDLE of the final Cluster, leaving a
// broken trailing element. Chrome's demuxer rejects such a file with
// "Playback was terminated automatically. Reason: unrecognized format".
//
// The fix (the standard approach used by fix-webm-meta / ts-ebml):
//   1. Walk the EBML structure and find the end of the last COMPLETE
//      element inside the Segment — anything after it (a truncated
//      cluster, stray bytes) is dropped. This is what makes the file
//      parse again.
//   2. Inject a Duration element into Segment > Info, taken from the
//      last complete Cluster's Timecode, so the file reports a real
//      duration instead of Infinity.
//
// Cues (seek index) are deliberately NOT rebuilt: playback and duration
// work without them, and hand-building a correct Cues element is the
// riskiest part of the whole operation. A recovered file may seek
// imprecisely, which is a fair trade for a crash-recovery artifact.
//
// Best-effort by design: if the input isn't parseable WebM, the original
// bytes are returned untouched (the caller still saves whatever it had).
// The trim always wins over the duration injection — a file that parses
// with unknown duration beats an unparseable one.

(function () {
  // Element IDs in their marker-stripped numeric form (what the vint
  // reader yields). Raw ID byte sequences are written directly where
  // elements are built.
  var EBML_ID = 0x0A45DFA3; // 1A 45 DF A3
  var SEGMENT_ID = 0x08538067; // 18 53 80 67
  var INFO_ID = 0x0549A966; // 15 49 A9 66
  var CLUSTER_ID = 0x0F43B675; // 1F 43 B6 75
  var TIMECODE_ID = 0x67; // E7
  var DURATION_ID = 0x0489; // 44 89

  // Reads a big-endian variable-length integer (EBML ID or size) at pos.
  // Returns { value, length } or null when the bytes are invalid/short.
  // The returned value is the integer with the length-marker bits
  // cleared (sizes < 2^53 are exact in JS, which is all we compare).
  function srpReadVint(bytes, pos) {
    if (pos < 0 || pos >= bytes.length) return null;
    var first = bytes[pos];
    var mask = 0x80;
    var length = 1;
    while (length <= 8 && !(first & mask)) {
      mask >>= 1;
      length++;
    }
    if (length > 8) return null;
    var value = first & (mask - 1);
    for (var i = 1; i < length; i++) {
      if (pos + i >= bytes.length) return null;
      value = value * 256 + bytes[pos + i];
    }
    return { value: value, length: length };
  }

  // Encodes an integer as a minimal EBML size vint (used for the
  // rewritten Info element).
  function srpEncodeVint(value) {
    var length = 1;
    while (value >= Math.pow(2, 7 * length)) length++;
    var out = new Uint8Array(length);
    for (var i = length - 1; i >= 0; i--) {
      out[i] = value & 0xff;
      value = Math.floor(value / 256);
    }
    out[0] |= 0x80 >> (length - 1);
    return out;
  }

  // True when an element with the given ID appears anywhere in
  // [start, end) of a master element's payload.
  function srpHasElement(bytes, start, end, targetId) {
    var pos = start;
    while (pos + 1 < end) {
      var id = srpReadVint(bytes, pos);
      if (!id) break;
      pos += id.length;
      var size = srpReadVint(bytes, pos);
      if (!size) break;
      pos += size.length;
      if (size.value > end - pos) break;
      if (id.value === targetId) return true;
      pos += size.value;
    }
    return false;
  }

  // Returns the value of the first Timecode (0xE7) element inside
  // [start, end) of a Cluster, or null. Timecode units match the
  // Segment's TimecodeScale (default 1ms), the same units Duration uses.
  function srpFindTimecode(bytes, start, end) {
    var pos = start;
    while (pos + 1 < end) {
      var id = srpReadVint(bytes, pos);
      if (!id) break;
      pos += id.length;
      var size = srpReadVint(bytes, pos);
      if (!size) break;
      pos += size.length;
      if (size.value > end - pos) break;
      if (id.value === TIMECODE_ID && size.value > 0 && size.value <= 8) {
        var value = 0;
        for (var i = 0; i < size.value; i++) value = value * 256 + bytes[pos + i];
        return value;
      }
      pos += size.value;
    }
    return null;
  }

  // Rebuilds the Segment > Info element with a Duration child appended
  // (only when it doesn't already have one). The original Info payload
  // bytes are preserved verbatim; Duration is written as an 8-byte
  // big-endian float in TimecodeScale units.
  function srpBuildInfoWithDuration(bytes, start, end, timecode) {
    var pos = start;
    var id = srpReadVint(bytes, pos);
    pos += id.length;
    var oldSize = srpReadVint(bytes, pos);
    pos += oldSize.length;
    var payload = bytes.slice(pos, end);

    // Duration element: id 44 89, size 8 (0x88), 8-byte float64 BE.
    var durBytes = new Uint8Array(2 + 1 + 8);
    durBytes[0] = 0x44;
    durBytes[1] = 0x89;
    durBytes[2] = 0x88;
    new DataView(durBytes.buffer).setFloat64(3, timecode, false);

    var newSizeVint = srpEncodeVint(payload.length + durBytes.length);
    var out = new Uint8Array(id.length + newSizeVint.length + payload.length + durBytes.length);
    var o = 0;
    out.set(bytes.subarray(start, start + id.length), o);
    o += id.length;
    out.set(newSizeVint, o);
    o += newSizeVint.length;
    out.set(payload, o);
    o += payload.length;
    out.set(durBytes, o);
    return out;
  }

  // Repairs a truncated MediaRecorder WebM (see header comment).
  // Accepts an ArrayBuffer, returns an ArrayBuffer.
  function srpRepairWebM(arrayBuffer) {
    var trimmed = arrayBuffer;
    try {
      var src = new Uint8Array(arrayBuffer);
      var total = src.length;
      var pos = 0;

      // --- EBML header (doctype etc.) ---
      var hdrId = srpReadVint(src, pos);
      if (!hdrId || hdrId.value !== EBML_ID) return arrayBuffer;
      pos += hdrId.length;
      var hdrSize = srpReadVint(src, pos);
      if (!hdrSize || hdrSize.value > total - pos) return arrayBuffer;
      pos += hdrSize.length + hdrSize.value;

      // --- Segment ---
      var segId = srpReadVint(src, pos);
      if (!segId || segId.value !== SEGMENT_ID) return arrayBuffer;
      pos += segId.length;
      var segSize = srpReadVint(src, pos);
      if (!segSize) return arrayBuffer;
      pos += segSize.length;
      // The Segment size is the streaming "unknown" marker in a
      // truncated file — ignore it and walk children to EOF. (A
      // finalized Segment has a real size, but walking to EOF is still
      // correct: children end before that anyway.)
      var segmentEnd = total;

      var lastCompleteEnd = pos; // end of the last fully-parsed child
      var infoRange = null; // { start, end } of Segment > Info
      var infoHasDuration = false;
      var lastClusterTimecode = null;

      while (pos + 1 < segmentEnd) {
        var childStart = pos;
        var id = srpReadVint(src, pos);
        if (!id) break;
        pos += id.length;
        var size = srpReadVint(src, pos);
        if (!size) break;
        pos += size.length;
        // Incomplete/absurd child (this is where the crash cut lands):
        // stop and trim everything from here on.
        if (size.value > segmentEnd - pos) break;
        var childEnd = pos + size.value;
        if (id.value === INFO_ID) {
          infoRange = { start: childStart, end: childEnd };
          infoHasDuration = srpHasElement(src, pos, childEnd, DURATION_ID);
        } else if (id.value === CLUSTER_ID) {
          var tc = srpFindTimecode(src, pos, childEnd);
          if (tc !== null) lastClusterTimecode = tc;
        }
        pos = childEnd;
        lastCompleteEnd = pos;
      }

      // The trim is the critical fix — always apply it.
      trimmed = src.slice(0, lastCompleteEnd).buffer;
      if (!infoRange) return trimmed;

      // Optional polish: give the file a real duration.
      if (lastClusterTimecode !== null && !infoHasDuration) {
        var newInfo = srpBuildInfoWithDuration(src, infoRange.start, infoRange.end, lastClusterTimecode);
        var head = new Uint8Array(trimmed, 0, infoRange.start);
        var tail = new Uint8Array(trimmed, infoRange.end);
        var out = new Uint8Array(head.length + newInfo.length + tail.length);
        out.set(head, 0);
        out.set(newInfo, head.length);
        out.set(tail, head.length + newInfo.length);
        return out.buffer;
      }
      return trimmed;
    } catch (e) {
      // Never make things worse: return whatever was safely parsed.
      return trimmed;
    }
  }

  // Expose on the global (service worker `self`, or window in a page).
  var globalScope = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null);
  if (globalScope) globalScope.srpRepairWebM = srpRepairWebM;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { srpRepairWebM: srpRepairWebM };
  }
})();
