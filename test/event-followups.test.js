import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { Queries } from '../server/queries.js';

const secret = 'a sufficiently random test secret that exceeds thirty two characters';
const tokenFor = (id) => {
  const payload = Buffer.from(JSON.stringify({ id, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
};
const ftp = { publicPath: () => '/uploads' };

test('only the event owner can finish a published event after its end', async (t) => {
  const users = { 1: { id: 1, role: 'customer', sessionVersion: 1 }, 2: { id: 2, role: 'customer', sessionVersion: 1 } };
  const event = { id: 9, managerId: 1, status: 'Published', startsAt: new Date(Date.now() - 120000), endsAt: new Date(Date.now() + 60000) };
  let finishes = 0;
  const app = express(); app.use(express.json());
  new Api({
    config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries: {
      initialize: async () => {}, findUserById: async (id) => users[id],
      managedFollowupEvent: async (_id, userId) => userId === 1 ? event : null,
      finishEvent: async () => { finishes++; event.status = 'Completed'; return true; },
    }, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp,
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/events/9/status`;
  const patch = (id) => fetch(url, { method: 'PATCH', headers: { Authorization: `Bearer ${tokenFor(id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Completed' }) });
  assert.equal((await patch(2)).status, 404);
  assert.equal((await patch(1)).status, 409);
  event.endsAt = new Date(Date.now() - 60000);
  assert.equal((await patch(1)).status, 200);
  assert.equal((await patch(1)).status, 409);
  assert.equal(finishes, 1);
});

test('finishing uses the start time when an event has no end time', async () => {
  const calls = [];
  const queries = new Queries({ execute: async (sql, params) => { calls.push({ sql, params }); return [{ affectedRows: 1 }]; } });
  assert.equal(await queries.finishEvent(9, 1, 'customer'), true);
  assert.match(calls[0].sql, /COALESCE\(ends_at, starts_at\) <= UTC_TIMESTAMP\(\)/);
  assert.deepEqual(calls[0].params, [9, 1]);
});

test('follow-ups require ownership, completed status and a saved template', async (t) => {
  const users = { 1: { id: 1, role: 'customer', sessionVersion: 1 }, 2: { id: 2, role: 'customer', sessionVersion: 1 } };
  const event = { id: 9, managerId: 1, status: 'Published', title: 'Gathering', brandName: 'Organizer' };
  const templates = {};
  const delivered = [];
  let queueCalls = 0;
  const overview = () => ({ attendance: { attended: 1, noShow: 0, unmarked: 1, attendedWithEmail: 1, noShowWithEmail: 0 }, templates: { ...templates }, deliveries: { attended: { sent: delivered.length } } });
  const app = express(); app.use(express.json());
  new Api({
    config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: {},
    queries: { initialize: async () => {}, findUserById: async (id) => users[id], managedFollowupEvent: async (_id, userId) => userId === 1 ? event : null,
      eventFollowupOverview: async () => overview(), saveEventFollowupTemplate: async (_id, audience, subject, body) => { templates[audience] = { subject, body }; return true; },
      queueEventFollowup: async () => { queueCalls++; return [{ id: 4, email: 'attended@example.test', name: 'Attendee' }]; },
      claimEventFollowupDelivery: async () => delivered.length === 0,
      finishEventFollowupDelivery: async () => { delivered.push(4); },
    },
    emailService: { sendEventFollowup: async (...args) => { assert.deepEqual(args.slice(0, 2), ['attended@example.test', 'Attendee']); } },
    ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp,
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const root = `http://127.0.0.1:${server.address().port}/api/events/9/followups`;
  const request = (id, path, method, body) => fetch(`${root}${path}`, { method, headers: { Authorization: `Bearer ${tokenFor(id)}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  assert.equal((await request(2, '', 'GET')).status, 404);
  assert.equal((await request(1, '', 'GET')).status, 409);
  event.status = 'Completed';
  assert.equal((await request(1, '/attended/send', 'POST')).status, 409);
  assert.equal((await request(1, '/attended', 'PUT', { subject: '<Hello>', body: '<script>bad</script>' })).status, 200);
  const first = await request(1, '/attended/send', 'POST');
  assert.equal(first.status, 200);
  assert.equal((await first.json()).sent, 1);
  assert.equal((await request(1, '/attended/send', 'POST')).status, 200);
  assert.equal(delivered.length, 1);
  assert.equal(queueCalls, 2);
});

test('follow-up queue selects only explicitly marked participants with email and claims once', async () => {
  const calls = [];
  const queries = new Queries({ execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT d.id')) return [[{ id: 4, email: 'attended@example.test', name: 'Guest' }]];
    return [{ affectedRows: 1 }];
  } });
  const recipients = await queries.queueEventFollowup(9, 'attended');
  assert.deepEqual(recipients.map(({ email }) => email), ['attended@example.test']);
  assert.match(calls[0].sql, /e.status = 'Completed' AND p.status = \?/);
  assert.match(calls[0].sql, /participant_email.*u.email.*IS NOT NULL/s);
  assert.deepEqual(calls[0].params, ['attended', 9, 'Attended']);
  assert.deepEqual(calls[1].params, [9, 'attended', 'Attended']);
  assert.equal(await queries.claimEventFollowupDelivery(4), true);
  assert.match(calls[2].sql, /status IN \('pending','failed'\)/);
});
