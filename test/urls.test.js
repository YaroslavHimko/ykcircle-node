import assert from 'node:assert/strict';
import test from 'node:test';
import { actionUrl, webUrl } from '../server/urls.js';
import { Configuration } from '../server/configuration.js';
import { legalDocument } from '../server/legal-documents.js';
import { EmailService } from '../server/email-service.js';

const config = () => new Configuration({ site: { domain: 'ykcircle.test', siteUrl: 'https://preview.ykcircle.test', apiUrl: 'https://api.preview.ykcircle.test' }, runtime: { authSecret: 'random-test-authentication-value-long-enough' } });

test('URL defaults use the deployment site, real routes, and one unsubscribe endpoint', () => {
  const c = config();
  for (const field of ['ticketSupportUrl', 'venueSupportUrl', 'organizerSupportUrl', 'businessSupportUrl']) assert.equal(c.legal[field], 'https://preview.ykcircle.test/contact');
  assert.equal(c.legal.withdrawalFunctionUrl, null);
  assert.equal(c.email.urls.managerEvent, 'https://preview.ykcircle.test/events');
  assert.equal(c.email.urls.unsubscribeEndpoint, 'https://api.preview.ykcircle.test/api/email/unsubscribe');
  assert.equal(c.email.urls.application, undefined);
  assert.equal(c.email.urls.unsubscribe, undefined);
});

test('action links preserve query parameters and encode tokens before fragments', () => {
  const url = new URL(actionUrl('https://ykcircle.test/invitation-response?source=email#reply', { query: { token: 'a+b &?=/', action: 'accept' } }));
  assert.equal(url.searchParams.get('source'), 'email');
  assert.equal(url.searchParams.get('token'), 'a+b &?=/');
  assert.equal(url.searchParams.get('action'), 'accept');
  assert.equal(url.hash, '#reply');
  assert.equal(actionUrl('https://ykcircle.test/events/?source=email', { path: [42], query: { manage: 1 } }), 'https://ykcircle.test/events/42?source=email&manage=1');
  for (const bad of ['javascript:alert(1)', '/relative', 'https://user:password@ykcircle.test']) assert.throws(() => webUrl(bad));
});

test('legal contact links are clickable and account deletion points to the profile', async () => {
  const privacy = await legalDocument('privacy', config());
  assert.match(privacy.content, /\[https:\/\/preview\.ykcircle\.test\/profile\]\(https:\/\/preview\.ykcircle\.test\/profile\)/);
  assert.match(privacy.content, /\(mailto:privacy@ykcircle\.test\)/);
  assert.doesNotMatch(privacy.content, /settings\/privacy/);
  const terms = await legalDocument('organizer-terms', config());
  assert.match(terms.content, /\(https:\/\/preview\.ykcircle\.test\/contact\)/);
  const paid = await legalDocument('paid-services', config());
  assert.match(paid.content, /Not available until YKCircle paid services are launched/);
  assert.doesNotMatch(paid.content, /account\/billing\/withdrawal/);
});

test('manager and invitation emails use reachable routes, preserving configured queries', async () => {
  const c = config(); const messages = [];
  const service = new EmailService({ smtp: { host: 'smtp.test', verification: {}, notification: {}, invitation: {} },
    domain: c.site.domain, siteUrl: c.site.siteUrl, brandName: 'YKCircle',
    managerEventUrl: c.email.urls.managerEvent, eventDetailsUrl: c.email.urls.eventDetails,
    groupInvitationUrl: c.email.urls.groupInvitation + '?source=email#reply',
    database: { execute: async sql => [sql.includes('SELECT role') ? [{ role: 'organizer' }] : []] } });
  service.notificationMailer = service.invitationMailer = { sendMail: async mail => { messages.push(mail); return mail; } };
  await service.sendManagerRegistrationNotification('manager@example.test', 'Manager', 'Guest', 'guest@example.test', 'Walk', 42, 7);
  assert.match(messages[0].html, /href="https:\/\/preview\.ykcircle\.test\/events\/42\?manage=1"/);
  assert.match(messages[0].text, /View registrations: https:\/\/preview\.ykcircle\.test\/events\/42\?manage=1/);
  assert.match(messages[0].html, /href="https:\/\/preview\.ykcircle\.test"/);
  await service.sendGroupInvitation('guest@example.test', 'Guest', { name: 'Walkers' }, 'a+b&c');
  for (const action of ['accept', 'decline']) {
    const url = new URL(messages[1].text.match(new RegExp(`https://[^\\s]+action=${action}[^\\s]*`))[0]);
    assert.equal(url.searchParams.get('token'), 'a+b&c');
    assert.equal(url.searchParams.get('source'), 'email');
    assert.equal(url.hash, '#reply');
  }
});
