import assert from 'node:assert/strict';
import test from 'node:test';
import { EmailService } from '../server/email-service.js';

const makeService = (database = { execute: async () => [[]] }) => new EmailService({
  smtp: { host: 'smtp.example.test', port: 587, secure: false, verification: {}, notification: {}, invitation: {} },
  domain: 'ykcircle.test', brandName: 'Yk <Circle>', noReplyFrom: 'no-reply@ykcircle.test',
  verificationUrl: 'https://ykcircle.test/verify-email', passwordResetUrl: 'https://ykcircle.test/reset-password',
  managerEventUrl: 'https://ykcircle.test/manager/events',
  eventDetailsUrl: 'https://ykcircle.test/events/', invitationResponseUrl: 'https://ykcircle.test/invitation-response',
  groupInvitationUrl: 'https://ykcircle.test/group-invitation', loginUrl: 'https://ykcircle.test/login',
  unsubscribeUrl: 'https://ykcircle.test/unsubscribe', unsubscribeEndpointUrl: 'https://api.ykcircle.test/api/email/unsubscribe',
  unsubscribeSecret: 'test-secret', notificationFrom: 'info@ykcircle.test', invitationFrom: 'hello@ykcircle.test', database,
});

test('automatic emails share the notifications address and route replies to support or privacy', async () => {
  const messages = [];
  const service = new EmailService({
    smtp: { host: 'smtp.example.test', verification: {}, notification: {}, invitation: {} },
    domain: 'ykcircle.test', brandName: 'YKCircle', replyTo: 'support@ykcircle.test', privacyReplyTo: 'privacy@ykcircle.test',
    verificationUrl: 'https://ykcircle.test/verify-email', passwordResetUrl: 'https://ykcircle.test/reset-password',
    groupInvitationUrl: 'https://ykcircle.test/group-invitation', eventDetailsUrl: 'https://ykcircle.test/events',
    invitationResponseUrl: 'https://ykcircle.test/invitation-response',
    database: { execute: async () => [[{ enabled: 1 }]] },
  });
  service.mailer = service.invitationMailer = service.notificationMailer = { sendMail: async message => { messages.push(message); return { accepted: [message.to] }; } };
  await service.sendVerification('reader@example.test', 'Reader', 'verify');
  await service.sendPasswordReset('reader@example.test', 'Reader', 'reset');
  await service.sendGroupInvitation('reader@example.test', 'Reader', { name: 'Neighbours' }, 'invite');
  await service.sendEventInvitation('reader@example.test', 'Reader', { id: 1, title: 'Meetup' }, 'invite');
  await service.sendGroupEventNotification('reader@example.test', 'Reader', { name: 'Neighbours' }, { id: 1, title: 'Meetup' });
  await service.sendAccountDeleted('reader@example.test', 'Reader');
  for (const message of messages) assert.equal(message.from.address, 'notifications@ykcircle.test');
  for (const message of messages.slice(0, -1)) assert.equal(message.replyTo, 'support@ykcircle.test');
  assert.equal(messages.at(-1).replyTo, 'privacy@ykcircle.test');
  assert.equal(messages[0].from.name, 'YKCircle');
  assert.equal(messages[2].from.name, 'YKCircle Invitations');
  assert.equal(messages[3].from.name, 'YKCircle Invitations');
  assert.equal(messages[4].from.name, 'YKCircle Events');
  service.mailer.close?.();
});

test('creates stable, case-insensitive unsubscribe tokens', () => {
  const service = makeService();

  assert.equal(service.unsubscribeToken(' Person@Example.test '), service.unsubscribeToken('person@example.test'));
  assert.match(service.unsubscribeToken('person@example.test'), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('optional invitation and group announcement emails respect each recipient preference', async () => {
  for (const [method, column, args] of [
    ['sendEventInvitation', 'event_invitations', ['person@example.test', 'Person', { id: 1, title: 'Meetup' }]],
    ['sendGroupInvitation', 'group_invitations', ['person@example.test', 'Person', { name: 'Neighbours' }, 'token']],
    ['sendGroupEventNotification', 'group_event_announcements', ['person@example.test', 'Person', { name: 'Neighbours' }, { id: 1, title: 'Meetup' }]],
  ]) {
    const service = makeService({ execute: async (sql, values) => {
      assert.match(sql, new RegExp(`p\\.${column} AS enabled`));
      assert.deepEqual(values, ['person@example.test']);
      return [[{ enabled: 0 }]];
    } });
    service.invitationMailer = service.notificationMailer = { sendMail: async () => { assert.fail('Opted-out recipient must not receive mail'); } };
    assert.equal((await service[method](...args)).suppressed, true);
  }
});

test('optional email choices do not suppress account verification messages', async () => {
  const service = makeService({ execute: async () => { assert.fail('Security mail must not check optional preferences'); } });
  let sent = false;
  service.mailer = { sendMail: async () => { sent = true; } };
  await service.sendVerification('person@example.test', 'Person', 'token');
  assert.equal(sent, true);
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
