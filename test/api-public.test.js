import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { EMAIL_UNSUBSCRIBE_REASONS } from '../server/email-unsubscribe-reasons.js';

const ftp = (path) => ({ publicPath: () => path });

test('serves public API resources and validates unsubscribe requests', async (t) => {
  const preferenceCalls = [];
  const queries = {
    initialize: async () => {},
    setMarketingEmailPreference: async (...args) => preferenceCalls.push(args),
  };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: 'a sufficiently random test secret that exceeds thirty two characters' } },
    database: {}, queries, emailService: {}, ftpService: ftp('/uploads/profiles'), eventFtpService: ftp('/uploads/events'), groupFtpService: ftp('/uploads/groups'), articleFtpService: ftp('/uploads/articles'),
  }).register(app);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const statuses = await fetch(`${baseUrl}/api/event-statuses`);
  assert.deepEqual(await statuses.json(), ['Draft', 'Published', 'Cancelled', 'Completed', 'Archived']);

  const reasons = await fetch(`${baseUrl}/api/email/unsubscribe-reasons`);
  assert.deepEqual(await reasons.json(), EMAIL_UNSUBSCRIBE_REASONS);

  const legal = await fetch(`${baseUrl}/api/legal-documents/privacy`);
  const document = await legal.json();
  assert.equal(legal.status, 200);
  assert.equal(document.slug, 'privacy');
  assert.match(document.contentHash, /^[a-f0-9]{64}$/);

  const invalid = await fetch(`${baseUrl}/api/email/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'invalid', reason: 'Unknown' }) });
  assert.equal(invalid.status, 400);
  assert.equal(preferenceCalls.length, 0);
});
