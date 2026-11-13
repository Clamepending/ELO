// Photo-gallery connector: turns user-selected files into normalized photo
// records. Understands EXIF and Google Takeout JSON sidecars.

const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs';
const IMAGE_RE = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i;
const THUMB = 224;

let exifrPromise = null;
const getExifr = () => (exifrPromise ??= import(EXIFR_URL).then((m) => m.default ?? m));

// Takeout sidecars are named "<photo>.json" or "<photo>.supplemental-metadata.json"
// (and are sometimes truncated), so match on the "title" field inside instead.
async function readSidecars(files) {
  const map = new Map();
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const j = JSON.parse(await f.text());
      if (!j.title) continue;
      const ts = Number(j.photoTakenTime?.timestamp);
      const geo = [j.geoDataExif, j.geoData].find((g) => g && (g.latitude || g.longitude));
      map.set(j.title, {
        date: ts ? new Date(ts * 1000) : null,
        lat: geo ? geo.latitude : null,
        lon: geo ? geo.longitude : null,
      });
    } catch { /* not a sidecar */ }
  }
  return map;
}

async function makeThumb(file) {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return URL.createObjectURL(blob);
  } catch {
    return null; // e.g. HEIC outside Safari: metadata still counts, no classification
  }
}

export async function ingest(fileList, onProgress) {
  const files = [...fileList];
  const exifr = await getExifr();
  const sidecars = await readSidecars(files);
  const images = files.filter((f) => IMAGE_RE.test(f.name));
  const photos = [];
  for (let i = 0; i < images.length; i++) {
    const f = images[i];
    let exif = null;
    // exifr derives latitude/longitude only when the raw GPS tags are picked.
    try { exif = await exifr.parse(f, { gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'] }); } catch { /* none */ }
    const side = sidecars.get(f.name);
    // EXIF DateTimeOriginal is local wall-clock time, which is what hour-of-day
    // analysis wants. Takeout timestamps are UTC (shown in this browser's zone).
    // File mtime is the weakest fallback and is often the download time.
    const date = exif?.DateTimeOriginal ?? exif?.CreateDate ?? side?.date ?? (f.lastModified ? new Date(f.lastModified) : null);
    const dateSource = exif?.DateTimeOriginal || exif?.CreateDate ? 'exif' : side?.date ? 'takeout' : 'file mtime';
    photos.push({
      id: `p${i}`,
      name: f.webkitRelativePath || f.name,
      date: date instanceof Date && !isNaN(date) ? date : null,
      dateSource,
      lat: Number.isFinite(exif?.latitude) ? exif.latitude : side?.lat ?? null,
      lon: Number.isFinite(exif?.longitude) ? exif.longitude : side?.lon ?? null,
      camera: exif?.Make ? `${exif.Make} ${exif.Model ?? ''}`.trim() : null,
      thumb: await makeThumb(f),
      cat: 'unclassified', sub: null, conf: 0,
    });
    onProgress?.(i + 1, images.length);
  }
  return photos;
}
