import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';

test('Manage events scopes every role to owned, undeleted events and preserves category filtering', async () => {
  for (const role of ['customer', 'organizer', 'venue_owner', 'manager', 'admin']) {
    const queries = new Queries({ execute: async (sql, params) => {
      const where = sql.slice(sql.indexOf('WHERE e.deleted_at'));
      assert.match(where, /e.deleted_at IS NULL AND \(e.manager_id = \?\) AND c.slug = \?/);
      assert.doesNotMatch(where, /visibility = 'Public'|\bOR\b/);
      assert.deepEqual(params, [7, 7, 'music']);
      return [[{ id: 3, managerId: 7 }]];
    } });
    assert.deepEqual(await queries.eventsForViewer(7, role, { managedOnly: true, categorySlug: 'music' }), [{ id: 3, managerId: 7 }]);
  }
});

test('the personal events API requires login and requests an ownership-filtered feed', async (t) => {
  const secret = 'managed events test secret with over thirty two characters';
  const user = { id: 7, role: 'admin', sessionVersion: 1 };
  const calls = [];
  const queries = { initialize: async () => {}, findUserById: async () => user,
    eventsForViewer: async (...args) => { calls.push(args); return [{ id: 3, managerId: 7 }]; } };
  const ftp = { publicPath: () => '/uploads/events' };
  const app = express();
  new Api({ config: { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: {}, queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp }).register(app);
  const server = await new Promise(resolve => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/my/events?category=music&userId=999`;
  assert.equal((await fetch(url)).status, 401);
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.deepEqual(calls, [[7, 'admin', { managedOnly: true, categorySlug: 'music' }]]);
});
