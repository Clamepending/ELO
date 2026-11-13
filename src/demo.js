// Synthetic gallery so the score tree can be explored without real photos.
// Records have the same shape the photo connector emits, minus thumbnails.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function demoPhotos(seed = 7) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const poisson = (lam) => { let k = 0, p = Math.exp(-lam), s = p, u = r(); while (u > s) { k++; p *= lam / k; s += p; } return k; };
  // Per-week rates for a fictional person.
  const plan = [
    ['cooking', 1.2, ['meal', 'pasta', 'baking', 'stovetop', 'salad', 'soup']],
    ['fitness', 0.5, ['running', 'gym', 'gym', 'hiking']],
    ['social', 0.9, ['hangout', 'party', 'shared meal', 'concert']],
    ['learning', 0.15, ['notes', 'book']],
    ['dining', 0.8, [null]],
    ['other', 6, [null]],
    ['travel', 0.4, [null]],
  ];
  const home = { lat: 37.77, lon: -122.42 };
  const photos = [];
  const start = new Date(2025, 10, 3); // a Monday
  for (let w = 0; w < 52; w++) {
    if (r() < 0.12) continue; // weeks with no photos at all (missing, not zero)
    for (const [cat, lam, subs] of plan) {
      for (let k = poisson(lam); k > 0; k--) {
        const d = new Date(start.getTime() + (w * 7 + Math.floor(r() * 7)) * 86400000);
        const hour = r() < 0.04 ? Math.floor(r() * 5) : 7 + Math.floor(r() * 16);
        d.setHours(hour, Math.floor(r() * 60));
        const away = cat === 'travel' || r() < 0.08;
        const spread = away ? 3 : 0.05;
        const gps = r() < 0.7;
        photos.push({
          id: `d${photos.length}`, name: `demo_${photos.length}.jpg`, date: d, dateSource: 'synthetic',
          lat: gps ? home.lat + (r() - 0.5) * spread : null,
          lon: gps ? home.lon + (r() - 0.5) * spread : null,
          camera: null, thumb: null, cat, sub: pick(subs), conf: 0.6 + 0.4 * r(),
        });
      }
    }
  }
  return photos;
}
