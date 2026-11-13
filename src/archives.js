// Social-media export connectors: Instagram "Download your information" (JSON
// format) and the X/Twitter archive. Both arrive as a folder or as .zip files.
// They become ordinary image Files plus a filename → { date, lat, lon, source }
// map that ingest() treats like Takeout sidecars.
//
// Only the user's own posts/stories are kept. DM media (other people's photos),
// profile pictures, and retweets are dropped.

const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
const IMAGE_RE = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i;
const PRIVATE_RE = /(^|\/)(messages|inbox|direct_messages\w*|dms?)\//i;
const META_RE = /(^|\/)(tweets(-part\d+)?\.js|[^/]*\.json)$/i;

export const basename = (p) => p.split('/').pop();
const pathOf = (f) => f.archivePath || f.webkitRelativePath || f.name;

// ---- Instagram ----------------------------------------------------------------

// Walks any Instagram export JSON and collects image references. Meta has
// renamed files and nesting several times, so instead of one schema we look for
// objects with an image `uri` (or legacy `path`) and take the nearest
// `creation_timestamp` (or legacy `taken_at`) from the object or its ancestors.
export function parseInstagramJson(json, out = new Map()) {
  const walk = (node, inheritedTs) => {
    if (Array.isArray(node)) { for (const n of node) walk(n, inheritedTs); return; }
    if (!node || typeof node !== 'object') return;
    const ts = toDate(node.creation_timestamp ?? node.taken_at) ?? inheritedTs;
    const ref = typeof node.uri === 'string' ? node.uri : typeof node.path === 'string' ? node.path : null;
    if (ref && IMAGE_RE.test(ref) && !PRIVATE_RE.test(ref) && !/(^|\/)profile\//i.test(ref)) {
      const geo = findGeo(node.media_metadata ?? node);
      out.set(basename(ref), { date: ts, lat: geo?.lat ?? null, lon: geo?.lon ?? null, source: 'instagram' });
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object' && k !== 'media_metadata') walk(v, ts);
  };
  walk(json, null);
  return out;
}

function toDate(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
  return isNaN(d) ? null : d;
}

function findGeo(node) {
  let hit = null;
  const walk = (n) => {
    if (hit || !n || typeof n !== 'object') return;
    const lat = Number(n.latitude), lon = Number(n.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) { hit = { lat, lon }; return; }
    for (const v of Object.values(n)) walk(v);
  };
  walk(node);
  return hit;
}

// ---- X / Twitter ------------------------------------------------------------

// "Wed Oct 10 20:19:24 +0000 2018" → Date (spelled out so every browser parses it).
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
export function parseTwitterDate(s) {
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/.exec(s ?? '');
  if (!m || !MONTHS[m[1]]) return toDate(s);
  return toDate(`${m[6]}-${MONTHS[m[1]]}-${m[2]}T${m[3]}${m[4]}:${m[5]}`);
}

// tweets.js is `window.YTD.tweets.part0 = [ { tweet: {...} }, ... ]`. Archive
// media lives in data/tweets_media/ named "<tweet id>-<last segment of media_url>".
export function parseTweetsJs(text, out = new Map()) {
  const json = JSON.parse(text.slice(text.indexOf('=') + 1));
  for (const row of json) {
    const t = row.tweet ?? row;
    if (/^RT @/.test(t.full_text ?? t.text ?? '')) continue; // someone else's media
    const media = t.extended_entities?.media ?? t.entities?.media ?? [];
    const date = parseTwitterDate(t.created_at);
    const pt = t.coordinates?.coordinates; // GeoJSON [lon, lat]
    const g = t.geo?.coordinates; // [lat, lon]
    const lat = pt ? Number(pt[1]) : g ? Number(g[0]) : null;
    const lon = pt ? Number(pt[0]) : g ? Number(g[1]) : null;
    for (const m of media) {
      if (m.type && m.type !== 'photo') continue;
      const url = m.media_url_https ?? m.media_url;
      if (!url) continue;
      out.set(`${t.id_str ?? t.id}-${basename(url)}`, { date, lat, lon, source: 'x' });
    }
  }
  return out;
}

// ---- unzip --------------------------------------------------------------------

// Streams each .zip (exports can be several GB) and keeps only metadata files
// and non-private images, so the whole archive is never held in memory at once.
async function unzipFiles(zip, onProgress) {
  const { Unzip, UnzipInflate } = await import(FFLATE_URL);
  const out = [];
  const uz = new Unzip();
  uz.register(UnzipInflate);
  let error = null;
  uz.onfile = (entry) => {
    const p = entry.name;
    const keep = !p.endsWith('/') && !PRIVATE_RE.test(p) && (IMAGE_RE.test(p) || META_RE.test(p));
    if (!keep) return;
    const chunks = [];
    entry.ondata = (err, data, final) => {
      if (err) { error ??= err; return; }
      chunks.push(data);
      if (final) {
        const f = new File(chunks, basename(p), { type: IMAGE_RE.test(p) ? '' : 'application/json' });
        f.archivePath = p;
        out.push(f);
      }
    };
    entry.start();
  };
  const reader = zip.stream().getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { uz.push(new Uint8Array(0), true); break; }
    uz.push(value);
    read += value.length;
    onProgress?.(read, zip.size);
  }
  if (error) throw new Error(`Could not read ${zip.name}: ${error.message ?? error}`);
  return out;
}

// ---- entry point --------------------------------------------------------------

// Expands zips, then, if the selection is an Instagram or X export, returns just
// the user's post images with their metadata. Anything else passes through.
export async function prepareImport(fileList, onStatus) {
  // Copy before the first await: the caller resets the <input>, which empties
  // its live FileList.
  const selected = [...fileList];
  const files = [];
  for (const f of selected) {
    if (/\.zip$/i.test(f.name)) {
      onStatus?.(`Unpacking ${f.name}…`, 0);
      files.push(...await unzipFiles(f, (r, n) => onStatus?.(`Unpacking ${f.name}…`, r / n)));
    } else {
      files.push(f);
    }
  }

  const meta = new Map();
  let kind = null;
  for (const f of files) {
    const p = pathOf(f);
    try {
      if (/(^|\/)tweets(-part\d+)?\.js$/i.test(p)) {
        parseTweetsJs(await f.text(), meta);
        kind ??= 'x';
      } else if (/^(posts(_\d+)?|stories|reels|archived_posts|media)\.json$/i.test(basename(p))) {
        const before = meta.size;
        parseInstagramJson(JSON.parse(await f.text()), meta);
        if (meta.size > before) kind ??= 'instagram';
      }
    } catch (e) {
      console.warn('Skipping unreadable export file', p, e);
    }
  }

  if (!kind) return { files, extraMeta: null, metaSource: 'takeout', kind: null };
  const images = files.filter((f) => IMAGE_RE.test(f.name) && meta.has(f.name) && !PRIVATE_RE.test(pathOf(f)));
  return { files: images, extraMeta: meta, metaSource: kind, kind };
}
