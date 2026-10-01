import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { Api } from '../server/api.js';

test('personal venues endpoint authenticates and uses the signed-in owner, including staff', async (t) => {
  const secret = 'owned venues test secret with over thirty two characters';
  const user = { id: 7, role: 'admin', sessionVersion: 1 };
  const calls = [];
  const queries = { initialize: async () => {}, findUserById: async () => user,
    venuesForViewer: async (...args) => { calls.push(args); return [{ id: 3, ownerUserId: 7 }]; } };
  const ftp = { publicPath: () => '/uploads/venues' };
  const app = express();
  new Api({ config: { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: {}, queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp }).register(app);
  const server = await new Promise(resolve => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/my/venues?userId=999`;
  assert.equal((await fetch(url)).status, 401);
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.deepEqual(calls, [[7, 'admin', { ownedOnly: true }]]);
});
