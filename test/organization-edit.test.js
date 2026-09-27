import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { Queries } from '../server/queries.js';

const details = { name: 'Harbor Hall', slug: 'harbor-hall', description: 'Local events', websiteUrl: 'https://harbor.test', phone: '+46123456', contactEmail: 'hello@harbor.test' };

test('organization updates reject nonmembers and staff before any write', async () => {
  for (const membership of [null, { role: 'staff' }]) {
    const queries = new Queries({ execute: async () => { throw new Error('Unexpected write'); } });
    queries.organizationMember = async () => membership;
    assert.equal(await queries.updateOrganization(2, 7, 'customer', details), false);
  }
});

test('organization managers can edit business information without changing ownership', async () => {
  for (const membershipRole of ['owner', 'admin', 'manager']) {
    const calls = [];
    const queries = new Queries({ execute: async (sql, args) => { calls.push({ sql, args }); return [{ affectedRows: 0 }]; } });
    queries.organizationMember = async () => ({ role: membershipRole });
    queries.organization = async () => ({ id: 2, ...details });
    assert.deepEqual(await queries.updateOrganization(2, 7, 'customer', details), { id: 2, ...details });
    assert.deepEqual(calls[0].args, [...Object.values(details), 2]);
    assert.doesNotMatch(calls[0].sql, /owner|member|billing|is_active/);
  }
});

test('organization edit API validates, authorizes, and reports duplicate names', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  const calls = [];
  let allowed = true;
  let verified = true;
  let duplicate = false;
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'customer', sessionVersion: 1, isEmailConfirmed: verified }),
    updateOrganization: async (...args) => {
      calls.push(args);
      if (duplicate) throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' });
      return allowed ? { id: args[0], ...args[3] } : false;
    },
  };
  const app = express(); app.use(express.json());
  const ftp = { publicPath: () => '/uploads' };
  new Api({ config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: {}, queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60_000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const url = `http://127.0.0.1:${server.address().port}/api/organizations/2`;
  const put = (body, authorization = true) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await put(details, false)).status, 401);
  verified = false;
  assert.equal((await put(details)).status, 403);
  assert.equal(calls.length, 0);
  verified = true;
  for (const invalid of [{ name: '' }, { websiteUrl: 'javascript:alert(1)' }, { contactEmail: 'invalid' }, { phone: '1'.repeat(81) }]) assert.equal((await put({ ...details, ...invalid })).status, 422);
  assert.equal(calls.length, 0);
  const saved = await put({ ...details, contactEmail: 'HELLO@harbor.test', ownerUserId: 999, isActive: false });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { id: 2, ...details });
  assert.deepEqual(calls[0], [2, 7, 'customer', details]);
  allowed = false;
  assert.equal((await put(details)).status, 403);
  allowed = true; duplicate = true;
  assert.equal((await put(details)).status, 409);
});
