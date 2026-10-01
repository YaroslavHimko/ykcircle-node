import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { EMAIL_PREFERENCE_DEFAULTS, emailPreferences, updateEmailPreferences, registerEmailPreferenceRoutes } from '../server/email-preferences.js';

test('email preferences keep existing delivery defaults and normalize database booleans', async () => {
  assert.deepEqual(await emailPreferences({ execute: async () => [[]] }, 3), EMAIL_PREFERENCE_DEFAULTS);
  assert.deepEqual(await emailPreferences({ execute: async () => [[{ eventInvitations: 0, groupInvitations: '1', groupEventAnnouncements: 1 }]] }, 3), { eventInvitations: false, groupInvitations: true, groupEventAnnouncements: true });
});

test('partial preference updates only change the chosen category for the authenticated user', async () => {
  const calls = [];
  const database = { execute: async (sql, values) => { calls.push({ sql, values }); return sql.startsWith('SELECT') ? [[{ eventInvitations: 0, groupInvitations: 1, groupEventAnnouncements: 1 }]] : [{}]; } };
  const result = await updateEmailPreferences(database, 42, { eventInvitations: false });
  assert.deepEqual(calls[0].values, [42, false]);
  assert.match(calls[0].sql, /ON DUPLICATE KEY UPDATE event_invitations=VALUES\(event_invitations\)/);
  assert.doesNotMatch(calls[0].sql, /group_invitations/);
  assert.equal(result.eventInvitations, false);
  assert.equal(result.groupInvitations, true);
  for (const changes of [{}, { userId: 99 }, { eventInvitations: 'false' }, [], null, { constructor: false }]) {
    await assert.rejects(() => updateEmailPreferences(database, 42, changes), { status: 400 });
  }
  assert.equal(calls.length, 2);
});

test('preference API requires authentication and rejects invalid updates', async t => {
  const app = express(); app.use(express.json());
  const calls = [];
  registerEmailPreferenceRoutes(app, {
    authenticate: (req, res, next) => { if (!req.headers.authorization) return res.sendStatus(401); req.user = { id: 42 }; next(); },
    ensureTable: async () => {},
    database: { execute: async (sql, values) => { calls.push({ sql, values }); return [[]]; } },
  });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/auth/profile/email-preferences`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  assert.deepEqual(await (await fetch(url, { headers })).json(), EMAIL_PREFERENCE_DEFAULTS);
  assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ eventInvitations: 'false' }) })).status, 400);
  const saved = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ groupInvitations: false }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(calls.find(call => call.sql.startsWith('INSERT')).values, [42, false]);
});
