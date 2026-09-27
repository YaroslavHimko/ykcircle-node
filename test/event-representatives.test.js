import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';

function fixture() {
  const state = {
    events: [{ id: 2, managerId: 7, title: 'Private event', status: 'Published', startsAt: '2026-12-01 12:00:00', timezone: 'UTC' }, { id: 9, managerId: 10, title: 'Other event', status: 'Published' }],
    users: [{ id: 7, role: 'organizer', email: 'owner@example.test', name: 'Owner', isEmailConfirmed: true }, { id: 8, role: 'customer', email: 'rep@example.test', name: 'Representative', isEmailConfirmed: true }, { id: 10, role: 'organizer', email: 'other@example.test', isEmailConfirmed: true }],
    assignments: [],
  };
  const calls = [];
  const execute = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id, manager_id')) return [state.events.filter((event) => event.id === Number(params[0]) && !event.deleted)];
    if (sql.startsWith('SELECT id, role, isEmailConfirmed')) return [state.users.filter((user) => user.email.toLowerCase() === params[0])];
    if (sql.startsWith('SELECT user_id FROM event_representatives')) return [state.assignments.filter((r) => r.eventId === params[0] && r.userId === params[1])];
    if (sql.startsWith('INSERT INTO event_representatives')) { state.assignments.push({ eventId: params[0], userId: params[1], assignedBy: params[2] }); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('DELETE FROM event_representatives')) { state.assignments = state.assignments.filter((r) => r.eventId !== params[0] || r.userId !== params[1]); return [{ affectedRows: 1 }]; }
    if (sql.startsWith('SELECT r.user_id AS userId')) return [state.assignments.filter((r) => r.eventId === params[0]).map((r) => { const user = state.users.find((u) => u.id === r.userId); return { userId: user.id, name: user.name, email: user.email }; })];
    if (sql.startsWith('SELECT r.user_id FROM event_representatives')) return [state.assignments.filter((r) => r.eventId === params[0] && r.userId === params[1] && state.users.find((u) => u.id === r.userId)?.isEmailConfirmed)];
    if (sql.startsWith('SELECT e.id, e.title, e.starts_at')) return [state.events.filter((event) => !event.deleted && ['Published', 'Completed'].includes(event.status) && state.assignments.some((r) => r.eventId === event.id && r.userId === params[0]) && state.users.find((u) => u.id === params[0])?.isEmailConfirmed).map(({ managerId, ...event }) => event)];
    if (sql.startsWith('UPDATE events SET status')) {
      assert.match(sql, /AND manager_id = \?/);
      const event = state.events.find((event) => event.id === Number(params[1]) && event.managerId === params[2]);
      if (event) event.status = params[0];
      return [{ affectedRows: event ? 1 : 0 }];
    }
    if (sql.startsWith('SELECT id FROM events WHERE') || sql.startsWith('SELECT id, title, starts_at')) {
      assert.match(sql, /AND manager_id\s*=\s*\?/);
      return [state.events.filter((event) => event.id === Number(params[0]) && event.managerId === params[1])];
    }
    if (sql.includes('FROM event_payment_settings s JOIN events')) {
      assert.match(sql, /AND e.manager_id=\?/);
      assert.equal(params[1], 8);
      return [[]];
    }
    if (sql.startsWith('UPDATE event_participants') || sql.startsWith('UPDATE events SET deleted_at') || sql.startsWith('UPDATE events SET title')) {
      assert.match(sql, /AND (e\.)?manager_id\s*=\s*\?/);
      assert.equal(params.at(-1), 8);
      return [{ affectedRows: 0 }];
    }
    throw new Error('Unexpected SQL: ' + sql);
  };
  let queue = Promise.resolve();
  const database = { execute, query: execute, getConnection: async () => {
    let unlock, before;
    return { execute, beginTransaction: async () => { const prior = queue; queue = new Promise((resolve) => { unlock = resolve; }); await prior; before = structuredClone(state); }, commit: async () => {}, rollback: async () => Object.assign(state, before), release: () => unlock() };
  } };
  return { state, calls, queries: new Queries(database) };
}

test('assignments are event-scoped, idempotent and preserve existing account roles', async () => {
  const f = fixture();
  const results = await Promise.all([1, 2].map(() => f.queries.manageEventRepresentatives(2, 7, 'organizer', { action: 'add', email: 'rep@example.test' })));
  assert.equal(results.filter((r) => r.alreadyAssigned).length, 1);
  assert.equal(f.state.assignments.length, 1);
  assert.equal(f.state.assignments[0].assignedBy, 7);
  assert.deepEqual(results[0].representatives[0], { userId: 8, name: 'Representative', email: 'rep@example.test', role: 'representative' });
  assert.equal(f.state.users[1].role, 'customer');
  assert.equal((await f.queries.representativeEvents(8)).length, 1);
  assert.deepEqual(await f.queries.representativeEvents(10), []);
  assert.equal(await f.queries.eventCheckInContext(9, 8, 'customer'), null);
  const context = await f.queries.eventCheckInContext(2, 8, 'customer');
  assert.deepEqual(Object.keys(context).sort(), ['accessRole', 'id', 'startsAt', 'status', 'timezone', 'title']);
  assert.equal(context.accessRole, 'representative');
});

test('representatives and unrelated organizers cannot enumerate, add or remove event representatives', async () => {
  const f = fixture(); f.state.assignments.push({ eventId: 2, userId: 8 });
  for (const [actor, role] of [[8, 'customer'], [10, 'organizer']]) {
    for (const action of ['list', 'add', 'remove']) assert.deepEqual(await f.queries.manageEventRepresentatives(2, actor, role, { action, email: 'other@example.test', userId: 8 }), { error: 'EVENT_NOT_MANAGED' });
  }
  assert.equal(f.state.assignments.length, 1);
  assert.equal(f.calls.every(({ sql }) => sql.startsWith('SELECT id, manager_id')), true);
});

test('revocation removes access immediately and only affects the selected event', async () => {
  const f = fixture(); f.state.assignments.push({ eventId: 2, userId: 8 }, { eventId: 9, userId: 8 });
  await f.queries.manageEventRepresentatives(2, 7, 'organizer', { action: 'remove', userId: 8 });
  assert.equal(await f.queries.eventCheckInContext(2, 8, 'customer'), null);
  assert.deepEqual((await f.queries.representativeEvents(8)).map((e) => e.id), [9]);
  assert.equal((await f.queries.eventCheckInContext(9, 8, 'customer')).accessRole, 'representative');
});

test('missing or unverified accounts and users with full management access cannot be assigned', async () => {
  const f = fixture();
  for (const email of ['missing@example.test', 'rep@example.test']) {
    f.state.users[1].isEmailConfirmed = false;
    assert.deepEqual(await f.queries.manageEventRepresentatives(2, 7, 'organizer', { action: 'add', email }), { error: 'VERIFIED_ACCOUNT_REQUIRED' });
  }
  assert.deepEqual(await f.queries.manageEventRepresentatives(2, 7, 'organizer', { action: 'add', email: 'owner@example.test' }), { error: 'ALREADY_MANAGER' });
  assert.equal(f.state.assignments.length, 0);
});

test('unpublished, deleted and unverified assignments expose no event check-in data', async () => {
  const f = fixture(); f.state.assignments.push({ eventId: 2, userId: 8 });
  for (const status of ['Draft', 'Cancelled', 'Archived']) {
    f.state.events[0].status = status;
    assert.equal(await f.queries.eventCheckInContext(2, 8, 'customer'), null);
    assert.deepEqual(await f.queries.representativeEvents(8), []);
  }
  f.state.events[0].status = 'Published'; f.state.events[0].deleted = true;
  assert.equal(await f.queries.eventCheckInContext(2, 8, 'customer'), null);
  f.state.events[0].deleted = false; f.state.users[1].isEmailConfirmed = false;
  assert.equal(await f.queries.eventCheckInContext(2, 8, 'customer'), null);
});

test('representative assignments never broaden event, participant, billing or venue permissions', async () => {
  const f = fixture(); f.state.assignments.push({ eventId: 2, userId: 8 });
  assert.equal(await f.queries.updateEventStatus(2, 8, 'Cancelled', 'customer'), false);
  assert.equal(await f.queries.updateRichEvent(2, 8, 'customer', {}), false);
  assert.equal(await f.queries.softDeleteEvent(2, 8, 'customer'), false);
  assert.equal(await f.queries.updateParticipantStatus(30, 8, 'No Show'), false);
  assert.deepEqual(await f.queries.saveEventPaymentSettings(2, 8, 'customer', {}), { error: 'EVENT_NOT_FOUND' });
  assert.equal(await f.queries.eventPaymentSettings(2, 8, 'customer'), null);
  assert.equal(await f.queries.eventForVenueInquiry(2, 8, 'customer'), null);
  assert.equal(f.state.events[0].status, 'Published');
});

test('HTTP assignment, discovery, restricted workspace and removal enforce authenticated ownership', async (t) => {
  const f = fixture();
  const secret = 'event-representative-test-secret-over-thirty-two-characters';
  f.queries.initialize = async () => {};
  f.queries.findUserById = async (id) => ({ ...f.state.users.find((u) => u.id === id), sessionVersion: 1 });
  const ftp = { publicPath: () => '/uploads' };
  const app = express(); app.use(express.json());
  new Api({ config: { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, queries: f.queries, database: {}, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (path, actor, method = 'GET', body) => {
    const payload = Buffer.from(JSON.stringify({ id: actor, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
    return fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  assert.equal((await request('/events/2/representatives', null)).status, 401);
  assert.equal((await request('/events/2/representatives', 7, 'POST', { email: 'invalid' })).status, 422);
  assert.equal((await request('/events/2/representatives', 7, 'POST', { email: ' REP@EXAMPLE.TEST ', role: 'admin' })).status, 201);
  assert.equal((await request('/events/2/representatives', 7, 'POST', { email: 'rep@example.test' })).status, 200);
  const events = await (await request('/me/representative-events', 8)).json(); assert.equal(events[0].id, 2);
  assert.equal((await request('/events/2/check-in', 8)).status, 200);
  assert.equal((await request('/events/9/check-in', 8)).status, 403);
  assert.equal((await request('/events/2/representatives', 8)).status, 403);
  assert.equal((await request('/events/2/representatives', 8, 'POST', { email: 'other@example.test' })).status, 403);
  assert.equal((await request('/events/2/representatives/8', 8, 'DELETE')).status, 403);
  assert.equal((await request('/events/2/payment-settings', 8, 'PUT', {})).status, 404);
  assert.equal((await request('/events/2/status', 8, 'PATCH', { status: 'Cancelled' })).status, 404);
  assert.equal((await request('/events/2/representatives/8', 7, 'DELETE')).status, 200);
  assert.equal((await request('/events/2/check-in', 8)).status, 403);
  assert.deepEqual(await (await request('/me/representative-events', 8)).json(), []);
});
