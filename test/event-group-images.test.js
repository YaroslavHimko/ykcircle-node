import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';

const SECRET = 'a sufficiently random test secret that exceeds thirty two characters';
const ftp = (path) => ({ publicPath: () => path });

// Tokens are rebuilt here rather than read back from the API so the wire format
// itself is pinned: payload.signature, base64url, HMAC over a namespaced string.
const sign = (payload, namespace) => crypto.createHmac('sha256', SECRET).update(`${namespace}:${payload}`).digest('base64url');
const mint = (namespace, filename, { expiresInMs = 60000, signNamespace, signPayload = true } = {}) => {
  const payload = Buffer.from(JSON.stringify({ filename, exp: Date.now() + expiresInMs })).toString('base64url');
  return `${payload}.${signPayload ? sign(payload, signNamespace ?? namespace) : 'not-a-signature'}`;
};

const startApi = async (t, { eventCoverVisible, groupForCover }) => {
  const streamed = { event: [], group: [] };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: SECRET, maps: { enabled: false } } },
    database: {},
    queries: {
      initialize: async () => {},
      eventCoverVisible: async (...args) => eventCoverVisible(...args),
      groupForCover: async (...args) => groupForCover(...args),
    },
    emailService: {},
    ftpService: ftp('/uploads/profiles'),
    eventFtpService: {
      publicPath: () => '/uploads/event-covers',
      streamEventCover: async (filename, response, cacheControl) => {
        streamed.event.push({ filename, cacheControl });
        response.set('Content-Type', 'image/png');
        response.set('Cache-Control', cacheControl || 'public, max-age=86400');
        response.end('event-png');
        return true;
      },
    },
    groupFtpService: {
      publicPath: () => '/uploads/group-covers',
      streamGroupCover: async (filename, response, cacheControl) => {
        streamed.group.push({ filename, cacheControl });
        response.set('Content-Type', 'image/png');
        response.set('Cache-Control', cacheControl || 'public, max-age=86400');
        response.end('group-png');
        return true;
      },
    },
    articleFtpService: ftp('/uploads/articles'),
    venueFtpService: ftp('/uploads/venue-images'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, streamed };
};

// uploadEventCover() historically stores publicPath()/filename (a full path)
// in cover_image, unlike venues/groups which store a bare filename. These two
// pin that decorateEventImage reduces it to a filename before it becomes a
// route param or a token payload - otherwise the URL doubles the upload path.
test('a public event exposes coverImageUrl without doubling a legacy full-path cover_image', async (t) => {
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: SECRET, maps: { enabled: false } } },
    database: {},
    queries: {
      initialize: async () => {},
      richEvent: async () => ({ id: 1, managerId: 7, status: 'Published', visibility: 'Public', coverImage: '/uploads/event-covers/event-1-1786906288459.png', groupId: null }),
      publicEventParticipants: async () => [],
    },
    emailService: {},
    ftpService: ftp('/uploads/profiles'),
    eventFtpService: { publicPath: () => '/uploads/event-covers' },
    groupFtpService: ftp('/uploads/group-covers'),
    articleFtpService: ftp('/uploads/articles'),
    venueFtpService: ftp('/uploads/venue-images'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/events/1`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.coverImageUrl, '/uploads/event-covers/event-1-1786906288459.png');
});

test('a private draft event tokens the bare cover filename, not the stored full path', async (t) => {
  const app = express();
  app.use(express.json());
  const managerId = 7;
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: SECRET, maps: { enabled: false } } },
    database: {},
    queries: {
      initialize: async () => {},
      findUserById: async (id) => (id === managerId ? { id: managerId, role: 'customer', sessionVersion: 1 } : null),
      richEvent: async () => ({ id: 1, managerId, status: 'Draft', visibility: 'Private', coverImage: '/uploads/event-covers/event-1-1786906288459.png', groupId: null }),
      publicEventParticipants: async () => [],
      eventParticipantStatus: async () => null,
    },
    emailService: {},
    ftpService: ftp('/uploads/profiles'),
    eventFtpService: { publicPath: () => '/uploads/event-covers' },
    groupFtpService: ftp('/uploads/group-covers'),
    articleFtpService: ftp('/uploads/articles'),
    venueFtpService: ftp('/uploads/venue-images'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const payload = Buffer.from(JSON.stringify({ id: managerId, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const authToken = `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

  const response = await fetch(`${baseUrl}/api/events/1`, { headers: { Authorization: `Bearer ${authToken}` } });
  const body = await response.json();

  assert.equal(response.status, 200);
  const [urlPath, query] = body.coverImageUrl.split('?');
  assert.equal(urlPath, '/uploads/event-covers/event-1-1786906288459.png');
  const [tokenPayload] = new URLSearchParams(query).get('token').split('.');
  assert.equal(JSON.parse(Buffer.from(tokenPayload, 'base64url').toString()).filename, 'event-1-1786906288459.png');
});

test('a signed token serves a draft event cover without letting it be cached', async (t) => {
  const filename = 'event-4-1788108214313-aaaaaaaa.png';
  const { baseUrl, streamed } = await startApi(t, { eventCoverVisible: async () => { throw new Error('must not query visibility once a token is valid'); }, groupForCover: async () => null });

  const response = await fetch(`${baseUrl}/uploads/event-covers/${filename}?token=${encodeURIComponent(mint('event-cover', filename))}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(streamed.event, [{ filename, cacheControl: 'private, no-store' }]);
});

test('a published public event cover is served without a token and stays shared-cacheable', async (t) => {
  const filename = 'event-4-1788108214313-aaaaaaaa.png';
  const { baseUrl, streamed } = await startApi(t, { eventCoverVisible: async () => ({ id: 4, publiclyVisible: true }), groupForCover: async () => null });

  const response = await fetch(`${baseUrl}/uploads/event-covers/${filename}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(streamed.event, [{ filename, cacheControl: undefined }]);
});

test('an event cover token minted for another event or another resource kind is rejected', async (t) => {
  const filename = 'event-4-1788108214313-aaaaaaaa.png';
  const { baseUrl, streamed } = await startApi(t, { eventCoverVisible: async () => null, groupForCover: async () => null });

  const rejected = {
    otherFilename: mint('event-cover', 'event-9-1788108214313-bbbbbbbb.png'),
    // A venue-image token must not unlock an event cover even with a matching filename.
    wrongKind: mint('event-cover', filename, { signNamespace: 'venue-image' }),
    expired: mint('event-cover', filename, { expiresInMs: -1000 }),
    forgedSignature: mint('event-cover', filename, { signPayload: false }),
  };

  for (const [reason, token] of Object.entries(rejected)) {
    const response = await fetch(`${baseUrl}/uploads/event-covers/${filename}?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 404, `expected 404 for ${reason}`);
  }
  assert.deepEqual(streamed.event, []);
});

test('a signed token serves a private group cover without letting it be cached', async (t) => {
  const filename = 'group-2-1788108214313-cccccccc.png';
  const { baseUrl, streamed } = await startApi(t, { eventCoverVisible: async () => null, groupForCover: async () => { throw new Error('must not query visibility once a token is valid'); } });

  const response = await fetch(`${baseUrl}/uploads/group-covers/${filename}?token=${encodeURIComponent(mint('group-cover', filename))}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(streamed.group, [{ filename, cacheControl: 'private, no-store' }]);
});

test('a public group cover is served without a token and stays shared-cacheable', async (t) => {
  const filename = 'group-2-1788108214313-cccccccc.png';
  const { baseUrl, streamed } = await startApi(t, { eventCoverVisible: async () => null, groupForCover: async () => ({ id: 2, publiclyVisible: true }) });

  const response = await fetch(`${baseUrl}/uploads/group-covers/${filename}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(streamed.group, [{ filename, cacheControl: undefined }]);
});

test('a private group cover 404s for an anonymous request with no token', async (t) => {
  const filename = 'group-2-1788108214313-cccccccc.png';
  const { baseUrl, streamed } = await startApi(t, { eventCoverVisible: async () => null, groupForCover: async () => null });

  const response = await fetch(`${baseUrl}/uploads/group-covers/${filename}`);

  assert.equal(response.status, 404);
  assert.deepEqual(streamed.group, []);
});
