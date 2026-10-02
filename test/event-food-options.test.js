import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import express from 'express';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';

const offered = ['Vegetarian', 'Vegan', 'Gluten-free'];
const setup = (existing = null) => {
  const writes = [];
  const queries = new Queries({ execute: async (sql, params) => {
    if (sql.startsWith('SELECT e.id')) return [[{ id: 42, eventId: 42, status: 'Published', foodOptions: JSON.stringify(offered) }]];
    writes.push({ sql, params });
    return [{ insertId: 9, affectedRows: 1 }];
  } });
  queries.existingEventRegistration = async () => existing;
  return { queries, writes };
};

test('registration persists selected food choices and accepts an empty optional choice', async () => {
  for (const selection of [[], ['Vegetarian'], ['Vegan', 'Gluten-free', 'Vegan']]) {
    const { queries, writes } = setup();
    const result = await queries.registerForEvent(42, 7, 'GUEST@example.test', selection);
    assert.equal(result.id, 9);
    assert.equal(result.eventId, 42);
    assert.deepEqual(JSON.parse(writes[0].params[3]), [...new Set(selection)]);
    assert.match(writes[0].sql, /selected_food_options/);
    assert.equal(writes[0].params[2], 'guest@example.test');
  }
});

test('registration rejects unknown or malformed choices before any write', async () => {
  for (const selection of [null, 'Vegan', ['Not offered'], [7], Array(13).fill('Vegan')]) {
    const { queries, writes } = setup();
    assert.deepEqual(await queries.registerForEvent(42, 7, 'guest@example.test', selection), { error: 'INVALID_FOOD_OPTIONS' });
    assert.equal(writes.length, 0);
  }
});

test('registering again replaces food choices on a withdrawn registration', async () => {
  const { queries, writes } = setup({ id: 9, source: 'registration', status: 'Withdrawn' });
  await queries.registerForEvent(42, 7, 'guest@example.test', []);
  assert.match(writes[0].sql, /UPDATE event_registrations.*selected_food_options = \?/);
  assert.equal(writes[0].params[2], '[]');
});

test('organizer confirmation preserves food choices when moving a registration to participants', async () => {
  const writes = [];
  const queries = new Queries({ execute: async (sql, params) => {
    assert.equal((sql.match(/\?/g) || []).length, params.length);
    if (sql.startsWith('SELECT')) return [[{ eventId: 42, userId: 7, name: 'Guest', email: 'guest@example.test', phone: null, paymentStatus: 'Not Required', selectedFoodOptions: '["Vegan","Gluten-free"]' }]];
    writes.push({ sql, params }); return [{ affectedRows: 1 }];
  } });
  assert.equal(await queries.updateRegistrationStatus(9, 3, 'Confirmed'), true);
  const participant = writes.find(write => write.sql.startsWith('INSERT INTO event_participants'));
  assert.match(participant.sql, /selected_food_options = VALUES\(selected_food_options\)/);
  assert.deepEqual(JSON.parse(participant.params[6]), ['Vegan', 'Gluten-free']);
  assert.ok(writes.at(-1).sql.startsWith('DELETE FROM event_registrations'));
});

test('food choices are normalized for organizers and excluded from public participants', async () => {
  const calls = [];
  const queries = new Queries({ execute: async (sql) => {
    calls.push(sql);
    return sql.startsWith('SELECT') ? [[{ id: 1, ...(sql.includes('selected_food_options') ? { selectedFoodOptions: '["Vegan"]' } : {}) }]] : [{}];
  } });
  assert.deepEqual((await queries.eventParticipants(42, true))[0].selectedFoodOptions, ['Vegan']);
  assert.deepEqual((await queries.registrations(42, 3))[0].selectedFoodOptions, ['Vegan']);
  assert.equal('selectedFoodOptions' in (await queries.eventParticipants(42, false))[0], false);
  assert.equal('selectedFoodOptions' in (await queries.publicEventParticipants(42))[0], false);
  assert.doesNotMatch(calls.at(-1), /selected_food_options/);
});

test('registration API passes selected choices to storage and returns actionable validation errors', async t => {
  const secret = 'random-food-test-secret-at-least-thirty-two-characters';
  const selections = [];
  const user = { id: 7, role: 'customer', email: 'guest@example.test', name: 'Guest', isEmailConfirmed: true, sessionVersion: 1 };
  const app = express(); app.use(express.json()); const ftp = { publicPath: () => '/uploads/test' };
  new Api({ config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret } }, database: {}, queries: {
    initialize: async () => {}, findUserById: async () => user, eventVisibility: async () => 'Public', canAcceptPaidRegistrations: async () => true, profile: async () => user,
    registerForEvent: async (_event, _user, _email, choice) => { selections.push(choice); return choice?.includes('Invalid') ? { error: 'INVALID_FOOD_OPTIONS' } : { id: 9, eventId: 42 }; },
  }, emailService: { sendRegistrationConfirmation: async () => {}, sendManagerRegistrationNotification: async () => {} }, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp }).register(app);
  const listener = await new Promise(resolve => { const server = app.listen(0, () => resolve(server)); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  for (const [choices, status] of [[['Vegan'], 201], [['Invalid'], 422]]) {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/events/42/registrations`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ selectedFoodOptions: choices }) });
    assert.equal(response.status, status, await response.text()); assert.deepEqual(selections.at(-1), choices);
  }
});
