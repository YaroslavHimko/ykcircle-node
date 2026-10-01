import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Database } from '../server/database.js';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';

const retired = ['capacity', 'minimum_attendees', 'language_code', 'registration_deadline', 'minimum_age', 'what_to_bring', 'meeting_instructions'];
const retiredFields = ['capacity', 'minimumAttendees', 'languageCode', 'registrationDeadline', 'minimumAge', 'whatToBring', 'meetingInstructions'];

test('event field migration handles existing, fresh and partially migrated schemas idempotently', async () => {
  for (const columns of [retired, [], retired.slice(2)]) {
    const existing = new Set(['title', 'starts_at', ...columns]);
    const alterations = [];
    const database = Object.create(Database.prototype);
    database.pool = { execute: async (sql) => {
      if (sql.startsWith('SELECT')) return [[...existing].map(name => ({ name }))];
      alterations.push(sql);
      for (const clause of sql.replace('ALTER TABLE events ', '').split(', ')) {
        assert.match(clause, /^DROP COLUMN /);
        assert.equal(existing.delete(clause.replace('DROP COLUMN ', '')), true);
      }
      return [{}];
    } };
    await database.removeRetiredEventFields();
    await database.removeRetiredEventFields();
    assert.deepEqual([...existing], ['title', 'starts_at']);
    assert.equal(alterations.length, columns.length ? 1 : 0);
  }
});

test('event insert and update preserve field alignment after removing optional fields', async () => {
  const calls = [];
  const executor = { execute: async () => [[]], query: async (sql, values) => {
    calls.push({ sql, values });
    return [{ insertId: 5, affectedRows: 1 }];
  } };
  const queries = new Queries(executor);
  const data = { managerId: 7, title: 'A gathering', foodOptions: ['Vegetarian', 'Vegan'], timezone: 'Europe/Stockholm', cancellationPolicy: 'Contact host', fee: 25, currency: 'SEK', customFormattedAddress: 'Stockholm', onlinePlatform: 'Video' };
  await queries.insertRichEvent(executor, data, 1);
  await queries.updateRichEvent(5, 7, 'organizer', data);
  const columns = calls[0].sql.match(/INSERT INTO events\s*\(([^)]+)\)/)[1].split(',').map(value => value.trim());
  const stored = Object.fromEntries(columns.map((column, index) => [column, calls[0].values[index]]));
  assert.equal(stored.timezone, data.timezone);
  assert.equal(stored.cancellation_policy, data.cancellationPolicy);
  assert.equal(stored.participation_fee, 25);
  assert.equal(stored.food_options, JSON.stringify(data.foodOptions));
  assert.match(calls[1].sql, /food_options=COALESCE\(\?,food_options\)/);
  assert.equal(calls[1].values[5], JSON.stringify(data.foodOptions));
  assert.equal(stored.custom_formatted_address, 'Stockholm');
  assert.equal(stored.online_platform, 'Video');
  for (const call of calls) {
    assert.equal((call.sql.match(/\?/g) || []).length, call.values.length);
    for (const field of retired) assert.doesNotMatch(call.sql, new RegExp(`\\b${field}\\b`));
  }
  assert.deepEqual(calls[1].values.slice(-2), [5, 7]);
});

test('draft create and update ignore retired fields and omit them from the API contract', async (t) => {
  const secret = 'event-field-contract-test-secret-at-least-thirty-two-characters';
  const writes = [];
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'organizer', sessionVersion: 1, isEmailConfirmed: true }),
    createRichEventSeries: async (data) => { writes.push(data); return { eventIds: [5], seriesId: null }; },
    updateRichEventAndBooking: async (_id, _userId, _role, data) => { writes.push(data); return true; },
    richEvent: async () => ({ ...writes.at(-1), id: 5, status: 'Draft' }),
  };
  const ftp = { publicPath: () => '/uploads/test' };
  const app = express();
  app.use(express.json());
  new Api({ config: { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret } }, database: {}, queries, emailService: {},
    ftpService: ftp, eventFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp, venueFtpService: ftp }).register(app);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const body = { title: 'A gathering', foodOptions: [' Vegetarian ', 'Vegan'], startsAtUtc: '2099-01-01T12:00:00Z', timezone: 'UTC', customFormattedAddress: 'Stockholm, Sweden', customLatitude: 59.3293, customLongitude: 18.0686, ...Object.fromEntries(retiredFields.map(field => [field, 'retired-value'])) };
  for (const [method, route] of [['POST', '/api/events/drafts'], ['PATCH', '/api/events/5']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, method === 'POST' ? 201 : 200, JSON.stringify(result));
    assert.equal(result.title, body.title);
    assert.deepEqual(result.foodOptions, ['Vegetarian', 'Vegan']);
    for (const field of retiredFields) {
      assert.equal(Object.hasOwn(writes.at(-1), field), false, field);
      assert.equal(Object.hasOwn(result, field), false, field);
    }
  }
  for (const foodOptions of ['Vegetarian', Array(13).fill('Meal'), [''], ['a'.repeat(101)]]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/events/drafts`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, foodOptions }) });
    assert.equal(response.status, 422);
    assert.ok((await response.json()).fields.foodOptions);
  }
});

test('event detail turns stored JSON food options into an attendee-facing list', () => {
  const queries = new Queries({ execute: async () => [[]] });
  assert.deepEqual(queries.normalizeRichEventLocation({ locationType: 'online', foodOptions: '["Vegetarian","Vegan"]' }).foodOptions, ['Vegetarian', 'Vegan']);
  assert.deepEqual(queries.normalizeRichEventLocation({ locationType: 'online', foodOptions: null }).foodOptions, []);
});
