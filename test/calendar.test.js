import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvent, parseIcs, expandRrule, fromGoogleEvent } from '../src/calendar.js';

const c = (t, o) => { const r = classifyEvent(t, o); return `${r.cat}/${r.sub}`; };

test('classifier: categories, precedence and false-positive guards', () => {
  assert.equal(c('Gym'), 'fitness/gym');
  assert.equal(c('Morning run'), 'fitness/running');
  assert.equal(c('run errands'), 'other/errand');
  assert.equal(c('Dry run of demo'), 'other/null');
  assert.equal(c('Dinner with Sam'), 'social/meal');
  assert.equal(c('Lunch meeting w/ vendor'), 'other/work');
  assert.equal(c('Doctor visit'), 'other/errand');
  assert.equal(c('CS 189 lecture'), 'learning/class');
  assert.equal(c('EECS 16A'), 'learning/class');
  assert.equal(c('Book club'), 'learning/reading');
  assert.equal(c('Flight to Tokyo ✈'), 'travel/flight');
  assert.equal(c('Weekly sync'), 'other/work');
});

test('classifier: all-day entries only count as trips', () => {
  assert.equal(c("Sam's birthday", { allDay: true, days: 1 }), 'other/all-day');
  assert.equal(c('Hotel: Brooklyn', { allDay: true, days: 4 }), 'travel/stay');
  assert.equal(c('Ski week in Tahoe', { allDay: true, days: 5 }), 'other/all-day'); // fitness word, all-day
  assert.equal(c('Mom in Seattle', { allDay: true, days: 3 }), 'travel/trip');
});

test('rrule: weekly BYDAY with COUNT, and monthly nth weekday', () => {
  const start = new Date(2025, 0, 6, 7, 0); // Mon Jan 6 2025
  const w = expandRrule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5', start, new Date(2026, 0, 1));
  assert.deepEqual(w.map((d) => d.getDate()), [6, 8, 13, 15, 20]);
  const m = expandRrule('FREQ=MONTHLY;BYDAY=2TU', new Date(2025, 0, 14, 18), new Date(2025, 3, 30));
  assert.deepEqual(m.map((d) => `${d.getMonth() + 1}/${d.getDate()}`), ['1/14', '2/11', '3/11', '4/8']);
  const last = expandRrule('FREQ=MONTHLY;BYDAY=-1FR', new Date(2025, 0, 31, 18), new Date(2025, 2, 31));
  assert.deepEqual(last.map((d) => `${d.getMonth() + 1}/${d.getDate()}`), ['1/31', '2/28', '3/28']);
});

test('ics: folding, escapes, recurrence with EXDATE and an edited instance, cancelled, future', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Gym', 'DTSTART:20250106T150000Z', 'DTEND:20250106T160000Z',
    'RRULE:FREQ=WEEKLY;UNTIL=20250127T235959Z', 'EXDATE:20250113T150000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a', 'RECURRENCE-ID:20250120T150000Z', 'SUMMARY:Gym (moved)', 'DTSTART:20250121T150000Z', 'DTEND:20250121T160000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Dinner with Ana\\, Bo', 'DTSTART;TZID=America/Los_Angeles:20250110T190000', 'DURATION:PT2H', 'LOCATION:Some', ' place', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Party', 'STATUS:CANCELLED', 'DTSTART:20250111T030000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Future gym', 'DTSTART:20990101T150000Z', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ev = parseIcs(ics, { now: new Date(Date.UTC(2025, 5, 1)) });
  const gym = ev.filter((e) => e.cat === 'fitness').map((e) => e.start.toISOString().slice(0, 10));
  assert.deepEqual(gym, ['2025-01-06', '2025-01-27', '2025-01-21']); // 13th excluded, 20th moved to 21st
  const dinner = ev.find((e) => e.cat === 'social');
  assert.equal(dinner.title, 'Dinner with Ana, Bo');
  assert.equal(dinner.location, 'Someplace');
  assert.equal(dinner.end - dinner.start, 2 * 3600000);
  assert.equal(ev.length, 4);
});

test('google events: declined, cancelled and non-default types dropped', () => {
  const base = { summary: 'Gym', start: { dateTime: '2025-01-06T07:00:00-08:00' }, end: { dateTime: '2025-01-06T08:00:00-08:00' } };
  assert.equal(fromGoogleEvent(base, 'g0').cat, 'fitness');
  assert.equal(fromGoogleEvent({ ...base, status: 'cancelled' }, 'g1'), null);
  assert.equal(fromGoogleEvent({ ...base, eventType: 'workingLocation' }, 'g2'), null);
  assert.equal(fromGoogleEvent({ ...base, attendees: [{ self: true, responseStatus: 'declined' }] }, 'g3'), null);
  const allDay = fromGoogleEvent({ summary: 'Trip to Tahoe', start: { date: '2025-02-14' }, end: { date: '2025-02-17' } }, 'g4');
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.cat, 'travel');
});
