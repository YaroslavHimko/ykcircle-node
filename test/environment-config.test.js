import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const cwd = new URL('../', import.meta.url);
const script = `
  import values from './server/config.js';
  import { Configuration } from './server/configuration.js';
  console.log(JSON.stringify(new Configuration(values)));
`;
const environment = (overrides = {}) => ({
  SystemRoot: process.env.SystemRoot,
  AUTH_SECRET: 'environment-config-test-secret-with-more-than-32-characters',
  ...overrides,
});
const load = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env: environment(env), encoding: 'utf8' }));

test('deployment config uses runtime variables for services, contacts and feature switches', () => {
  const env = {
    NODE_ENV: 'production', DOMAIN: 'preview.example.test', SITE_URL: 'https://preview.example.test', API_URL: 'https://api.preview.example.test', BRAND_NAME: 'Preview',
    PLATFORM_OPERATOR_NAME: 'Test Operator', PLATFORM_REGISTERED_ADDRESS: 'Test address', PLATFORM_COUNTRY: 'Test country', PLATFORM_ORGANISATION_NUMBER: 'TEST-ORG', PLATFORM_VAT_NUMBER: 'TEST-VAT',
    DB_HOST: 'db.example.test', DB_NAME: 'preview', DB_USER: 'preview-user', DB_PASSWORD: 'fake-database-password', DB_PORT: '3307',
    SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'mail@example.test', SMTP_PASSWORD: 'fake-mail-password',
    EMAIL_REPLY_TO: 'reply@example.test', NO_REPLY_FROM: 'sender@example.test', APPLICATION_NOTIFICATION_FROM: 'events@example.test', INVITATION_FROM: 'invites@example.test',
    GOOGLE_MAPS_ENABLED: 'true', GOOGLE_MAPS_BROWSER_API_KEY: 'fake-browser-key', GOOGLE_MAPS_REQUIRES_CONSENT: 'true',
    ENABLE_PAID_EVENTS: 'false', ENABLE_PAID_SERVICES: 'false', LEGAL_REQUIRE_READY: 'true',
    STRIPE_SECRET_KEY: 'fake-stripe-key', STRIPE_PUBLISHABLE_KEY: 'fake-publishable-key', STRIPE_WEBHOOK_SECRET: 'fake-ticket-secret', STRIPE_SUBSCRIPTION_WEBHOOK_SECRET: 'fake-subscription-secret',
    SUBPROCESSORS_JSON: JSON.stringify([{ name: 'Test provider', purpose: 'Testing' }]),
  };
  for (const key of ['PLATFORM_OPERATOR_EMAIL', 'PRIVACY_EMAIL', 'SUPPORT_EMAIL', 'MODERATION_EMAIL', 'BILLING_SUPPORT_EMAIL', 'TICKET_SUPPORT_EMAIL', 'VENUE_SUPPORT_EMAIL']) env[key] = `${key.toLowerCase()}@example.test`;
  for (const prefix of ['FTP_PROFILE', 'FTP_EVENT', 'FTP_GROUP', 'FTP_ARTICLE', 'FTP_VENUE']) {
    Object.assign(env, { [`${prefix}_HOST`]: 'ftp.example.test', [`${prefix}_USERNAME`]: prefix, [`${prefix}_PASSWORD`]: 'fake-ftp-password', [`${prefix}_UPLOAD_PATH`]: `/${prefix}`, [`${prefix}_PUBLIC_URL`]: `https://media.example.test/${prefix}`, [`${prefix}_SECURE`]: 'true', [`${prefix}_TLS_SERVERNAME`]: 'tls.example.test' });
  }
  const config = load(env);
  assert.deepEqual(config.site, { domain: env.DOMAIN, siteUrl: env.SITE_URL, apiUrl: env.API_URL, brandName: env.BRAND_NAME });
  assert.deepEqual(config.database, { host: env.DB_HOST, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD, port: 3307 });
  assert.equal(config.email.smtp.port, 465);
  assert.equal(config.email.smtp.secure, true);
  for (const stream of ['verification', 'notification', 'invitation']) assert.deepEqual(config.email.smtp[stream], { user: env.SMTP_USER, password: env.SMTP_PASSWORD });
  assert.equal(config.email.from.notification, env.APPLICATION_NOTIFICATION_FROM);
  assert.equal(config.email.replyTo, env.EMAIL_REPLY_TO);
  assert.equal(config.operator.name, env.PLATFORM_OPERATOR_NAME);
  assert.equal(config.operator.registeredAddress, env.PLATFORM_REGISTERED_ADDRESS);
  assert.equal(config.operator.organisationNumber, env.PLATFORM_ORGANISATION_NUMBER);
  assert.equal(config.operator.vatNumber, env.PLATFORM_VAT_NUMBER);
  for (const [role, prefix] of Object.entries({ profilePictures: 'FTP_PROFILE', events: 'FTP_EVENT', groups: 'FTP_GROUP', articles: 'FTP_ARTICLE', venues: 'FTP_VENUE' })) {
    assert.equal(config.ftp[role].user, env[`${prefix}_USERNAME`]);
    assert.equal(config.ftp[role].password, env[`${prefix}_PASSWORD`]);
    assert.equal(config.ftp[role].publicUrl, env[`${prefix}_PUBLIC_URL`]);
    assert.equal(config.ftp[role].secure, true);
  }
  assert.equal(config.runtime.maps.browserApiKey, env.GOOGLE_MAPS_BROWSER_API_KEY);
  assert.equal(config.runtime.maps.enabled, true);
  assert.equal(config.runtime.maps.requiresConsent, true);
  assert.equal(config.runtime.paidEventsEnabled, false);
  assert.equal(config.runtime.paidServicesEnabled, false);
  assert.equal(config.runtime.legalRequireReady, true);
  assert.equal(config.runtime.stripe.secretKey, env.STRIPE_SECRET_KEY);
  assert.equal(config.runtime.stripe.webhookSecret, env.STRIPE_WEBHOOK_SECRET);
  assert.equal(config.runtime.stripe.subscriptionWebhookSecret, env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET);
  assert.deepEqual(config.legal.subprocessors, JSON.parse(env.SUBPROCESSORS_JSON));
});

test('production config requires explicit deployment URLs', () => {
  for (const missing of ['DOMAIN', 'SITE_URL', 'API_URL']) {
    const env = environment({ NODE_ENV: 'production', DOMAIN: 'example.test', SITE_URL: 'https://example.test', API_URL: 'https://api.example.test', [missing]: '' });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${missing} must be set in the deployment environment`));
  }
});

test('local template uses local endpoints and leaves secrets unconfigured', () => {
  const env = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
  for (const [key, value] of Object.entries(env)) if (/PASSWORD|SECRET|API_KEY|STRIPE_PUBLISHABLE_KEY/.test(key)) assert.equal(value, '', key);
  const config = load({ ...env, AUTH_SECRET: environment().AUTH_SECRET });
  assert.equal(config.site.siteUrl, 'http://localhost:5173');
  assert.equal(config.site.apiUrl, 'http://localhost:3001');
  assert.equal(config.database.host, '127.0.0.1');
  assert.equal(config.runtime.maps.enabled, false);
  assert.equal(config.runtime.legalRequireReady, false);
});
