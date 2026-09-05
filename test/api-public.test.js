import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { EMAIL_UNSUBSCRIBE_REASONS } from '../server/email-unsubscribe-reasons.js';

const ftp = (path) => ({ publicPath: () => path });

test('serves public API resources and validates unsubscribe requests', async (t) => {
  const preferenceCalls = [];
  const queries = {
    initialize: async () => {},
    setMarketingEmailPreference: async (...args) => preferenceCalls.push(args),
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: 'a sufficiently random test secret that exceeds thirty two characters', maps: { enabled: true, browserApiKey: 'restricted-browser-key', serverApiKey: 'must-not-leak', requiresConsent: true } } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const statuses = await fetch(`${baseUrl}/api/event-statuses`);
  assert.deepEqual(await statuses.json(), ['Draft', 'Published', 'Cancelled', 'Completed', 'Archived']);

  const maps = await fetch(`${baseUrl}/api/maps/config`);
  assert.deepEqual(await maps.json(), { enabled: true, browserApiKey: 'restricted-browser-key', requiresConsent: true });
  assert.equal(maps.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
  assert.equal(maps.headers.get('x-robots-tag'), 'noindex, noarchive');

  const communityPosts = await fetch(`${baseUrl}/api/community/posts`);
  assert.equal(communityPosts.status, 404);

  const reasons = await fetch(`${baseUrl}/api/email/unsubscribe-reasons`);
  assert.deepEqual(await reasons.json(), EMAIL_UNSUBSCRIBE_REASONS);

  const legal = await fetch(`${baseUrl}/api/legal-documents/privacy`);
  const document = await legal.json();
  assert.equal(legal.status, 200);
  assert.equal(document.slug, 'privacy');
  assert.match(document.contentHash, /^[a-f0-9]{64}$/);

  const invalid = await fetch(`${baseUrl}/api/email/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invalid', reason: 'Unknown' }) });
  assert.equal(invalid.status, 400);
  assert.equal(preferenceCalls.length, 0);

  const retiredContentType = await fetch(`${baseUrl}/api/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entityType: 'community_post' }) });
  assert.equal(retiredContentType.status, 422);
});

test('returns a backend-selected next available interval for an unavailable date', async (t) => {
  const queries = {
    initialize: async () => {},
    calculateVenueAvailability: async (_venueId, from, to) => ({
      venueId: 9, timezone: 'Europe/Stockholm', bookingMode: 'hourly', slotIncrementMinutes: 30,
      minimumBookingMinutes: 60, maximumBookingMinutes: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
      dates: from === to
        ? [{ date: from, availabilityStatus: 'unavailable', availableIntervals: [], unavailableIntervals: [{ start: '10:00', end: '11:00' }] }]
        : [{ date: '2026-09-15', availabilityStatus: 'available', availableIntervals: [{ start: '10:00', end: '12:00' }] }],
    }),
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: 'a sufficiently random test secret that exceeds thirty two characters', maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/venues/9/availability?date=2026-09-14`);
  assert.equal(response.status, 200);
  const availability = await response.json();
  assert.deepEqual(availability.slots, []);
  assert.deepEqual(availability.unavailableSlots, [{ startTime: '10:00', endTime: '11:00' }]);
  assert.deepEqual(availability.nextAvailable, { date: '2026-09-15', startTime: '10:00', endTime: '12:00' });
});
