const grid = document.getElementById('grid');
const emptyState = document.getElementById('empty');
const player = document.getElementById('player');
const playerVideo = document.getElementById('playerVideo');
const playerBackdrop = document.getElementById('playerBackdrop');
const closePlayerBtn = document.getElementById('closePlayer');

let currentObjectUrl = null;
let playerReturnFocus = null;

function formatDuration(totalSeconds) {
  const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function formatSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function render() {
  const items = await SRPDB.getAllMeta();

  if (items.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  grid.innerHTML = '';
  for (const item of items) {
    grid.appendChild(buildCard(item));
  }
}

function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';
  thumbWrap.title = 'Click to play';

  if (item.thumbnail) {
    const img = document.createElement('img');
    img.src = item.thumbnail;
    thumbWrap.appendChild(img);
  } else {
    const noThumb = document.createElement('div');
    noThumb.className = 'no-thumb';
    // The .no-thumb box is styled for a glyph (centered, 30px) — without
    // content it renders as a blank dark rectangle. Recovered recordings
    // always save without a thumbnail, so this placeholder is a common
    // sight and needs a visible mark (the aria-label alone is invisible).
    noThumb.textContent = '🎬';
    noThumb.setAttribute('aria-label', 'No preview available');
    thumbWrap.appendChild(noThumb);
  }

  const modeChip = document.createElement('span');
  modeChip.className = 'mode-chip';
  const MODE_LABELS = { area: 'Area', tab: 'Tab', screen: 'Screen' };
  modeChip.textContent = MODE_LABELS[item.mode] || item.mode || 'Recording';
  thumbWrap.appendChild(modeChip);

  const durationChip = document.createElement('span');
  durationChip.className = 'duration-chip';
  durationChip.textContent = formatDuration(item.duration);
  thumbWrap.appendChild(durationChip);

  thumbWrap.addEventListener('click', () => playRecording(item.id));
  thumbWrap.setAttribute('role', 'button');
  thumbWrap.setAttribute('tabindex', '0');
  thumbWrap.setAttribute('aria-label', 'Play recording');
  thumbWrap.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      playRecording(item.id);
    }
  });

  const body = document.createElement('div');
  body.className = 'card-body';

  const meta = document.createElement('div');
  meta.className = 'meta';
  // The recorded resolution is the real pixel size of the file. It is
  // always even in modern recordings (odd sizes get rounded so platforms
  // don't pad the bottom edge) — showing it here makes that easy to
  // verify at a glance.
  const metaValues = [formatDate(item.createdAt), formatSize(item.size)];
  if (item.resolution) metaValues.push(String(item.resolution));
  for (const value of metaValues) {
    const span = document.createElement('span');
    span.textContent = value;
    meta.appendChild(span);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'download-btn';
  downloadBtn.textContent = 'Download';
  downloadBtn.addEventListener('click', () => downloadRecording(item.id));

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.title = 'Trim, cut and crop this recording in the video editor';
  editBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('history/editor.html?id=' + encodeURIComponent(item.id)) });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteRecording(item.id));

  actions.appendChild(downloadBtn);
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  body.appendChild(meta);
  body.appendChild(actions);

  card.appendChild(thumbWrap);
  card.appendChild(body);
  return card;
}

async function playRecording(id) {
  const record = await SRPDB.getRecording(id);
  if (!record) return;
  playerReturnFocus = document.activeElement;
  revokeCurrentUrl();
  const blob = new Blob([record.buffer], { type: record.mimeType || 'video/webm' });
  currentObjectUrl = URL.createObjectURL(blob);
  playerVideo.src = currentObjectUrl;
  player.classList.remove('hidden');
  closePlayerBtn.focus();
}

async function downloadRecording(id) {
  const record = await SRPDB.getRecording(id);
  if (!record) return;
  const blob = new Blob([record.buffer], { type: record.mimeType || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${record.id}.${srpMimeExtension(record.mimeType)}`;
  a.click();
  // Let Chrome begin reading the object URL before releasing it. Immediate
  // revocation can race the download on slower machines.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deleteRecording(id) {
  if (!window.confirm('Delete this recording permanently?')) return;
  await SRPDB.deleteRecording(id);
  render();
}

function revokeCurrentUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function closePlayer() {
  player.classList.add('hidden');
  playerVideo.pause();
  playerVideo.removeAttribute('src');
  playerVideo.load();
  revokeCurrentUrl();
  if (playerReturnFocus && typeof playerReturnFocus.focus === 'function') playerReturnFocus.focus();
  playerReturnFocus = null;
}

closePlayerBtn.addEventListener('click', closePlayer);
playerBackdrop.addEventListener('click', closePlayer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !player.classList.contains('hidden')) closePlayer();
});

render();
