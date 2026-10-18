/* =====================================================================
 * Batch MP4 -> Audio converter (client-side, Web Audio API)
 * Layers: Config -> Pure helpers -> Audio pipeline -> ZIP -> Queue/UI
 * NOTE: Output is a standard 16-bit PCM WAV container saved with a
 * ".mp3" extension, as specified. Most players sniff the header and
 * play it, but it is NOT MPEG-compressed. Bitrate maps to sample rate.
 * ===================================================================== */
'use strict';

/* ---------- 1. Config ---------- */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;           // decodeAudioData loads the whole file into RAM
const BITRATE_TO_SAMPLE_RATE = { 128: 32000, 192: 44100, 320: 48000 };
const ENCODE_CHUNK_FRAMES = 1 << 17;                 // frames per encoding slice (keeps UI responsive)

/* ---------- 2. State ---------- */
/** @typedef {{id:string,file:File,duration:number,status:'waiting'|'decoding'|'packaging'|'done'|'error',
 *   progress:number,blob:Blob|null,url:string|null,error:string,el:HTMLElement|null}} QueueItem */
/** @type {QueueItem[]} */
let queue = [];
let isConverting = false;
let idCounter = 0;

/* ---------- 3. DOM ---------- */
const $ = (id) => document.getElementById(id);
const dom = {
  dropzone: $('dropzone'), input: $('fileInput'), notice: $('notice'),
  section: $('queueSection'), list: $('queueList'), count: $('queueCount'),
  bitrate: $('bitrate'), convertAll: $('convertAll'), downloadAll: $('downloadAll'),
  clearAll: $('clearAll'), theme: $('themeToggle'),
};

/* ---------- 4. Pure helpers ---------- */
/** @param {number} bytes @returns {string} size in MB */
const formatSize = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

/** @param {number} sec @returns {string} mm:ss */
function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const total = Math.round(sec);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Replaces the file extension with .mp3 */
const toMp3Name = (name) => `${name.replace(/\.[^./\\]+$/, '') || 'audio'}.mp3`;

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Reads video duration through a detached <video> element. Resolves NaN on failure. */
function readDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const finish = (value) => { URL.revokeObjectURL(url); video.removeAttribute('src'); video.load(); resolve(value); };
    video.preload = 'metadata';
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(NaN);
    video.src = url;
  });
}

/* ---------- 5. Audio pipeline ---------- */
/** Decodes the audio track of a media file into an AudioBuffer. Throws on failure. */
async function decodeFileAudio(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio API is not supported in this browser.');
  const ctx = new AudioCtx();
  try {
    const data = await file.arrayBuffer();
    // Promise form; Safari older versions need callback form, so wrap both.
    return await new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject));
  } catch (err) {
    throw new Error('No decodable audio track found in this file.');
  } finally {
    ctx.close().catch(() => {});
  }
}

/** Resamples a buffer to targetRate using an OfflineAudioContext (no-op if equal). */
async function resample(buffer, targetRate) {
  if (buffer.sampleRate === targetRate) return buffer;
  const frames = Math.ceil(buffer.duration * targetRate);
  const offline = new OfflineAudioContext(buffer.numberOfChannels, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/**
 * Interleaves multi-channel float PCM into a 16-bit WAV Blob.
 * @param {AudioBuffer} buffer
 * @param {(fraction:number)=>void} onProgress called with 0..1
 */
async function encodeWav(buffer, onProgress) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const dataBytes = frames * channels * 2;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const writeText = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

  // RIFF/WAVE header (PCM)
  writeText(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, dataBytes, true);

  const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const pcm = new Int16Array(out, 44);
  for (let start = 0; start < frames; start += ENCODE_CHUNK_FRAMES) {
    const end = Math.min(start + ENCODE_CHUNK_FRAMES, frames);
    for (let i = start; i < end; i++) {
      for (let c = 0; c < channels; c++) {
        const s = Math.max(-1, Math.min(1, channelData[c][i]));
        pcm[i * channels + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    onProgress(end / frames);
    await nextFrame();                               // yield so progress bars repaint
  }
  return new Blob([out], { type: 'audio/mpeg' });
}

/* ---------- 6. Minimal ZIP writer (store, no compression) ---------- */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {{name:string,blob:Blob}[]} files @returns {Promise<Blob>} */
async function buildZip(files) {
  const encoder = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, blob } of files) {
    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local.buffer, nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true); entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true); entry.setUint32(42, offset, true);
    central.push(entry.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, p) => sum + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/* ---------- 7. Queue management ---------- */
/** Validates and adds files to the queue. Shows a notice for rejected files. */
async function addFiles(fileList) {
  const rejected = [];
  const accepted = [];
  for (const file of fileList) {
    const looksLikeVideo = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name);
    if (!looksLikeVideo) rejected.push(`${file.name} (not a video)`);
    else if (file.size === 0) rejected.push(`${file.name} (empty file)`);
    else if (file.size > MAX_FILE_BYTES) rejected.push(`${file.name} (over 1 GB)`);
    else accepted.push(file);
  }
  showNotice(rejected.length ? `Skipped: ${rejected.join(', ')}` : '');

  for (const file of accepted) {
    /** @type {QueueItem} */
    const item = { id: `item-${++idCounter}`, file, duration: NaN, status: 'waiting', progress: 0,
                   blob: null, url: null, error: '', el: null };
    queue.push(item);
    item.el = createItemElement(item);
    dom.list.appendChild(item.el);
    readDuration(file).then((d) => { item.duration = d; renderItem(item); });
  }
  refreshControls();
}

function removeItem(id) {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  if (item.url) URL.revokeObjectURL(item.url);       // free blob memory
  item.el.remove();
  queue = queue.filter((q) => q.id !== id);
  refreshControls();
}

function clearQueue() {
  queue.forEach((item) => item.url && URL.revokeObjectURL(item.url));
  queue = [];
  dom.list.replaceChildren();
  showNotice('');
  refreshControls();
}

/** Converts one item end-to-end, updating state + UI. Never throws. */
async function convertItem(item, sampleRate) {
  try {
    if (item.url) { URL.revokeObjectURL(item.url); item.url = null; }
    setStatus(item, 'decoding', 10);
    const decoded = await decodeFileAudio(item.file);
    setStatus(item, 'decoding', 35);
    const resampled = await resample(decoded, sampleRate);
    setStatus(item, 'packaging', 45);
    item.blob = await encodeWav(resampled, (f) => setStatus(item, 'packaging', 45 + Math.round(f * 54)));
    item.url = URL.createObjectURL(item.blob);
    setStatus(item, 'done', 100);
  } catch (err) {
    console.error(`Conversion failed for ${item.file.name}:`, err);
    item.error = err.message || 'Conversion failed.';
    setStatus(item, 'error', 100);
  }
}

/** Sequential on purpose: parallel decodes of large videos exhaust memory. */
async function convertAll() {
  if (isConverting) return;
  isConverting = true; refreshControls();
  const sampleRate = BITRATE_TO_SAMPLE_RATE[dom.bitrate.value];
  for (const item of [...queue]) {
    if (item.status !== 'done' && queue.includes(item)) await convertItem(item, sampleRate);
  }
  isConverting = false; refreshControls();
}

/* ---------- 8. Downloads ---------- */
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

async function downloadAllAsZip() {
  const used = new Map();
  const files = queue.filter((q) => q.blob).map((q) => {
    let name = toMp3Name(q.file.name);
    const n = used.get(name) ?? 0; used.set(name, n + 1);
    if (n) name = name.replace(/\.mp3$/, ` (${n}).mp3`);   // de-duplicate identical names
    return { name, blob: q.blob };
  });
  if (!files.length) return;
  const zip = await buildZip(files);
  const url = URL.createObjectURL(zip);
  triggerDownload(url, 'converted-audio.zip');
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- 9. Rendering ---------- */
function showNotice(message) { dom.notice.textContent = message; dom.notice.hidden = !message; }

function setStatus(item, status, progress) { item.status = status; item.progress = progress; renderItem(item); }

const STATUS_LABEL = { waiting: 'Waiting', decoding: 'Decoding...', packaging: 'Packaging...', done: 'Done', error: 'Failed' };

/** Builds the static skeleton of a row once; renderItem() only mutates it. */
function createItemElement(item) {
  const li = document.createElement('li');
  li.className = 'item'; li.dataset.testid = 'queue-item';
  li.innerHTML = `
    <div class="item-top">
      <div><div class="item-name"></div><div class="item-meta"></div></div>
      <span class="status" role="status" data-testid="item-status"></span>
    </div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar"></div></div>
    <div class="item-actions"></div>`;
  li.querySelector('.item-name').textContent = item.file.name;   // textContent: no HTML injection
  return li;
}

function renderItem(item) {
  const el = item.el;
  if (!el) return;
  el.dataset.status = item.status;
  el.querySelector('.item-meta').textContent =
    `${formatSize(item.file.size)} · ${formatDuration(item.duration)}${item.error ? ' · ' + item.error : ''}`;
  el.querySelector('.status').textContent =
    item.status === 'decoding' || item.status === 'packaging' ? `${STATUS_LABEL[item.status]} ${item.progress}%` : STATUS_LABEL[item.status];
  el.querySelector('.progress-bar').style.width = `${item.progress}%`;
  el.querySelector('.progress').setAttribute('aria-valuenow', item.progress);

  const actions = el.querySelector('.item-actions');
  const hasAudio = actions.querySelector('audio');
  if (item.status === 'done' && !hasAudio) {
    const audio = document.createElement('audio');
    audio.controls = true; audio.preload = 'metadata'; audio.src = item.url;
    const dl = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary btn-sm', textContent: 'Download MP3' });
    dl.dataset.testid = 'download-item';
    dl.addEventListener('click', () => triggerDownload(item.url, toMp3Name(item.file.name)));
    actions.prepend(audio); actions.appendChild(dl);
  } else if (item.status !== 'done' && hasAudio) {
    actions.querySelectorAll('audio, [data-testid="download-item"]').forEach((n) => n.remove());
  }
  if (!actions.querySelector('[data-testid="remove-item"]')) {
    const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-ghost btn-sm', textContent: 'Remove' });
    rm.dataset.testid = 'remove-item'; rm.setAttribute('aria-label', `Remove ${item.file.name}`);
    rm.addEventListener('click', () => removeItem(item.id));
    actions.appendChild(rm);
  }
  refreshControls();
}

function refreshControls() {
  dom.section.hidden = queue.length === 0;
  dom.count.textContent = queue.length;
  dom.convertAll.disabled = isConverting || !queue.some((q) => q.status !== 'done');
  dom.convertAll.textContent = isConverting ? 'Converting...' : 'Convert All Files';
  dom.downloadAll.disabled = !queue.some((q) => q.blob);
  dom.bitrate.disabled = isConverting;
}

/* ---------- 10. Events & theme ---------- */
['dragenter', 'dragover'].forEach((t) => dom.dropzone.addEventListener(t, (e) => { e.preventDefault(); dom.dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((t) => dom.dropzone.addEventListener(t, (e) => { e.preventDefault(); dom.dropzone.classList.remove('dragover'); }));
dom.dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
dom.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.input.click(); } });
// Stop the browser from navigating to a file dropped outside the zone
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));
dom.input.addEventListener('change', () => { addFiles(dom.input.files); dom.input.value = ''; });
dom.convertAll.addEventListener('click', convertAll);
dom.downloadAll.addEventListener('click', downloadAllAsZip);
dom.clearAll.addEventListener('click', clearQueue);
window.addEventListener('pagehide', clearQueue);      // release blob URLs on exit

dom.theme.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { console.warn('Theme not persisted:', e); }
});
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) { /* storage blocked: stay on dark default */ }
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
})();
refreshControls();

/* ---------- 11. Scroll-reveal micro-interaction (progressive enhancement) ---------- */
(function initReveal() {
  const targets = document.querySelectorAll('.tile');
  if (!('IntersectionObserver' in window)) return;     // content stays visible without it
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
  }), { threshold: 0.15 });
  targets.forEach((el, i) => { el.classList.add('reveal'); el.style.transitionDelay = `${(i % 4) * 60}ms`; observer.observe(el); });
})();
