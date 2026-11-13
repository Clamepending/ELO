// Calendar connectors: Google Calendar (live, read-only) and .ics files (any
// calendar app, or Google Takeout). Both emit event records:
//
//   { id, title, start: Date, end: Date, allDay, location, source, cat, sub }
//
// Events are sorted into categories by keyword rules on the title, on-device.
// Only past events are used: a calendar says what was planned, so future events
// say nothing yet. Declined and cancelled events are dropped, but a recurring
// event you silently skipped still counts; that is a known limitation.

import { getToken } from './google.js';

const DAY = 86400000;
export const LOOKBACK_YEARS = 3;

// ---- classification -----------------------------------------------------------

// [category, sub-type, pattern]. Order matters: the first match wins. Errands
// come first ("run errands", "pick up from soccer"), and the work rule sits
// before Social so "lunch meeting" isn't counted as a hangout.
const RULES = [
  ['other', 'errand', /\b(doctor|dentist|appointment|appt|therapy|therapist|haircut|dmv|pick ?up|drop ?off|errands?)\b/],
  ['fitness', 'gym', /\b(gym|lifting|lift|weights|crossfit|strength training|workout|work ?out)\b/],
  ['fitness', 'running', /^run\b|\b(running|jog|jogging|marathon|half marathon|5k|10k|run club|(morning|evening|easy|long|tempo|trail) run)\b/],
  ['fitness', 'cycling', /\b(bike ride|biking|cycling|spin class|spin|peloton)\b/],
  ['fitness', 'swimming', /\b(swim|swimming|laps)\b/],
  ['fitness', 'yoga', /\b(yoga|pilates|barre)\b/],
  ['fitness', 'climbing', /\b(climbing|climb|bouldering|boulder)\b/],
  ['fitness', 'hiking', /\b(hike|hiking|trek)\b/],
  ['fitness', 'team sport', /\b(soccer|football|basketball|volleyball|tennis|pickleball|badminton|squash|frisbee|ultimate|hockey|baseball|softball|rugby|golf)\b/],
  ['fitness', 'martial arts', /\b(boxing|bjj|jiu.?jitsu|judo|karate|muay thai|kickboxing|mma|taekwondo|fencing)\b/],
  ['fitness', 'other', /\b(skiing|ski|snowboard(ing)?|surf(ing)?|rowing|dance class|skating)\b/],

  ['travel', 'flight', /\b(flight|fly to|flying to|layover)\b|✈/],
  ['travel', 'stay', /\b(hotel|airbnb|hostel|stay at)\b/],
  ['travel', 'trip', /\b(trip|travel|vacation|road trip|getaway|retreat)\b/],

  ['learning', 'class', /\b(class|lecture|seminar|course|discussion section|lab section|section)\b/],
  ['learning', 'study', /\b(study|studying|homework|problem set|pset|exam|midterm|final exam|quiz)\b/],
  ['learning', 'workshop', /\b(workshop|bootcamp|webinar|talk by|tech talk)\b/],
  ['learning', 'tutoring', /\b(tutor|tutoring|office hours|lesson|lessons)\b/],
  ['learning', 'reading', /\b(reading group|journal club|book club)\b/],

  ['other', 'work', /\b(1:1|1-1|one on one|standup|stand-up|sync|meeting|interview|review|retro|sprint|planning|all hands|on-?call|deadline|zoom|teams call|work)\b/],

  ['social', 'meal', /\b(dinner|lunch|brunch|breakfast with|coffee with|coffee w\/|drinks|happy hour|bbq|barbecue|potluck)\b/],
  ['social', 'party', /\b(party|birthday|bday|celebration|wedding|shower|game night|housewarming)\b/],
  ['social', 'hangout', /\b(hang|hangout|hang out|catch up|catch-up|meetup|meet up|date night|coffee date|dinner date|visit|reunion|sleepover)\b/],
  ['social', 'event', /\b(concert|show|movie|movies|festival|museum|gallery|theater|theatre|comedy|karaoke|club)\b/],
];
// Course codes such as "CS 189", "MATH 54" or "EECS 16A" (checked case-sensitively).
const COURSE_CODE = /\b[A-Z]{2,6} ?\d{1,3}[A-Z]{0,2}\b/;

export function classifyEvent(title, { allDay = false, days = 0 } = {}) {
  const t = (title ?? '').toLowerCase();
  for (const [cat, sub, re] of RULES) {
    if (!re.test(t)) continue;
    // All-day entries are usually reminders ("Sam's birthday"), not things you
    // did; only trips are trusted as all-day or multi-day events.
    if (allDay && cat !== 'travel') return { cat: 'other', sub: 'all-day' };
    return { cat, sub };
  }
  if (!allDay && COURSE_CODE.test(title ?? '')) return { cat: 'learning', sub: 'class' };
  if (allDay && days >= 2 && /\b(in|to|@)\b/.test(t)) return { cat: 'travel', sub: 'trip' };
  return { cat: 'other', sub: allDay ? 'all-day' : null };
}

function makeEvent(id, title, start, end, allDay, location, source) {
  const days = Math.round((end - start) / DAY);
  return { id, title: title || '(untitled)', start, end, allDay, location: location || null, source, ...classifyEvent(title, { allDay, days }) };
}

function inWindow(start, now) {
  return start <= now && start >= new Date(now.getFullYear() - LOOKBACK_YEARS, now.getMonth(), now.getDate());
}

// ---- .ics ---------------------------------------------------------------------

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
const unescape = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

// "20240101" (date), "20240101T100000Z" (UTC), "20240101T100000" (wall time,
// usually with a TZID; read in this browser's zone, which is close enough for
// counting events per week).
export function parseIcsDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v?.trim() ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  const args = [+y, +mo - 1, +d, +h, +mi, +(s ?? 0)];
  return { date: z ? new Date(Date.UTC(...args)) : new Date(...args), allDay: false };
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  return { name: name.toUpperCase(), params: params.join(';').toUpperCase(), value: line.slice(colon + 1) };
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_OCCURRENCES = 2000;

// Expands an RRULE (DAILY / WEEKLY with BYDAY / MONTHLY by day-of-month or
// nth weekday / YEARLY) into start times up to `until`.
export function expandRrule(rule, dtstart, until) {
  const r = Object.fromEntries(rule.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const ruleUntil = r.UNTIL ? parseIcsDate(r.UNTIL)?.date : null;
  const end = ruleUntil && ruleUntil < until ? ruleUntil : until;
  const out = [];
  const push = (d) => { if (d >= dtstart && d <= end && out.length < count) out.push(d); };
  const withTime = (y, m, d) => new Date(y, m, d, dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds());
  const byday = (r.BYDAY ?? '').split(',').filter(Boolean).map((s) => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.toUpperCase());
    return m ? { n: m[1] ? Number(m[1]) : null, wd: WEEKDAYS[m[2]] } : null;
  }).filter(Boolean);

  for (let i = 0; out.length < Math.min(count, MAX_OCCURRENCES) && i < 50000; i++) {
    let periodStart;
    if (r.FREQ === 'DAILY') {
      periodStart = withTime(dtstart.getFullYear(), dtstart.getMonth(), dtstart.getDate() + i * interval);
      if (periodStart > end) break;
      push(periodStart);
    } else if (r.FREQ === 'WEEKLY') {
      const weekStart = withTime(dtstart.getFullYear(), dtstart.getMonth(), dtstart.getDate() - dtstart.getDay() + i * 7 * interval);
      if (weekStart > end) break;
      const days = byday.length ? byday.map((b) => b.wd).sort() : [dtstart.getDay()];
      for (const wd of days) push(withTime(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + wd));
    } else if (r.FREQ === 'MONTHLY') {
      const y = dtstart.getFullYear(), m = dtstart.getMonth() + i * interval;
      if (new Date(y, m, 1) > end) break;
      if (byday.length && byday[0].n != null) {
        for (const { n, wd } of byday) push(nthWeekday(y, m, wd, n, dtstart));
      } else {
        const d = withTime(y, m, dtstart.getDate());
        if (d.getDate() === dtstart.getDate()) push(d); // skip e.g. Feb 31
      }
    } else if (r.FREQ === 'YEARLY') {
      const d = withTime(dtstart.getFullYear() + i * interval, dtstart.getMonth(), dtstart.getDate());
      if (d > end) break;
      push(d);
    } else {
      break; // HOURLY etc.: not worth expanding
    }
  }
  return out;
}

function nthWeekday(y, m, wd, n, t) {
  const at = (day) => new Date(y, m, day, t.getHours(), t.getMinutes(), t.getSeconds());
  if (n > 0) {
    const first = new Date(y, m, 1).getDay();
    return at(1 + ((wd - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  const last = new Date(y, m, lastDay).getDay();
  return at(lastDay - ((last - wd + 7) % 7) + (n + 1) * 7);
}

export function parseIcs(text, { now = new Date(), source = 'ics', idPrefix = 'i' } = {}) {
  const lines = unfold(text).split('\n');
  const raw = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'SUMMARY') cur.title = unescape(p.value);
    else if (p.name === 'LOCATION') cur.location = unescape(p.value);
    else if (p.name === 'DTSTART') cur.start = parseIcsDate(p.value);
    else if (p.name === 'DTEND') cur.end = parseIcsDate(p.value);
    else if (p.name === 'DURATION') cur.duration = p.value;
    else if (p.name === 'RRULE') cur.rrule = p.value;
    else if (p.name === 'EXDATE') cur.exdates.push(...p.value.split(',').map((v) => parseIcsDate(v)?.date?.getTime()));
    else if (p.name === 'UID') cur.uid = p.value;
    else if (p.name === 'RECURRENCE-ID') cur.recurrenceId = parseIcsDate(p.value)?.date?.getTime();
    else if (p.name === 'STATUS') cur.status = p.value.toUpperCase();
  }

  // Edited instances of a recurring event replace the generated occurrence.
  const overridden = new Set(raw.filter((e) => e.recurrenceId != null).map((e) => `${e.uid}@${e.recurrenceId}`));
  const events = [];
  for (const e of raw) {
    if (!e.start?.date || e.status === 'CANCELLED') continue;
    const len = e.end?.date ? e.end.date - e.start.date : parseDuration(e.duration) ?? (e.start.allDay ? DAY : 3600000);
    const starts = e.rrule && e.recurrenceId == null
      ? expandRrule(e.rrule, e.start.date, now).filter((d) => !e.exdates.includes(d.getTime()) && !overridden.has(`${e.uid}@${d.getTime()}`))
      : [e.start.date];
    for (const s of starts) {
      if (!inWindow(s, now)) continue;
      events.push(makeEvent(`${idPrefix}${events.length}`, e.title, s, new Date(s.getTime() + len), e.start.allDay, e.location, source));
    }
  }
  return events;
}

function parseDuration(v) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v ?? '');
  if (!m) return null;
  const [, w, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

// ---- Google Calendar ----------------------------------------------------------

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

async function gapi(token, path) {
  const r = await fetch(`${CAL_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Google Calendar API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Maps one Google Calendar API event to a record, or null if it shouldn't count.
export function fromGoogleEvent(ev, id) {
  if (ev.status === 'cancelled') return null;
  // Working location, focus time, out-of-office and birthdays aren't activities.
  if (ev.eventType && !['default', 'fromGmail'].includes(ev.eventType)) return null;
  if (ev.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null;
  const allDay = !ev.start?.dateTime;
  const start = allDay ? parseIcsDate(ev.start?.date?.replaceAll('-', ''))?.date : new Date(ev.start.dateTime);
  const end = allDay ? parseIcsDate(ev.end?.date?.replaceAll('-', ''))?.date : new Date(ev.end?.dateTime);
  if (!start || isNaN(start)) return null;
  return makeEvent(id, ev.summary, start, end && !isNaN(end) ? end : new Date(start.getTime() + 3600000), allDay, ev.location, 'google calendar');
}

export async function importGoogleCalendar(onStatus) {
  const token = await getToken(CAL_SCOPE);
  const now = new Date();
  const timeMin = new Date(now.getFullYear() - LOOKBACK_YEARS, now.getMonth(), now.getDate()).toISOString();
  // Only calendars you own: subscribed ones (holidays, a colleague's) aren't you.
  const { items: calendars = [] } = await gapi(token, '/users/me/calendarList?minAccessRole=owner');
  const events = [];
  for (const cal of calendars) {
    let pageToken = '';
    do {
      onStatus?.(`Reading ${cal.summaryOverride ?? cal.summary ?? 'calendar'}… (${events.length} events so far)`);
      const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax: now.toISOString(), maxResults: '2500' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await gapi(token, `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      for (const ev of page.items ?? []) {
        const rec = fromGoogleEvent(ev, `g${events.length}`);
        if (rec) events.push(rec);
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
  }
  return events;
}
