import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { Queries } from '../server/queries.js';

const secret = 'a sufficiently random test secret that exceeds thirty two characters';
const ftp = (path) => ({ publicPath: () => path });
const tokenFor = (id) => {
  const payload = Buffer.from(JSON.stringify({ id, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
};

test('Contact Us messages are readable only by managers and admins', async (t) => {
  const users = {
    1: { id: 1, email: 'customer@example.test', role: 'customer', sessionVersion: 1 },
    2: { id: 2, email: 'manager@example.test', role: 'manager', sessionVersion: 1 },
    3: { id: 3, email: 'admin@example.test', role: 'admin', sessionVersion: 1 },
  };
  const messages = [{ id: 9, reference: 'CON-9', name: 'Guest', email: 'guest@example.test', category: 'General', message: 'Can you help?', status: 'submitted', createdAt: '2026-10-01T10:00:00Z' }];
  let reads = 0;
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {},
    queries: { initialize: async () => {}, findUserById: async (id) => users[id] || null, contactMessages: async () => { reads++; return messages; } },
    emailService: {},
    ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'),
    groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/contact-messages`;

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${tokenFor(1)}` } })).status, 403);
  for (const id of [2, 3]) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${tokenFor(id)}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), messages);
  }
  assert.equal(reads, 2);
});

test('attending events are scoped to the signed-in account', async (t) => {
  const user = { id: 7, email: 'guest@example.test', role: 'customer', sessionVersion: 1 };
  const calls = [];
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {},
    queries: { initialize: async () => {}, findUserById: async (id) => id === user.id ? user : null, attendingEvents: async (...args) => { calls.push(args); return [{ id: 4, title: 'Private gathering', isInvited: true }]; } },
    emailService: {},
    ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), venueFtpService: ftp('/uploads/venue-images'),
    groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/api/my/attending-events`;

  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${tokenFor(user.id)}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 4, title: 'Private gathering', isInvited: true }]);
  assert.deepEqual(calls, [[user.id, user.email]]);
});

test('attending event lookup keeps one row per event and filters inactive invitations and registrations', async () => {
  const database = { execute: async (sql, params) => {
    assert.match(sql, /EXISTS \(SELECT 1 FROM event_registrations/);
    assert.match(sql, /r.status NOT IN \('Cancelled', 'Declined', 'Withdrawn'\)/);
    assert.match(sql, /i.token_expires_at > NOW\(\)/);
    assert.match(sql, /e.deleted_at IS NULL/);
    assert.match(sql, /o.event_id = e.id AND o.attendee_user_id = \?/);
    assert.match(sql, /o.payment_status = 'paid' AND EXISTS \(SELECT 1 FROM issued_tickets t WHERE t.ticket_order_id = o.id\)/);
    assert.deepEqual(params, [7, 7, 'guest@example.test', 7, 'guest@example.test', 'guest@example.test']);
    return [[{ id: 4, isRegistered: 1, isParticipating: 1, isInvited: 0 }]];
  } };
  const events = await new Queries(database).attendingEvents(7, 'Guest@Example.Test');
  assert.deepEqual(events, [{ id: 4, ticketOrderIds: [], isRegistered: true, isParticipating: true, isInvited: false }]);
});

test('attending event tickets support one or multiple orders and events without tickets', async () => {
  const queries = new Queries({ execute: async () => [[
    { id: 1, ticketOrderIds: '[12]', isParticipating: 1 },
    { id: 2, ticketOrderIds: [13, 14], isParticipating: 1 },
    { id: 3, ticketOrderIds: null, isParticipating: 1 },
  ]] });
  const events = await queries.attendingEvents(7, 'guest@example.test');
  assert.deepEqual(events.map((event) => event.ticketOrderIds), [[12], [13, 14], []]);
});
