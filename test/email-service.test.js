import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from '../server/email-service.js';

const makeService = (database = { execute: async () => [[]] }) => new EmailService({
  smtp: { host: 'smtp.example.test', port: 587, secure: false, verification: {}, applicationNotification: {}, invitation: {} },
  domain: 'ykcircle.test', brandName: 'Yk <Circle>', noReplyFrom: 'no-reply@ykcircle.test',
  verificationUrl: 'https://ykcircle.test/verify-email', passwordResetUrl: 'https://ykcircle.test/reset-password',
  applicationUrl: 'https://ykcircle.test/admin/applications', managerEventUrl: 'https://ykcircle.test/manager/events',
  eventDetailsUrl: 'https://ykcircle.test/events/', invitationResponseUrl: 'https://ykcircle.test/invitation-response',
  groupInvitationUrl: 'https://ykcircle.test/group-invitation', loginUrl: 'https://ykcircle.test/login',
  unsubscribeUrl: 'https://ykcircle.test/unsubscribe', unsubscribeEndpointUrl: 'https://api.ykcircle.test/api/email/unsubscribe',
  unsubscribeSecret: 'test-secret', notificationFrom: 'info@ykcircle.test', invitationFrom: 'hello@ykcircle.test', database,
});

test('creates stable, case-insensitive unsubscribe tokens', () => {
  const service = makeService();

  assert.equal(service.unsubscribeToken(' Person@Example.test '), service.unsubscribeToken('person@example.test'));
  assert.match(service.unsubscribeToken('person@example.test'), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('suppresses marketing mail for recipients without consent', async () => {
  const service = makeService({ execute: async () => [[]] });

  const result = await service.sendMarketing({ to: ['no@example.test', { address: 'also-no@example.test' }], subject: 'News' });

  assert.deepEqual(result, { accepted: [], rejected: ['no@example.test', 'also-no@example.test'], suppressed: true });
});

test('sends marketing mail only to opted-in recipients with an unsubscribe link', async () => {
  const calls = [];
  const service = makeService({
    execute: async (_sql, [email]) => [email === 'yes@example.test' ? [{ marketingOptIn: 1 }] : []],
  });
  service.notificationMailer = { sendMail: async (message) => { calls.push(message); return { messageId: 'sent' }; } };

  const result = await service.sendMarketing({ to: ['yes@example.test', 'no@example.test'], subject: 'News', text: 'Hello', html: '<p style="color:#0ea5e9">Hello</p>' });

  assert.deepEqual(result, { messageId: 'sent' });
  assert.deepEqual(calls[0].to, ['yes@example.test']);
  assert.match(calls[0].text, /Unsubscribe from marketing emails: https:\/\/api\.ykcircle\.test\/api\/email\/unsubscribe\?token=/);
  assert.match(calls[0].html, /color:#c94b1b/);
});

test('escapes personal data and URL-encodes tokens in transactional emails', async () => {
  const calls = [];
  const service = makeService();
  service.mailer = { sendMail: async (message) => { calls.push(message); return message; } };

  await service.sendVerification('person@example.test', '<Admin>', 'a token&value');

  assert.match(calls[0].html, /Hi &lt;Admin&gt;/);
  assert.match(calls[0].html, /token=a%20token%26value/);
  assert.match(calls[0].subject, /Yk <Circle>/);
});
