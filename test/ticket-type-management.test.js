import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { Queries } from '../server/queries.js';

const tickets = [
  { id: 1, name: 'General admission', price: '250.00', currency: 'SEK', quantityAvailable: 10, quantitySold: 2, quantityReserved: 1, isActive: 1 },
  { id: 2, name: 'Early bird', price: '150.00', currency: 'SEK', salesEndAt: '2020-01-01', isActive: 0 },
];

function fixture() {
  const calls = [];
  const queries = new Queries({ execute: async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.startsWith('SELECT id FROM events')) return [parameters[0] === 12 && (parameters.length === 1 || parameters[1] === 7) ? [{ id: 12 }] : []];
    if (sql.includes('FROM event_ticket_types')) return [tickets];
    throw new Error(`Unexpected query: ${sql}`);
  } });
  return { queries, calls };
}

test('owners see all ticket types even when inactive or outside the sales window', async () => {
  const { queries, calls } = fixture();
  const result = await queries.managedTicketTypes(12, 7, 'customer');
  assert.deepEqual(result.map(({ name }) => name), ['General admission', 'Early bird']);
  assert.equal(result[1].isActive, false);
  assert.deepEqual(calls[0].parameters, [12, 7]);
  assert.match(calls[0].sql, /deleted_at IS NULL/);
  assert.doesNotMatch(calls[1].sql, /AND is_active=TRUE|sales_start_at<=NOW\(\)|sales_end_at>=NOW\(\)/);
});

test('unrelated organizers and event representatives cannot load management ticket types', async () => {
  for (const role of ['customer', 'organizer', 'venue_owner']) {
    const { queries, calls } = fixture();
    assert.equal(await queries.managedTicketTypes(12, 8, role), null);
    assert.equal(calls.length, 1);
  }
});

test('site managers and admins retain access to event ticket management', async () => {
  for (const role of ['manager', 'admin']) {
    const { queries, calls } = fixture();
    assert.equal((await queries.managedTicketTypes(12, 8, role)).length, 2);
    assert.deepEqual(calls[0].parameters, [12]);
  }
});

test('the management endpoint requires authentication and ownership, independent of public checkout', async (t) => {
  const secret = 'a sufficiently random test secret that exceeds thirty two characters';
  const { queries } = fixture();
  queries.initialize = async () => {};
  queries.findUserById = async (id) => ({ id, role: 'organizer', sessionVersion: 1, isEmailConfirmed: true });
  queries.ticketCheckoutContext = async () => null;
  const ftp = { publicPath: () => '/uploads/test' };
  const app = express();
  app.use(express.json());
  new Api({
    config: { site: { brandName: 'Yk Circle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } },
    database: {}, queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp,
  }).register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/events/12/ticket-types`;
  const headers = (id) => {
    const payload = Buffer.from(JSON.stringify({ id, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
    return { Authorization: `Bearer ${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}` };
  };
  assert.equal((await fetch(`${url}/manage`)).status, 401);
  assert.equal((await fetch(`${url}/manage`, { headers: headers(8) })).status, 404);
  const response = await fetch(`${url}/manage`, { headers: headers(7) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, 2);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url.replace('/12/', '/invalid/') + '/manage', { headers: headers(7) })).status, 422);
});
