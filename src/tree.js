// The v0 score tree. Leaves read normalized records, never raw files, so new
// connectors only need to emit the same record shapes.
//
// photo record: { id, name, date: Date|null, lat: number|null, lon: number|null,
//                 cat: string, sub: string|null, conf: number, thumb: string|null }
// event record: { id, title, start: Date, end: Date, allDay, location, source,
//                 cat: string, sub: string|null }   (see calendar.js)
//
// NOTE: every `norm` below is a hand-set placeholder, not fitted to any real
// population (ATUS, NHANES, ...). Replace them once there is reference data.

const DAY = 86400000;
const dayIndex = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
export const weekKey = (d) => Math.floor((dayIndex(d) + 3) / 7); // Monday-start weeks
const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();

export function buildContext(photos, events = []) {
  const dated = photos.filter((p) => p.date instanceof Date && !isNaN(p.date));
  // Category leaves only count weeks with AI-classified photos: an unclassified
  // photo (model unavailable, HEIC outside Safari) is unknown, not "no cooking".
  const classified = dated.filter((p) => p.cat !== 'unclassified');
  const activeWeeks = new Set(classified.map((p) => weekKey(p.date)));
  const byCat = {};
  for (const p of classified) (byCat[p.cat] ??= []).push(p);

  // Calendar weeks/months count as active if they hold any timed event at all,
  // so a gap in calendar use is missing data, not a week of doing nothing.
  const evs = events.filter((e) => e.start instanceof Date && !isNaN(e.start));
  const timed = evs.filter((e) => !e.allDay);
  const calWeeks = new Set(timed.map((e) => weekKey(e.start)));
  const calMonths = new Set(timed.map((e) => monthKey(e.start)));
  const eventsByCat = {};
  for (const e of evs) (eventsByCat[e.cat] ??= []).push(e);
  return { photos, dated, activeWeeks, byCat, events: evs, calWeeks, calMonths, eventsByCat };
}

const fmt = (x, d = 2) => (Number.isInteger(x) ? String(x) : x.toFixed(d));

// ---- generic leaf builders -------------------------------------------------

function frequency(cat, noun, median) {
  return {
    id: `${cat}.frequency`,
    name: 'Frequency',
    desc: `${noun} photos per active week (a week with any classified photo). Weeks with no photos are treated as missing, not zero.`,
    norm: { transform: 'log', median, sigma: 1.2, higherIsBetter: true },
    kappa: 6,
    compute(ctx) {
      const W = ctx.activeWeeks.size;
      if (!W) return null;
      const ps = ctx.byCat[cat] ?? [];
      return {
        value: ps.length / W, n: W, evidence: ps.map((p) => p.id),
        detail: `${fmt(ps.length / W)} per active week (${ps.length} photos over ${W} active weeks)`,
      };
    },
  };
}

function consistency(cat, noun, median) {
  return {
    id: `${cat}.consistency`,
    name: 'Consistency',
    desc: `Share of active weeks that contain at least one ${noun.toLowerCase()} photo.`,
    norm: { transform: 'logit', median, sigma: 1.0, higherIsBetter: true },
    kappa: 6,
    compute(ctx) {
      const W = ctx.activeWeeks.size;
      if (!W) return null;
      const ps = ctx.byCat[cat] ?? [];
      const weeks = new Set(ps.map((p) => weekKey(p.date)));
      return {
        value: weeks.size / W, n: W, evidence: ps.map((p) => p.id),
        detail: `${weeks.size} of ${W} active weeks (${Math.round((100 * weeks.size) / W)}%)`,
      };
    },
  };
}

function variety(cat, noun, median) {
  return {
    id: `${cat}.variety`,
    name: 'Variety',
    desc: `Effective number of distinct ${noun.toLowerCase()} types, exp(Shannon entropy) over AI-assigned sub-types. Missing if there are no ${noun.toLowerCase()} photos.`,
    norm: { transform: 'log', median, sigma: 0.6, higherIsBetter: true, eps: 0 },
    kappa: 8,
    compute(ctx) {
      const ps = ctx.byCat[cat] ?? [];
      if (!ps.length) return null;
      const counts = {};
      for (const p of ps) counts[p.sub ?? 'other'] = (counts[p.sub ?? 'other'] ?? 0) + 1;
      let H = 0;
      for (const c of Object.values(counts)) { const q = c / ps.length; H -= q * Math.log(q); }
      const eff = Math.exp(H);
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
      return { value: eff, n: ps.length, evidence: ps.map((p) => p.id), detail: `${fmt(eff, 1)} effective types — ${top}` };
    },
  };
}

// ---- calendar leaf builders --------------------------------------------------

function calFrequency(cat, noun, median) {
  return {
    id: `${cat}.calendar.frequency`,
    name: 'Frequency',
    desc: `${noun} events per active calendar week (a week with any timed event). Only past events you didn't decline.`,
    norm: { transform: 'log', median, sigma: 1.2, higherIsBetter: true },
    kappa: 6,
    compute(ctx) {
      const W = ctx.calWeeks.size;
      if (!W) return null;
      const es = (ctx.eventsByCat[cat] ?? []).filter((e) => !e.allDay);
      return {
        value: es.length / W, n: W, evidence: es.map((e) => e.id),
        detail: `${fmt(es.length / W)} per active week (${es.length} events over ${W} active calendar weeks)`,
      };
    },
  };
}

function calConsistency(cat, noun, median) {
  return {
    id: `${cat}.calendar.consistency`,
    name: 'Consistency',
    desc: `Share of active calendar weeks with at least one ${noun.toLowerCase()} event.`,
    norm: { transform: 'logit', median, sigma: 1.0, higherIsBetter: true },
    kappa: 6,
    compute(ctx) {
      const W = ctx.calWeeks.size;
      if (!W) return null;
      const es = (ctx.eventsByCat[cat] ?? []).filter((e) => !e.allDay);
      const weeks = new Set(es.map((e) => weekKey(e.start)));
      return {
        value: weeks.size / W, n: W, evidence: es.map((e) => e.id),
        detail: `${weeks.size} of ${W} active calendar weeks (${Math.round((100 * weeks.size) / W)}%)`,
      };
    },
  };
}

// A category with two evidence sources. Each source is its own sub-composite,
// so a missing source sits at the prior instead of being renormalized away.
// rho 0.5: photos and calendar measure the same behavior through different,
// partly independent filters (placeholder).
function twoSource(id, name, desc, photoLeaves, calLeaves) {
  return {
    id, name, desc, rho: 0.5,
    children: [
      { id: `${id}.photos`, name: 'From photos', desc: 'AI-tagged photos.', rho: 0.6, children: photoLeaves },
      { id: `${id}.calendar`, name: 'From calendar', desc: 'Calendar events sorted by title keywords. Missing if no calendar is connected.', rho: 0.6, children: calLeaves },
    ],
  };
}

// Consecutive travel events within 3 days of each other are one trip.
function trips(events) {
  const ts = events.filter((e) => e.cat === 'travel').sort((a, b) => a.start - b.start);
  const out = [];
  for (const e of ts) {
    const last = out[out.length - 1];
    if (last && e.start - last.end <= 3 * DAY) { last.events.push(e); if (e.end > last.end) last.end = e.end; }
    else out.push({ start: e.start, end: e.end, events: [e] });
  }
  return out;
}

// ---- geo helpers ------------------------------------------------------------

const cell = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`; // ≈1 km grid
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const withGps = (ctx) => ctx.dated.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

// ---- the tree ---------------------------------------------------------------

export const TREE = {
  id: 'overall',
  name: 'Overall',
  desc: 'Equal-weight composite of the categories. The weighting is a value judgment, not a measurement.',
  rho: 0.2, // assumed correlation between categories (placeholder)
  children: [
    {
      id: 'cooking', name: 'Cooking', desc: 'Home cooking, inferred from food and kitchen photos.',
      rho: 0.6,
      children: [frequency('cooking', 'Home-cooked food', 0.3), consistency('cooking', 'Cooking', 0.15), variety('cooking', 'Dish', 3)],
    },
    twoSource('fitness', 'Fitness', 'Exercise and sport, from workout photos and fitness-app screenshots, and from workouts on your calendar.',
      [frequency('fitness', 'Workout', 0.25), consistency('fitness', 'Workout', 0.12), variety('fitness', 'Activity', 2)],
      [calFrequency('fitness', 'Workout', 1.0), calConsistency('fitness', 'Workout', 0.35)]),
    twoSource('social', 'Social', 'Time with people: group photos (biased toward people whose friends like photos) and social plans on your calendar.',
      [frequency('social', 'Group', 0.6), consistency('social', 'Group', 0.3), variety('social', 'Occasion', 2.5)],
      [calFrequency('social', 'Social', 1.0), calConsistency('social', 'Social', 0.5)]),
    twoSource('learning', 'Learning', 'Notes, whiteboards, books and code in photos; classes, study sessions and workshops on your calendar.',
      [frequency('learning', 'Study', 0.2), consistency('learning', 'Study', 0.1)],
      [calFrequency('learning', 'Learning', 1.0), calConsistency('learning', 'Learning', 0.3)]),
    {
      id: 'exploration', name: 'Exploration', desc: 'Places from photo GPS, and trips from your calendar. Each part is missing without its source.',
      rho: 0.4,
      children: [
        {
          id: 'exploration.places', name: 'New places',
          desc: 'Distinct ~1 km map cells visited per active month (months with any GPS-tagged photo).',
          norm: { transform: 'log', median: 4, sigma: 0.9, higherIsBetter: true },
          kappa: 4,
          compute(ctx) {
            const ps = withGps(ctx);
            if (!ps.length) return null;
            const months = new Set(ps.map((p) => monthKey(p.date)));
            const cells = new Set(ps.map(cell));
            return { value: cells.size / months.size, n: months.size, evidence: ps.map((p) => p.id),
              detail: `${fmt(cells.size / months.size, 1)} per month (${cells.size} distinct places over ${months.size} months)` };
          },
        },
        {
          id: 'exploration.range', name: 'Range',
          desc: '90th-percentile distance (km) of photos from your most-photographed map cell ("home").',
          norm: { transform: 'log', median: 30, sigma: 1.5, higherIsBetter: true, eps: 1 },
          kappa: 30,
          compute(ctx) {
            const ps = withGps(ctx);
            if (!ps.length) return null;
            const counts = {};
            for (const p of ps) counts[cell(p)] = (counts[cell(p)] ?? 0) + 1;
            const homeKey = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
            const [lat, lon] = homeKey.split(',').map(Number);
            const d = ps.map((p) => haversineKm({ lat, lon }, p)).sort((a, b) => a - b);
            const p90 = d[Math.min(d.length - 1, Math.floor(0.9 * d.length))];
            const far = ps.filter((p) => haversineKm({ lat, lon }, p) >= p90).map((p) => p.id);
            return { value: p90, n: ps.length, evidence: far, detail: `${fmt(p90, 0)} km (from ${ps.length} GPS-tagged photos)` };
          },
        },
        {
          id: 'exploration.trips', name: 'Trips',
          desc: 'Trips per active calendar month: flights, hotels and trips on your calendar, with events within 3 days of each other merged into one trip.',
          norm: { transform: 'log', median: 0.25, sigma: 1.0, higherIsBetter: true },
          kappa: 6,
          compute(ctx) {
            const M = ctx.calMonths.size;
            if (!M) return null;
            const ts = trips(ctx.events);
            return { value: ts.length / M, n: M, evidence: ts.flatMap((t) => t.events.map((e) => e.id)),
              detail: `${fmt(ts.length / M)} per month (${ts.length} trips over ${M} active calendar months)` };
          },
        },
      ],
    },
    {
      id: 'rhythm', name: 'Rhythm', desc: 'Weak sleep proxy from photo timestamps. A wearable would replace this entirely.',
      children: [
        {
          id: 'rhythm.latenight', name: 'Late nights',
          desc: 'Share of photos taken between 00:00 and 04:59 local time. Lower scores higher.',
          norm: { transform: 'logit', median: 0.03, sigma: 0.8, higherIsBetter: false },
          kappa: 40,
          compute(ctx) {
            if (!ctx.dated.length) return null;
            const late = ctx.dated.filter((p) => p.date.getHours() < 5);
            return { value: late.length / ctx.dated.length, n: ctx.dated.length, evidence: late.map((p) => p.id),
              detail: `${late.length} of ${ctx.dated.length} photos (${fmt((100 * late.length) / ctx.dated.length, 1)}%)` };
          },
        },
      ],
    },
  ],
};
