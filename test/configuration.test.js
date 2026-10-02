import assert from 'node:assert/strict';
import test from 'node:test';
import { Configuration } from '../server/configuration.js';
import { legalDocument, legalDocumentIndex, legalReadiness } from '../server/legal-documents.js';

const values = (runtime = {}) => ({
  site: { domain: 'ykcircle.test', siteUrl: 'https://ykcircle.test', apiUrl: 'https://api.ykcircle.test' },
  runtime: { authSecret: 'correct-horse-battery-staple-with-more-than-thirty-two-characters', allowedOrigins: ['https://ykcircle.test'], ...runtime },
});

test('five mailboxes cover contacts and share one transactional SMTP login', () => {
  const config = new Configuration({ ...values(), email: { smtp: { host: 'smtp.example.test', transactional: { user: 'notifications@ykcircle.test', password: 'test-mailbox-password' } } } });
  assert.equal(config.operator.email, 'support@ykcircle.test');
  assert.equal(config.operator.supportEmail, 'support@ykcircle.test');
  assert.equal(config.operator.privacyEmail, 'privacy@ykcircle.test');
  assert.equal(config.operator.moderationEmail, 'moderation@ykcircle.test');
  assert.equal(config.legal.billingSupportEmail, 'billing@ykcircle.test');
  assert.equal(config.legal.ticketSupportEmail, 'support@ykcircle.test');
  assert.equal(config.legal.venueSupportEmail, 'support@ykcircle.test');
  assert.equal(config.email.replyTo, 'support@ykcircle.test');
  for (const role of ['noReply', 'notification', 'invitation']) assert.equal(config.email.from[role], 'notifications@ykcircle.test');
  for (const role of ['verification', 'notification', 'invitation']) assert.deepEqual(config.email.smtp[role], { user: 'notifications@ykcircle.test', password: 'test-mailbox-password' });
});

test('shared SMTP deployment settings override local credentials and allow explicit per-stream overrides', () => {
  const overrides = { SMTP_USER: 'notifications@example.test', SMTP_PASSWORD: 'shared-test-password', SMTP_HOST: 'smtp.example.test', SMTP_SECURE: 'false', INVITATION_USER: 'special@example.test', INVITATION_PASSWORD: 'special-test-password' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const config = new Configuration({ ...values(), email: { smtp: { secure: true, verification: { user: 'old@example.test', password: 'old-test-password' } } } });
    assert.equal(config.email.smtp.host, overrides.SMTP_HOST);
    assert.equal(config.email.smtp.secure, false);
    for (const role of ['verification', 'notification']) assert.deepEqual(config.email.smtp[role], { user: overrides.SMTP_USER, password: overrides.SMTP_PASSWORD });
    assert.deepEqual(config.email.smtp.invitation, { user: overrides.INVITATION_USER, password: overrides.INVITATION_PASSWORD });
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('support routes can share a mailbox or be overridden independently', () => {
  const config = new Configuration({ ...values(), operator: { supportEmail: 'help@example.test' }, legal: { venueSupportEmail: 'venues@example.test' }, email: { replyTo: 'replies@example.test', smtp: { applicationNotification: { user: 'legacy@example.test', password: 'test-password' } } } });
  assert.equal(config.operator.email, 'help@example.test');
  assert.equal(config.legal.ticketSupportEmail, 'help@example.test');
  assert.equal(config.legal.venueSupportEmail, 'venues@example.test');
  assert.equal(config.email.replyTo, 'replies@example.test');
  assert.deepEqual(config.email.smtp.notification, { user: 'legacy@example.test', password: 'test-password' });
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
  assert.equal(privacy.version, '2026-10-02');
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

test('keeps webhook secrets separate and lets deployment values override local configuration', () => {
  const names = ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SUBSCRIPTION_WEBHOOK_SECRET', 'STRIPE_THIN_WEBHOOK_SECRET'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const local = { webhookSecret: 'whsec_local_tickets', subscriptionWebhookSecret: 'whsec_local_subscriptions', thinWebhookSecret: 'whsec_local_thin' };
    const config = new Configuration(values({ stripe: local }));
    for (const [field, value] of Object.entries(local)) assert.equal(config.runtime.stripe[field], value);
    assert.equal(new Configuration(values({ stripe: { webhookSecret: local.webhookSecret } })).runtime.stripe.subscriptionWebhookSecret, null);
    assert.equal(new Configuration({ ...values(), stripe: { subscriptionWebhookSecret: local.subscriptionWebhookSecret } }).runtime.stripe.subscriptionWebhookSecret, local.subscriptionWebhookSecret);
    process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET = 'whsec_deployed_subscriptions';
    const deployed = new Configuration(values({ stripe: local })).runtime.stripe;
    assert.equal(deployed.subscriptionWebhookSecret, 'whsec_deployed_subscriptions');
    assert.equal(deployed.webhookSecret, local.webhookSecret);
    assert.equal(deployed.thinWebhookSecret, local.thinWebhookSecret);
  } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('publishes all public legal document metadata and handles unknown slugs', async () => {
  const index = legalDocumentIndex();

  assert.equal(index.length, 4);
  assert.deepEqual(index.map(({ slug }) => slug), ['terms', 'privacy', 'community-guidelines', 'cookies']);
  assert.ok(index.every((document) => document.url === `/api/legal-documents/${document.slug}` && document.format === 'markdown'));
  assert.equal(await legalDocument('not-a-document'), null);
});

test('reports missing early-access controller/provider facts without requiring payment settings', async () => {
  const config = new Configuration({ ...values(), operator: { name: 'Example Founder', email: 'founder@example.test', privacyEmail: 'privacy@example.test', supportEmail: 'support@example.test', moderationEmail: 'moderation@example.test' } });
  const readiness = await legalReadiness(config);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((blocker) => blocker.includes('ADDRESS')));
  assert.ok(readiness.blockers.every((blocker) => !blocker.includes('PAYMENT_PROVIDER')));
  assert.equal(await legalDocument('paid-services', config), null);
});

test('treats malformed optional subprocessor inventory as a legal blocker instead of a startup failure', () => {
  const config = new Configuration({ ...values(), legal: { subprocessors: '{ not valid JSON' } });
  assert.equal(config.legal.subprocessors, null);
});

test('early-access disclosures require real controller and provider details without commercial settings', async () => {
  const config = new Configuration({ ...values(),
    operator: { name: 'Robin Lind', registeredAddress: 'Testgatan 12, 123 45 Stockholm, Sweden', country: 'Sweden' },
    legal: { subprocessors: [{ name: 'Hosting provider', purpose: 'Hosting and email', region: 'EEA', transferSafeguards: 'No transfers outside the EEA in this test configuration' }] },
  });
  const readiness = await legalReadiness(config);
  assert.deepEqual(readiness.blockers, []);
  for (const { slug } of legalDocumentIndex()) {
    const document = await legalDocument(slug, config);
    assert.doesNotMatch(document.content, /organisation|organization|VAT number|\[LEGAL|\[REGISTERED|\[PAYMENT|\uFFFD/i);
    assert.doesNotMatch(document.content, /\]\([^)]*\/(?:paid-services|tickets-refunds|organizer-terms|venue-terms|account\/billing)/);
  }
  config.legal.subprocessors[0].region = null;
  assert.ok((await legalReadiness(config)).blockers.some(value => value.includes('processing locations')));
  config.operator.name = 'Example Founder';
  assert.ok((await legalReadiness(config)).blockers.some(value => value.includes('sample operator')));
});
