import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramJson, parseTweetsJs, parseTwitterDate } from '../src/archives.js';

test('instagram: current posts_1.json shape, carousel timestamps and EXIF geo', () => {
  const posts = [
    {
      title: 'carousel caption',
      creation_timestamp: 1700000000,
      media: [
        { uri: 'media/posts/202311/111.jpg', creation_timestamp: 1700000100,
          media_metadata: { photo_metadata: { exif_data: [{ latitude: 37.87, longitude: -122.26 }] } } },
        { uri: 'media/posts/202311/112.jpg' }, // inherits the post timestamp
        { uri: 'media/posts/202311/113.mp4', creation_timestamp: 1700000200 }, // video: skipped
      ],
    },
  ];
  const m = parseInstagramJson(posts);
  assert.equal(m.size, 2);
  assert.equal(m.get('111.jpg').date.getTime(), 1700000100 * 1000);
  assert.equal(m.get('111.jpg').lat, 37.87);
  assert.equal(m.get('112.jpg').date.getTime(), 1700000000 * 1000);
  assert.equal(m.get('112.jpg').lat, null);
  assert.equal(m.get('112.jpg').source, 'instagram');
});

test('instagram: stories, legacy media.json, and private/profile paths excluded', () => {
  const m = new Map();
  parseInstagramJson({ ig_stories: [{ uri: 'media/stories/202401/s1.jpg', creation_timestamp: 1704067200 }] }, m);
  parseInstagramJson({ photos: [{ path: 'photos/201801/old.jpg', taken_at: '2018-01-02T03:04:05' }] }, m);
  parseInstagramJson({ x: [{ uri: 'your_instagram_activity/messages/inbox/bob/photos/dm.jpg', creation_timestamp: 1 },
    { uri: 'media/profile/202001/me.jpg', creation_timestamp: 1 }] }, m);
  assert.deepEqual([...m.keys()].sort(), ['old.jpg', 's1.jpg']);
  assert.equal(m.get('s1.jpg').date.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('x: twitter date format', () => {
  assert.equal(parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018').toISOString(), '2018-10-10T20:19:24.000Z');
  assert.equal(parseTwitterDate('Wed Oct 10 20:19:24 -0700 2018').toISOString(), '2018-10-11T03:19:24.000Z');
});

test('x: tweets.js photos map to tweets_media filenames; retweets and videos skipped', () => {
  const js = `window.YTD.tweets.part0 = ${JSON.stringify([
    { tweet: { id_str: '100', created_at: 'Wed Oct 10 20:19:24 +0000 2018', full_text: 'hike',
      coordinates: { type: 'Point', coordinates: [-122.26, 37.87] },
      extended_entities: { media: [
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AbC.jpg' },
        { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg' },
      ] } } },
    { tweet: { id_str: '101', created_at: 'Thu Oct 11 08:00:00 +0000 2018', full_text: 'RT @someone: look',
      extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Rt.jpg' }] } } },
    { tweet: { id_str: '102', created_at: 'Fri Oct 12 08:00:00 +0000 2018', full_text: 'text only' } },
  ])}`;
  const m = parseTweetsJs(js);
  assert.deepEqual([...m.keys()], ['100-AbC.jpg']);
  const e = m.get('100-AbC.jpg');
  assert.equal(e.lat, 37.87);
  assert.equal(e.lon, -122.26);
  assert.equal(e.source, 'x');
  assert.equal(e.date.toISOString(), '2018-10-10T20:19:24.000Z');
});
