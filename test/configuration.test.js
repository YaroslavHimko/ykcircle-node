import assert from 'node:assert/strict';
import test from 'node:test';
import { Configuration } from '../server/configuration.js';
import { legalDocument } from '../server/legal-documents.js';

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

test('renders controller details into the current privacy notice', async () => {
  const config = new Configuration({ ...values(), operator: { name: 'Example Founder', email: 'founder@example.test', privacyEmail: 'privacy@example.test', supportEmail: 'support@example.test', moderationEmail: 'moderation@example.test' } });
  const privacy = await legalDocument('privacy', config);
  assert.equal(privacy.version, '2026-08-26');
  assert.match(privacy.content, /Example Founder/);
  assert.match(privacy.content, /privacy@example\.test/);
  assert.match(privacy.contentHash, /^[a-f0-9]{64}$/);
});
