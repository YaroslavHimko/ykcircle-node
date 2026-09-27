import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';

const code = 'YK-' + 'A1'.repeat(16);
const secondCode = 'YK-' + 'B2'.repeat(16);

function fixture() {
  const state = { event: { id: 2, managerId: 7, status: 'Published' },
    tickets: [code, secondCode].map((value, index) => ({ id: index + 1, code: value, eventId: 2, orderId: 1, attendeeUserId: 3, attendeeEmail: 'guest@example.test', paymentStatus: 'paid', testMode: false, checkedInAt: null })),
    participant: null, registration: { id: 10, status: 'Confirmed' }, writes: 0 };
  const calls = [];
  let queue = Promise.resolve();
  let failWrite = false;
  const execute = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id, manager_id')) return [[state.event].filter((event) => event && event.id === params[0])];
    if (sql.includes('FROM issued_tickets t JOIN ticket_orders')) return [state.tickets.filter((ticket) => ticket.code === params[0] && ticket.eventId === params[1]).map((ticket) => ({ ...ticket }))];
    if (sql.includes('FROM users WHERE')) return [[{ id: 3, name: 'Test Guest', email: 'guest@example.test', phone: null, profilePicture: null }]];
    if (sql.startsWith('SELECT id, status FROM event_registrations')) return [state.registration ? [state.registration] : []];
    if (sql.startsWith('INSERT INTO event_participants')) { state.writes++; state.participant = { id: state.participant?.id || 30, userId: params[1], name: params[2], email: params[3], phone: null, status: 'Attended', paymentStatus: 'Paid' }; return [{ insertId: state.participant.id }]; }
    if (sql.startsWith('UPDATE event_registrations')) { if (state.registration) state.registration.status = 'Attended'; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE issued_tickets')) { if (failWrite) throw new Error('Database unavailable'); const ticket = state.tickets.find((item) => item.id === params[1]); ticket.checkedInAt = '2026-10-10 12:00:00'; ticket.checkedInBy = params[0]; return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM event_participants WHERE')) return [state.participant ? [{ ...state.participant }] : []];
    if (sql.startsWith('SELECT checked_in_at')) return [[{ checkedInAt: state.tickets.find((ticket) => ticket.id === params[0]).checkedInAt }]];
    throw new Error('Unexpected SQL: ' + sql);
  };
  const database = { execute, getConnection: async () => {
    let unlock, before;
    return { execute, beginTransaction: async () => { const previous = queue; queue = new Promise((resolve) => { unlock = resolve; }); await previous; before = structuredClone(state); },
      commit: async () => {}, rollback: async () => Object.assign(state, before), release: () => unlock() };
  } };
  const queries = new Queries(database);
  return { state, calls, queries, failWrites: () => { failWrite = true; } };
}

test('paid ticket creates an attended participant and saves its admission and organizer', async () => {
  const f = fixture();
  const result = await f.queries.checkInTicket(2, 7, 'customer', code);
  assert.equal(result.alreadyCheckedIn, false);
  assert.equal(result.participant.status, 'Attended');
  assert.equal(result.participant.paymentStatus, 'Paid');
  assert.equal(result.checkedInAt, '2026-10-10T12:00:00.000Z');
  assert.equal(f.state.registration.status, 'Attended');
  assert.equal(f.state.tickets[0].checkedInBy, 7);
  assert.match(f.calls.find((call) => call.sql.includes('WHERE t.code')).sql, /o\.event_id=\? FOR UPDATE/);
});

test('concurrent scans admit a ticket only once', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 3 }, () => f.queries.checkInTicket(2, 7, 'organizer', code)));
  assert.equal(results.filter((result) => !result.alreadyCheckedIn).length, 1);
  assert.equal(f.state.writes, 1);
  assert.ok(results.every((result) => result.participant.id === 30));
});

test('separate admissions on a group order reuse the participant without consuming other tickets', async () => {
  const f = fixture();
  await f.queries.checkInTicket(2, 7, 'organizer', code);
  assert.equal(f.state.tickets[1].checkedInAt, null);
  const second = await f.queries.checkInTicket(2, 7, 'organizer', secondCode);
  assert.equal(second.alreadyCheckedIn, false);
  assert.equal(second.participant.id, 30);
});

test('another organizer cannot check in tickets or learn who holds them', async () => {
  const f = fixture();
  assert.deepEqual(await f.queries.checkInTicket(2, 8, 'organizer', code), { error: 'EVENT_NOT_MANAGED' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.writes, 0);
});

test('manager and administrator access follows the existing event-management permissions', async () => {
  for (const role of ['manager', 'admin']) {
    const f = fixture();
    assert.equal((await f.queries.checkInTicket(2, 8, role, code)).participant.status, 'Attended');
  }
});

test('wrong-event and unknown ticket codes do not change attendance', async () => {
  for (const wrongEvent of [false, true]) {
    const f = fixture();
    if (wrongEvent) f.state.tickets[0].eventId = 9;
    assert.deepEqual(await f.queries.checkInTicket(2, 7, 'organizer', wrongEvent ? code : 'YK-' + 'C3'.repeat(16)), { error: 'TICKET_NOT_FOUND' });
    assert.equal(f.state.writes, 0);
  }
});

test('unpaid, cancelled, refunded, partially refunded and disputed tickets are rejected', async () => {
  for (const status of ['pending', 'failed', 'cancelled', 'refunded', 'partially_refunded', 'disputed']) {
    const f = fixture(); f.state.tickets[0].paymentStatus = status;
    assert.deepEqual(await f.queries.checkInTicket(2, 7, 'organizer', code), { error: 'TICKET_NOT_PAID' });
    assert.equal(f.state.writes, 0);
  }
});

test('cancelled events and inactive participants cannot be admitted', async () => {
  for (const status of ['Draft', 'Cancelled', 'Archived']) {
    const f = fixture(); f.state.event.status = status;
    assert.deepEqual(await f.queries.checkInTicket(2, 7, 'organizer', code), { error: 'EVENT_NOT_OPEN' });
  }
  for (const status of ['Cancelled', 'Withdrawn', 'Declined']) {
    const f = fixture(); f.state.registration.status = status;
    assert.deepEqual(await f.queries.checkInTicket(2, 7, 'organizer', code), { error: 'REGISTRATION_INACTIVE' });
    assert.equal(f.state.writes, 0);
  }
});

test('an existing participant is updated and failed admission writes roll back attendance', async () => {
  const f = fixture(); f.state.participant = { id: 44, status: 'No Show' }; f.state.registration = null;
  const result = await f.queries.checkInTicket(2, 7, 'organizer', code);
  assert.equal(result.participant.id, 44); assert.equal(result.participant.status, 'Attended');
  const failed = fixture(); failed.failWrites();
  await assert.rejects(failed.queries.checkInTicket(2, 7, 'organizer', code), /Database unavailable/);
  assert.equal(failed.state.participant, null); assert.equal(failed.state.tickets[0].checkedInAt, null);
});

test('HTTP check-in authenticates, validates, authorizes and reports duplicate admissions', async (t) => {
  const f = fixture();
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  let actorId = 7;
  f.queries.initialize = async () => {};
  f.queries.findUserById = async () => ({ id: actorId, role: 'organizer', sessionVersion: 1, isEmailConfirmed: true });
  const ftp = { publicPath: () => '/uploads' };
  const app = express(); app.use(express.json());
  new Api({ config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: {}, queries: f.queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const post = (body, authorized = true) => fetch(`http://127.0.0.1:${server.address().port}/api/events/2/tickets/check-in`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ code }, false)).status, 401);
  assert.equal((await post({ code: 'not-a-ticket' })).status, 422);
  actorId = 8;
  assert.equal((await post({ code })).status, 403);
  actorId = 7;
  const accepted = await post({ code: code.toLowerCase(), status: 'No Show' });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).participant.status, 'Attended');
  assert.equal((await (await post({ code })).json()).alreadyCheckedIn, true);
  assert.equal(f.state.writes, 1);
});
