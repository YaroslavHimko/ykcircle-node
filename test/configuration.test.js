import assert from 'node:assert/strict';
import test from 'node:test';
import { Configuration } from '../server/configuration.js';
import { legalDocument, legalDocumentIndex, legalReadiness } from '../server/legal-documents.js';

const values = (runtime = {}) => ({
  site: { domain: 'ykcircle.test', siteUrl: 'https://ykcircle.test', apiUrl: 'https://api.ykcircle.test' },
  runtime: { authSecret: 'correct-horse-battery-staple-with-more-than-thirty-two-characters', allowedOrigins: ['https://ykcircle.test'], ...runtime },
});

test('rejects a missing, short or predictable authentication secret', () => {
  assert.throws(() => new Configuration(values({ authSecret: 'short' })), /AUTH_SECRET/);
  assert.throws(() => new Configuration(values({ authSecret: 'a'.repeat(64) })), /AUTH_SECRET/);
});

test('requires adult-only registration configuration until minors are designed for', () => {
  assert.throws(() => new Configuration(values({ minimumUserAge: 17 })), /MINIMUM_USER_AGE/);
  assert.equal(new Configuration(values({ minimumUserAge: 18 })).runtime.minimumUserAge, 18);
});

test('rejects wildcard origins and invalid data-retention settings', () => {
  assert.throws(() => new Configuration(values({ allowedOrigins: ['*'] })), /CORS origins/);
  assert.throws(() => new Configuration(values({ retention: { invitationDays: 3651 } })), /Retention setting invitationDays/);
});

test('exposes configuration only through its grouped contract', () => {
  const config = new Configuration({
    ...values(),
    email: { from: { noReply: 'notices@example.test' }, urls: { login: 'https://ykcircle.test/sign-in' } },
    ftp: {
      venues: { host: 'ftp.example.test', user: 'venue-writer', password: 'secret', uploadPath: '/uploads/venues', publicUrl: 'https://cdn.example.test/venues' },
      articles: { host: 'ftp.example.test', user: 'writer', password: 'secret', uploadPath: '/uploads/articles', publicUrl: 'https://cdn.example.test/articles' },
    },
  });

  assert.equal(config.email.from.noReply, 'notices@example.test');
  assert.equal(config.email.urls.login, 'https://ykcircle.test/sign-in');
  assert.equal(config.ftp.articles.publicUrl, 'https://cdn.example.test/articles');
  assert.equal(config.ftp.venues.publicUrl, 'https://cdn.example.test/venues');
  assert.equal(config.noReplyFrom, undefined);
  assert.equal(config.ftpVenues, undefined);
});

test('renders controller details into the current privacy notice', async () => {
  const config = new Configuration({ ...values(), operator: { name: 'Example Founder', email: 'founder@example.test', privacyEmail: 'privacy@example.test', supportEmail: 'support@example.test', moderationEmail: 'moderation@example.test' } });
  const privacy = await legalDocument('privacy', config);
  assert.equal(privacy.version, '2026-09-07');
  assert.match(privacy.content, /Example Founder/);
  assert.match(privacy.content, /privacy@example\.test/);
  assert.match(privacy.contentHash, /^[a-f0-9]{64}$/);
});

test('keeps Maps server credentials separate from browser configuration', () => {
  const previous = Object.fromEntries(['GOOGLE_MAPS_BROWSER_API_KEY', 'GOOGLE_MAPS_SERVER_API_KEY'].map((name) => [name, process.env[name]]));
  delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  try {
    const config = new Configuration({ ...values(), runtime: { ...values().runtime, maps: { enabled: true, browserApiKey: 'browser-key', serverApiKey: 'server-key', requiresConsent: true } } });
    assert.deepEqual(config.runtime.maps, { enabled: true, browserApiKey: 'browser-key', serverApiKey: 'server-key', requiresConsent: true });
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('rejects reusing a browser Maps key as a server key', () => {
  const previous = Object.fromEntries(['GOOGLE_MAPS_BROWSER_API_KEY', 'GOOGLE_MAPS_SERVER_API_KEY'].map((name) => [name, process.env[name]]));
  delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
  try {
    assert.throws(() => new Configuration({ ...values(), runtime: { ...values().runtime, maps: { enabled: true, browserApiKey: 'same-key', serverApiKey: 'same-key' } } }), /must be separate/);
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('uses Maps values supplied by the deployment environment over local configuration', () => {
  const old = Object.fromEntries(['GOOGLE_MAPS_ENABLED', 'GOOGLE_MAPS_BROWSER_API_KEY', 'GOOGLE_MAPS_REQUIRES_CONSENT'].map((name) => [name, process.env[name]]));
  process.env.GOOGLE_MAPS_ENABLED = 'on';
  process.env.GOOGLE_MAPS_BROWSER_API_KEY = 'pipeline-browser-key';
  process.env.GOOGLE_MAPS_REQUIRES_CONSENT = 'yes';
  try {
    const config = new Configuration({ ...values(), runtime: { ...values().runtime, maps: { enabled: false, browserApiKey: 'stale-local-key', requiresConsent: false } } });
    assert.deepEqual(config.runtime.maps, { enabled: true, browserApiKey: 'pipeline-browser-key', serverApiKey: null, requiresConsent: true });
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('publishes all public legal document metadata and handles unknown slugs', async () => {
  const index = legalDocumentIndex();

  assert.equal(index.length, 9);
  assert.deepEqual(index.map(({ slug }) => slug), ['terms', 'privacy', 'community-guidelines', 'organizer-terms', 'venue-terms', 'tickets-refunds', 'paid-services', 'cookies', 'marketplace-transparency']);
  assert.ok(index.every((document) => document.url === `/api/legal-documents/${document.slug}` && document.format === 'markdown'));
  assert.equal(await legalDocument('not-a-document'), null);
});

test('reports missing commercial legal configuration without leaving public document placeholders', async () => {
  const config = new Configuration({ ...values(), operator: { name: 'Example Founder', email: 'founder@example.test', privacyEmail: 'privacy@example.test', supportEmail: 'support@example.test', moderationEmail: 'moderation@example.test' } });
  const readiness = await legalReadiness(config);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((blocker) => blocker.includes('PAYMENT_PROVIDER')));
  assert.doesNotMatch((await legalDocument('paid-services', config)).content, /\[PAYMENT PROVIDER\]/);
});

test('treats malformed optional subprocessor inventory as a legal blocker instead of a startup failure', () => {
  const config = new Configuration({ ...values(), legal: { subprocessors: '{ not valid JSON' } });
  assert.equal(config.legal.subprocessors, null);
});
