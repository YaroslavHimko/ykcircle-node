import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { OrganizerSubscriptions, registerSubscriptionRoutes } from '../server/organizer-subscriptions.js';

async function fixture(t) {
  const state = { grants: [], audits: [], committed: false, rolledBack: false, lookup: null };
  const connection = {
    beginTransaction: async () => {},
    commit: async () => { state.committed = true; },
    rollback: async () => { state.rolledBack = true; },
    release: () => {},
    execute: async (sql, params) => {
      if (sql.startsWith('SELECT id FROM users')) {
        state.lookup = { sql, params };
        return [params[0] === 'customer@example.test' ? [{ id: 42 }] : []];
      }
      if (sql.startsWith('INSERT INTO platform_entitlements')) { state.grants.push(params); return [{ insertId: 7 }]; }
      if (sql.startsWith('INSERT INTO audit_log')) { state.audits.push(params); return [{}]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const service = new OrganizerSubscriptions({ queries: { database: { getConnection: async () => connection } }, siteUrl: 'https://example.test' });
  const app = express();
  app.use(express.json());
  registerSubscriptionRoutes(app, {
    service, initialize: async () => {}, requireVerifiedUser: (_req, _res, next) => next(),
    authenticate: (req, _res, next) => { req.user = { id: 9, role: req.headers['x-test-role'] || 'admin' }; next(); },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (recipient, role = 'admin') => fetch(`http://127.0.0.1:${server.address().port}/api/admin/subscriptions/grants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    body: JSON.stringify({ source: 'admin', endsAt: new Date(Date.now() + 86400000).toISOString(), reason: 'Early access', ...recipient }),
  });
  return { state, post };
}

test('staff can grant publishing access by normalized email to the matching account', async t => {
  const { state, post } = await fixture(t);
  const response = await post({ email: '  Customer@Example.Test  ' }, 'manager');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 7 });
  assert.deepEqual(state.lookup.params, ['customer@example.test']);
  assert.match(state.lookup.sql, /deleted_at IS NULL/);
  assert.deepEqual(state.grants[0].slice(0, 4), [42, null, 'organizer.publish_event', 'admin']);
  assert.equal(state.audits[0][0], 9);
  assert.deepEqual(JSON.parse(state.audits[0][4]).owner, { type: 'user', id: 42 });
  assert.equal(state.committed, true);
});

test('unknown email does not grant access or create an account', async t => {
  const { state, post } = await fixture(t);
  const response = await post({ email: 'missing@example.test' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'USER_NOT_FOUND');
  assert.equal(state.grants.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.rolledBack, true);
});

test('invalid, missing, or ambiguous recipients cannot default to the administrator', async t => {
  const { state, post } = await fixture(t);
  for (const recipient of [{}, { email: '' }, { email: 'invalid' }, { email: null }, { email: 42 }, { email: 'customer@example.test', owner: { type: 'user', id: 9 } }]) {
    const response = await post(recipient);
    assert.equal(response.status, 422, JSON.stringify(recipient));
  }
  assert.equal(state.grants.length, 0);
  assert.equal(state.lookup, null);
});

test('organization grants and existing explicit account grants remain supported', async t => {
  const { state, post } = await fixture(t);
  assert.equal((await post({ owner: { type: 'organization', id: 5 } })).status, 200);
  assert.equal((await post({ owner: { type: 'user', id: 42 } })).status, 200);
  assert.deepEqual(state.grants.map(params => params.slice(0, 2)), [[null, 5], [42, null]]);
});

test('customers cannot grant publishing access by email', async t => {
  const { state, post } = await fixture(t);
  assert.equal((await post({ email: 'customer@example.test' }, 'customer')).status, 403);
  assert.equal(state.grants.length, 0);
  assert.equal(state.lookup, null);
});
