// IndexedDB helper for the Recording History feature.
//
// All extension-owned pages (background service worker, offscreen.html,
// history.html) share the same chrome-extension://<id> origin, so they
// all see the same IndexedDB database. Content scripts do NOT share this
// origin (they run in the visited page's origin), so the area-recording
// content script never touches IndexedDB directly — it sends the
// recorded buffer to the background service worker via
// chrome.runtime.sendMessage, and the background worker writes it here.
//
// Loaded via importScripts() in background.js (classic service worker)
// and via <script src> in offscreen.html / history.html. Exposes a
// single global: SRPDB.
const SRPDB = (() => {
  const DB_NAME = 'srp-history-db';
  const DB_VERSION = 3;
  const STORE = 'recordings';
  // Spill store for very long recordings: the offscreen document flushes
  // chunks into IndexedDB every so often so it never holds the whole
  // video in memory (which made long recordings balloon memory until
  // Chrome killed the document mid-recording). Rows are keyed
  // `${sessionId}_${seq}` and assembled back into one buffer on stop.
  const SPILL_STORE = 'spill';
  // Crash-recovery snapshot store: the recorders append small deltas
  // (every ~5s) while recording. If Chrome crashes or the extension is
  // reloaded mid-recording, the surviving rows are reassembled and
  // offered back to the user (recoverFromCrash in background.js).
  const RECOVERY_STORE = 'recovery';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(SPILL_STORE)) {
          db.createObjectStore(SPILL_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(RECOVERY_STORE)) {
          db.createObjectStore(RECOVERY_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // buffer must be an ArrayBuffer (not a Blob) — Blobs don't survive
  // structured clone the same way across all contexts as reliably as
  // ArrayBuffers do, so callers convert with `await blob.arrayBuffer()`
  // before getting here.
  async function addRecording({ buffer, mimeType, thumbnail, mode, duration, resolution }) {
    const db = await openDB();
    const record = {
      id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      mimeType: mimeType || 'video/webm',
      size: buffer.byteLength,
      thumbnail: thumbnail || null,
      mode: mode || 'unknown',
      duration: duration || 0,
      resolution: resolution || null,
      buffer
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(record);
      tx.oncomplete = () => resolve(record.id);
      tx.onerror = () => reject(tx.error);
    });
  }

  // Returns metadata only (no video buffer) — cheap, used for the gallery list.
  async function getAllMeta() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const all = req.result.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          mimeType: r.mimeType,
          size: r.size,
          thumbnail: r.thumbnail,
          mode: r.mode,
          duration: r.duration,
          resolution: r.resolution
        }));
        all.sort((a, b) => b.createdAt - a.createdAt);
        resolve(all);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Returns the full record including the video buffer — used when the
  // user actually plays or downloads a specific recording.
  async function getRecording(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteRecording(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Keeps IndexedDB from growing unbounded — recordings can be tens or
  // hundreds of MB each. Oldest recordings past maxCount are dropped.
  async function pruneOldest(maxCount) {
    const all = await getAllMeta();
    if (all.length <= maxCount) return;
    const toDelete = all.slice(maxCount);
    for (const item of toDelete) {
      await deleteRecording(item.id);
    }
  }

  // --- Long-recording spill store ---

  async function spillSave(id, buffer) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SPILL_STORE, 'readwrite');
      tx.objectStore(SPILL_STORE).add({ id, buffer });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Returns the spilled buffers for one recording session, in chunk
  // order (by the numeric suffix of their key).
  async function spillGetAll(sessionPrefix) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SPILL_STORE, 'readonly');
      const req = tx.objectStore(SPILL_STORE).getAll();
      req.onsuccess = () => {
        const parts = req.result
          .filter((r) => r.id && r.id.startsWith(sessionPrefix + '_'))
          .sort((a, b) => {
            const na = parseInt(String(a.id).split('_').pop(), 10);
            const nb = parseInt(String(b.id).split('_').pop(), 10);
            return na - nb;
          })
          .map((r) => r.buffer);
        resolve(parts);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Removes all spill rows for a session once its chunks have been
  // assembled into the final recording.
  async function spillClear(sessionPrefix) {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(SPILL_STORE, 'readonly');
      const req = tx.objectStore(SPILL_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const ids = rows.filter((r) => r.id && r.id.startsWith(sessionPrefix + '_')).map((r) => r.id);
    if (ids.length === 0) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SPILL_STORE, 'readwrite');
      const store = tx.objectStore(SPILL_STORE);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- Crash-recovery snapshot store ---
  // recoveryAppend adds one row per checkpoint (small, cheap); the meta
  // row tracks the sequence counter, the last-updated timestamp (used to
  // decide whether a snapshot is stale = from a dead recording) and the
  // recording's mode/resolution for the recovered history entry.

  async function recoveryAppend(buffer, meta) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECOVERY_STORE, 'readwrite');
      const store = tx.objectStore(RECOVERY_STORE);
      const metaReq = store.get('meta');
      metaReq.onsuccess = () => {
        const m = metaReq.result || { id: 'meta', seq: 0, lastUpdatedAt: 0, mode: null, resolution: null, mimeType: null };
        m.seq += 1;
        m.lastUpdatedAt = Date.now();
        if (meta) {
          if (meta.mode) m.mode = meta.mode;
          if (meta.resolution) m.resolution = meta.resolution;
          // Remember which container the recording was in so a recovered
          // file is labeled and repaired correctly (WebM repair must not
          // run over MP4 bytes).
          if (meta.mimeType) m.mimeType = meta.mimeType;
        }
        store.put(m);
        store.put({ id: 'rec_' + m.seq, buffer, updatedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Refreshes the snapshot's timestamp without appending bytes — sent
  // while a recording is paused so a merely-paused recording is never
  // mistaken for a crashed one.
  async function recoveryHeartbeat() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECOVERY_STORE, 'readwrite');
      const store = tx.objectStore(RECOVERY_STORE);
      const metaReq = store.get('meta');
      metaReq.onsuccess = () => {
        const m = metaReq.result;
        if (!m) { resolve(); return; }
        m.lastUpdatedAt = Date.now();
        store.put(m);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Metadata only (freshness + mode), used by the crash-recovery check.
  async function recoveryStatus() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECOVERY_STORE, 'readonly');
      const req = tx.objectStore(RECOVERY_STORE).get('meta');
      req.onsuccess = () => {
        const m = req.result;
        if (!m || !m.seq) return resolve(null);
        resolve({ count: m.seq, lastUpdatedAt: m.lastUpdatedAt, mode: m.mode || 'unknown', resolution: m.resolution || null, mimeType: m.mimeType || null });
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Concatenates every checkpoint row back into one ArrayBuffer.
  async function recoveryAssemble() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECOVERY_STORE, 'readonly');
      const req = tx.objectStore(RECOVERY_STORE).getAll();
      req.onsuccess = () => {
        const parts = req.result
          .filter((r) => r.id && r.id.startsWith('rec_'))
          .sort((a, b) => parseInt(String(a.id).split('_')[1], 10) - parseInt(String(b.id).split('_')[1], 10))
          .map((r) => r.buffer);
        if (!parts.length) return resolve(null);
        const total = parts.reduce((s, p) => s + p.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
          merged.set(new Uint8Array(p), off);
          off += p.byteLength;
        }
        resolve(merged.buffer);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function recoveryClear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(RECOVERY_STORE, 'readwrite');
      tx.objectStore(RECOVERY_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { addRecording, getAllMeta, getRecording, deleteRecording, pruneOldest, spillSave, spillGetAll, spillClear, recoveryAppend, recoveryHeartbeat, recoveryStatus, recoveryAssemble, recoveryClear };
})();
