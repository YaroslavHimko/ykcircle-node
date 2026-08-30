import assert from 'node:assert/strict';
import test from 'node:test';
import { Configuration } from '../server/configuration.js';
import { legalDocument, legalDocumentIndex } from '../server/legal-documents.js';

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

test('keeps grouped configuration and compatibility aliases in sync', () => {
  const config = new Configuration({
    ...values(),
    email: { from: { noReply: 'notices@example.test' }, urls: { login: 'https://ykcircle.test/sign-in' } },
    ftp: { articles: { host: 'ftp.example.test', user: 'writer', password: 'secret', uploadPath: '/uploads/articles', publicUrl: 'https://cdn.example.test/articles' } },
  });

  assert.equal(config.noReplyFrom, 'notices@example.test');
  assert.equal(config.loginUrl, 'https://ykcircle.test/sign-in');
  assert.equal(config.ftpArticles, config.ftp.articles);
  assert.equal(config.ftp.articles.publicUrl, 'https://cdn.example.test/articles');
});

test('renders controller details into the current privacy notice', async () => {
  const config = new Configuration({ ...values(), operator: { name: 'Example Founder', email: 'founder@example.test', privacyEmail: 'privacy@example.test', supportEmail: 'support@example.test', moderationEmail: 'moderation@example.test' } });
  const privacy = await legalDocument('privacy', config);
  assert.equal(privacy.version, '2026-08-26');
  assert.match(privacy.content, /Example Founder/);
  assert.match(privacy.content, /privacy@example\.test/);
  assert.match(privacy.contentHash, /^[a-f0-9]{64}$/);
});

test('keeps Maps server credentials separate from browser configuration', () => {
  const config = new Configuration({ ...values(), runtime: { ...values().runtime, maps: { enabled: true, browserApiKey: 'browser-key', serverApiKey: 'server-key', requiresConsent: true } } });
  assert.deepEqual(config.runtime.maps, { enabled: true, browserApiKey: 'browser-key', serverApiKey: 'server-key', requiresConsent: true });
});

test('rejects reusing a browser Maps key as a server key', () => {
  assert.throws(() => new Configuration({ ...values(), runtime: { ...values().runtime, maps: { enabled: true, browserApiKey: 'same-key', serverApiKey: 'same-key' } } }), /must be separate/);
});

test('publishes all public legal document metadata and handles unknown slugs', async () => {
  const index = legalDocumentIndex();

  assert.equal(index.length, 6);
  assert.deepEqual(index.map(({ slug }) => slug), ['terms', 'privacy', 'community-guidelines', 'organizer-terms', 'tickets-refunds', 'cookies']);
  assert.ok(index.every((document) => document.url === `/api/legal-documents/${document.slug}` && document.format === 'markdown'));
  assert.equal(await legalDocument('not-a-document'), null);
});
