import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';

const SECRET = 'a sufficiently random test secret that exceeds thirty two characters';
const FILENAME = 'venue-5-1788108214313-swwwu398.png';
const ftp = (path) => ({ publicPath: () => path });

// Tokens are rebuilt here rather than read back from the API so the wire format
// itself is pinned: payload.signature, base64url, HMAC over a namespaced string.
const sign = (payload, namespace = 'venue-image:') => crypto.createHmac('sha256', SECRET).update(`${namespace}${payload}`).digest('base64url');
const mint = (filename, { expiresInMs = 60000, namespace, signPayload = true } = {}) => {
  const payload = Buffer.from(JSON.stringify({ filename, exp: Date.now() + expiresInMs })).toString('base64url');
  return `${payload}.${signPayload ? sign(payload, namespace) : 'not-a-signature'}`;
};

const startApi = async (t, { visible, user = null }) => {
  const streamed = [];
  const visibilityCalls = [];
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: SECRET, maps: { enabled: false } } },
    database: {},
    queries: {
      initialize: async () => {},
      venueImageVisible: async (...args) => { visibilityCalls.push(args); return typeof visible === 'function' ? visible(...args) : visible; },
      findUserById: async (id) => user?.id === id ? user : null,
    },
    emailService: {},
    ftpService: ftp('/uploads/profiles'),
    eventFtpService: ftp('/uploads/events'),
    groupFtpService: ftp('/uploads/groups'),
    articleFtpService: ftp('/uploads/articles'),
    venueFtpService: {
      publicPath: () => '/uploads/venue-images',
      // Mirrors FtpService.streamImage: an omitted cacheControl means public.
      streamVenueImage: async (filename, response, cacheControl) => {
        streamed.push({ filename, cacheControl });
        response.set('Content-Type', 'image/png');
        response.set('Cache-Control', cacheControl || 'public, max-age=86400');
        response.end('png-bytes');
        return true;
      },
    },
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, streamed, visibilityCalls };
};

test('a signed token serves an unapproved venue image without letting it be cached', async (t) => {
  // venueImageVisible would refuse this image: a valid token is the only way in.
  const { baseUrl, streamed, visibilityCalls } = await startApi(t, { visible: null });

  const response = await fetch(`${baseUrl}/api/media/venue/${FILENAME}?token=${encodeURIComponent(mint(FILENAME))}`);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'png-bytes');
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('vary'), 'Authorization');
  assert.deepEqual(streamed, [{ filename: FILENAME, cacheControl: 'private, no-store, max-age=0' }]);
  // A valid token short-circuits the lookup rather than adding a query.
  assert.deepEqual(visibilityCalls, []);

  // The old storage/public path ignores signed tokens. This guarantees a
  // protected response never depends on the CDN-classified /uploads route.
  const oldPath = await fetch(`${baseUrl}/uploads/venue-images/${FILENAME}?token=${encodeURIComponent(mint(FILENAME))}`);
  assert.equal(oldPath.status, 404);
  assert.deepEqual(streamed, [{ filename: FILENAME, cacheControl: 'private, no-store, max-age=0' }]);
});

test('an authorized user may retrieve private venue media through the API route without a URL token', async (t) => {
  const user = { id: 7, role: 'venue_owner', sessionVersion: 1 };
  const { baseUrl, streamed, visibilityCalls } = await startApi(t, { user, visible: (_filename, userId) => userId === user.id ? { id: 1, publiclyVisible: false } : null });
  const payload = Buffer.from(JSON.stringify({ id: user.id, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const authorization = `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

  const response = await fetch(`${baseUrl}/api/media/venue/${FILENAME}`, { headers: { Authorization: `Bearer ${authorization}` } });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'png-bytes');
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.deepEqual(visibilityCalls, [[FILENAME, user.id, user.role]]);
  assert.deepEqual(streamed, [{ filename: FILENAME, cacheControl: 'private, no-store, max-age=0' }]);
});

test('a public venue image is served without a token and stays shared-cacheable', async (t) => {
  const { baseUrl, streamed, visibilityCalls } = await startApi(t, { visible: { id: 1, publiclyVisible: true } });

  const response = await fetch(`${baseUrl}/uploads/venue-images/${FILENAME}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(streamed, [{ filename: FILENAME, cacheControl: undefined }]);
  assert.deepEqual(visibilityCalls, [[FILENAME, null, null]]);
});

test('venue image tokens are rejected when replayed, tampered with, expired, or foreign', async (t) => {
  const { baseUrl, streamed } = await startApi(t, { visible: null });

  const rejected = {
    // A token minted for one image must not unlock another.
    otherFilename: mint('venue-9-1788108214313-aaaaaaaa.png'),
    expired: mint(FILENAME, { expiresInMs: -1000 }),
    forgedSignature: mint(FILENAME, { signPayload: false }),
    // A signature over the bare payload is what a session token looks like;
    // the venue-image namespace must keep the two from being interchangeable.
    unnamespaced: mint(FILENAME, { namespace: '' }),
    missing: '',
  };

  for (const [reason, token] of Object.entries(rejected)) {
    const response = await fetch(`${baseUrl}/api/media/venue/${FILENAME}?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 403, `expected 403 for ${reason}`);
    assert.deepEqual(await response.json(), { error: 'Protected media access denied.' });
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0', `expected protected no-store for ${reason}`);
  }

  // Nothing reached storage for any rejected token.
  assert.deepEqual(streamed, []);
});
