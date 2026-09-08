import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

  const legalIndex = await fetch(`${baseUrl}/api/legal-documents`);
  const legalDocuments = await legalIndex.json();
  assert.equal(legalDocuments.length, 9);
  for (const item of legalDocuments) {
    const page = await fetch(`${baseUrl}/${item.slug}`);
    assert.equal(page.status, 200, `${item.slug} must be public`);
    assert.match(await page.text(), /Current version:/);
  }
  const venueTerms = await fetch(`${baseUrl}/venue-terms`);
  const venueTermsHtml = await venueTerms.text();
  assert.match(venueTermsHtml, /<pre><code>Seller:/);
  assert.doesNotMatch(venueTermsHtml, /```text/);

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

test('returns invoices available to the signed-in user', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'venue_owner', sessionVersion: 1, isEmailConfirmed: true }),
    invoicesForViewer: async (userId, role) => [{ id: 19, sellerOrganizationName: 'Harbor Hall', status: 'issued', requestedBy: { userId, role } }],
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60_000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/invoices`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 19, sellerOrganizationName: 'Harbor Hall', status: 'issued', requestedBy: { userId: 7, role: 'venue_owner' } }]);
});

test('does not publish an event until its selected venue confirms the booking', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  let publishCalled = false;
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'manager', sessionVersion: 1, isEmailConfirmed: true }),
    richEvent: async () => ({ id: 12, venue: { id: 4 }, venueBookingStatus: 'requested' }),
    publishRichEvent: async () => { publishCalled = true; },
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60_000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events/12/publish`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: 'VENUE_BOOKING_NOT_CONFIRMED', error: 'The venue owner must confirm the booking before this event can be published.' });
  assert.equal(publishCalled, false);
});

test('lets a verified venue owner submit a draft for review without granting approval access', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  const submissions = [];
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'venue_owner', sessionVersion: 1, isEmailConfirmed: true }),
    canManageVenue: async (venueId, userId, role) => venueId === 4 && userId === 7 && role === 'venue_owner',
    submitVenueForModeration: async (venueId) => { submissions.push(venueId); return true; },
    venue: async () => ({ id: 4, name: 'Harbor Hall', moderationStatus: 'pending', isActive: true, canManage: true }),
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60_000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/venues/4/submit-for-review`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(submissions, [4]);
  assert.equal((await response.json()).moderationStatus, 'pending');

  const approval = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/venues/4/moderation`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ moderationStatus: 'approved' }),
  });
  assert.equal(approval.status, 403);
  assert.deepEqual(await approval.json(), { error: 'Admin access required.' });
});

test('returns a signed cover URL for an owner\'s draft in the events list', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'organizer', sessionVersion: 1, isEmailConfirmed: true }),
    eventsForViewer: async () => [{ id: 12, managerId: 7, status: 'Draft', visibility: 'Public', coverImage: 'event-12.png' }],
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60_000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events`, { headers: { Authorization: `Bearer ${token}` } });
  const [event] = await response.json();
  assert.equal(response.status, 200);
  assert.match(event.coverImage, /^\/api\/media\/event\//);
  assert.equal(event.coverImage, event.coverImageUrl);
  assert.equal(event.coverImage, event.thumbnailUrl);
});

test('creates a requested venue booking with a timed venue draft', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  const bookingCalls = [];
  let createdDraft;
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'organizer', sessionVersion: 1, isEmailConfirmed: true }),
    eventLocationVenue: async () => ({ id: 4, timezone: 'UTC' }),
    createRichEventSeries: async (draft) => { createdDraft = draft; return { seriesId: null, eventIds: [12] }; },
    requestVenueBooking: async (...args) => { bookingCalls.push(args); return { id: 22, status: 'requested' }; },
    richEvent: async () => ({ id: 12, title: 'Venue draft', coverImage: null }),
    eventVenueBooking: async () => ({ id: 22, venueId: 4, status: 'requested' }),
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60_000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events/drafts`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Venue draft', locationType: 'venue', venueId: 4, startsAtUtc: '2026-10-10T10:00:00Z', endsAtUtc: '2026-10-10T12:00:00Z', coverImage: 'http://localhost:3001/api/media/event/signed-token/event-12.png' }),
  });
  assert.equal(response.status, 201);
  assert.equal(createdDraft.coverImage, 'event-12.png');
  assert.deepEqual(bookingCalls, [[12, 4, 7, 'organizer', undefined]]);
  assert.equal((await response.json()).venueBooking.status, 'requested');
});
