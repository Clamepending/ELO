// Google Photos connector via the Photos Picker API. The user picks photos in
// Google's own UI; we download the picked originals and hand them to ingest()
// as ordinary File objects, plus each item's createTime as fallback metadata.
//
// Picker downloads (=d) keep EXIF except location, so imported photos have no
// GPS. Download URLs reject browser CORS preflights, so bytes go through this
// site's Worker (/api/gphoto), which forwards to *.googleusercontent.com only
// and stores nothing.

import { getToken } from './google.js';

const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const API = 'https://photospicker.googleapis.com/v1';
const CONCURRENCY = 4;

async function api(token, path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  if (!r.ok) throw new Error(`Google Photos API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

const seconds = (d, dflt) => (d ? parseFloat(d) : dflt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The picker opens in a new window. If the browser blocks it (we're no longer
// inside the original click), `openPicker` lets the UI show a link instead.
async function waitForPick(token, session, openPicker, onStatus) {
  openPicker(`${session.pickerUri}/autoclose`);
  onStatus('Pick photos in the Google Photos window, then click Done there…');
  const deadline = Date.now() + seconds(session.pollingConfig?.timeoutIn, 1800) * 1000;
  let s = session;
  while (!s.mediaItemsSet) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for photo selection');
    await sleep(Math.max(1, seconds(s.pollingConfig?.pollInterval, 3)) * 1000);
    s = await api(token, `/sessions/${session.id}`);
    if (s.pollingConfig && seconds(s.pollingConfig.timeoutIn, 1) === 0 && !s.mediaItemsSet) {
      throw new Error('Photo selection expired');
    }
  }
}

async function listItems(token, sessionId) {
  const items = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await api(token, `/mediaItems?${q}`);
    items.push(...(page?.mediaItems ?? []));
    pageToken = page?.nextPageToken ?? '';
  } while (pageToken);
  return items;
}

async function download(token, item) {
  const { baseUrl, filename, mimeType } = item.mediaFile;
  const r = await fetch(`/api/gphoto?u=${encodeURIComponent(`${baseUrl}=d`)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const blob = await r.blob();
  const t = Date.parse(item.createTime);
  return new File([blob], filename, { type: mimeType || blob.type, lastModified: Number.isFinite(t) ? t : Date.now() });
}

// Returns { files, meta } where meta maps filename → { date } for ingest().
export async function importFromGooglePhotos({ openPicker, onStatus, onProgress }) {
  const token = await getToken(SCOPE);
  onStatus('Starting Google Photos picker…');
  const session = await api(token, '/sessions', { method: 'POST', body: '{}' });
  try {
    await waitForPick(token, session, openPicker, onStatus);
    onStatus('Fetching your selection…');
    const photos = (await listItems(token, session.id)).filter((it) => it.type !== 'VIDEO' && it.mediaFile?.baseUrl);
    const files = new Array(photos.length);
    const meta = new Map();
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < photos.length) {
        const i = next++;
        try { files[i] = await download(token, photos[i]); } catch (e) { failed++; console.warn('Skipping', photos[i].mediaFile.filename, e); }
        const t = Date.parse(photos[i].createTime);
        if (Number.isFinite(t)) meta.set(photos[i].mediaFile.filename, { date: new Date(t), lat: null, lon: null });
        onProgress(++done, photos.length);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { files: files.filter(Boolean), meta, failed };
  } finally {
    api(token, `/sessions/${session.id}`, { method: 'DELETE' }).catch(() => {});
  }
}
