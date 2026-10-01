import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { TicketSales } from '../server/ticket-sales.js';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';
import { EmailService } from '../server/email-service.js';

function fixture() {
  const order = { id: 1, event_id: 2, attendee_user_id: 3, attendee_email: 'buyer@example.test', payment_status: 'pending',
    currency: 'SEK', total_amount: '250.00', checkout_session_id: 'cs_test_one', providerAccountId: 'acct_seller' };
  const state = { order, tickets: [], sold: 0, registrations: 0, job: false, sent: false, attempts: 0, retry: false, locked: false };
  let transactionQueue = Promise.resolve();
  const execute = async (sql, params = []) => {
    if (sql.includes('FROM product_configuration')) return [[{ settings: { paidEventsEnabled: true } }]];
    if (sql.includes('SELECT o.*')) return [[{ ...state.order }]];
    if (sql.includes('SELECT o.id, o.event_id')) return [[{ id: 1, eventId: 2, attendeeUserId: 3, checkoutSessionId: order.checkout_session_id, providerAccountId: order.providerAccountId }]];
    if (sql.includes("SET payment_status='paid'")) { state.order.payment_status = 'paid'; return [{ affectedRows: 1 }]; }
    if (sql.includes("SET payment_status='cancelled'")) { state.order.payment_status = 'cancelled'; return [{ affectedRows: 1 }]; }
    if (sql.includes('SELECT id, ticket_type_id')) return [[{ id: 9, ticketTypeId: 4, quantity: 2 }]];
    if (sql.includes('UPDATE event_ticket_types')) { state.sold += params[0]; return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT INTO issued_tickets')) { state.tickets.push({ id: state.tickets.length + 1, code: params[3], ticketType: { name: 'Admission' } }); return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT INTO event_registrations')) { state.registrations++; return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT IGNORE INTO ticket_email_deliveries')) { state.job = true; return [{ affectedRows: 1 }]; }
    if (sql.includes('SELECT t.id,t.code')) return [state.tickets];
    if (sql.includes('SELECT e.starts_at')) return [[{ startsAt: '2026-12-14T16:00:00Z', timezone: 'Europe/Stockholm', location: 'Event hall' }]];
    if (sql.includes('SELECT sent_at AS sentAt')) return [[{ sentAt: state.sent ? new Date() : null }]];
    if (sql.includes('SET locked_until=DATE_ADD')) {
      if (!state.job || state.sent || state.retry || state.locked) return [{ affectedRows: 0 }];
      state.locked = true; state.attempts++; return [{ affectedRows: 1 }];
    }
    if (sql.includes('SET sent_at=NOW()')) { state.sent = true; state.locked = false; return [{ affectedRows: 1 }]; }
    if (sql.includes('last_error=?')) { state.retry = true; state.locked = false; return [{ affectedRows: 1 }]; }
    throw new Error('Unhandled fixture SQL: ' + sql);
  };
  const database = { execute, getConnection: async () => {
    let unlock; let before;
    return { execute, beginTransaction: async () => {
      const previous = transactionQueue;
      transactionQueue = new Promise((resolve) => { unlock = resolve; });
      await previous;
      before = structuredClone(state);
    }, commit: async () => {}, rollback: async () => { if (before) Object.assign(state, before); }, release: () => unlock?.() };
  } };
  const queries = { database, initialize: async () => {}, ticketOrder: async () => ({ id: 1, eventId: 2, attendeeUserId: 3, attendeeEmail: order.attendee_email,
    eventTitle: 'Winter gathering', orderNumber: 'TKT-TEST', totalAmount: 250, currency: 'SEK', testMode: true, paymentStatus: state.order.payment_status,
    seller: { legalName: 'Event organizer' }, items: [{ id: 9, ticketType: { name: 'Admission' }, quantity: 2, unitPrice: 125 }] }) };
  const emails = [];
  const emailService = { sendTickets: async (order) => { emails.push(order); } };
  const session = { id: 'cs_test_one', metadata: { ticketOrderId: '1' }, client_reference_id: '1', currency: 'sek', amount_total: 25000,
    livemode: false, mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: 'pi_test_one' };
  const stripe = { configured: () => true, testMode: () => true, checkoutSession: async (_id, account) => { assert.equal(account, 'acct_seller'); return session; } };
  const sales = new TicketSales({ queries, stripe, emailService, siteUrl: 'https://ykcircle.test' });
  return { state, queries, sales, stripe, session, emails, emailService };
}

test('concurrent webhook and return-page fulfillment issue one ticket per admission and email once', async () => {
  const f = fixture();
  await Promise.all([f.sales.confirm(1), f.sales.confirm(1), f.sales.confirm(1)]);
  assert.equal(f.state.order.payment_status, 'paid');
  assert.equal(f.state.sold, 2);
  assert.equal(f.state.tickets.length, 2);
  assert.notEqual(f.state.tickets[0].code, f.state.tickets[1].code);
  assert.match(f.state.tickets[0].code, /^YK-[A-F0-9]{32}$/);
  assert.equal(f.state.registrations, 1);
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].attendeeEmail, 'buyer@example.test');
  assert.equal(f.state.sent, true);
});

test('ticket details distinguish checked-in tickets from remaining admissions', async () => {
  const f = fixture();
  await f.sales.confirm(1);
  f.state.tickets[0].checkedInAt = '2026-12-14T16:00:00Z';
  const details = await f.sales.details(await f.queries.ticketOrder(1));
  assert.equal(details.tickets[0].valid, false);
  assert.equal(details.tickets[0].checkedInAt, '2026-12-14T16:00:00Z');
  assert.equal(details.tickets[1].valid, true);
  assert.equal(details.tickets[1].checkedInAt, null);
});

test('unpaid/declined checkout issues no tickets; verified expiry releases its hold', async () => {
  const f = fixture();
  f.session.status = 'open'; f.session.payment_status = 'unpaid';
  await f.sales.confirm(1);
  assert.equal(f.state.order.payment_status, 'pending');
  assert.equal(f.state.tickets.length, 0); assert.equal(f.emails.length, 0);
  f.session.status = 'expired';
  await f.sales.confirm(1);
  assert.equal(f.state.order.payment_status, 'cancelled');
  assert.equal(f.state.sold, 0);
});

test('rejects wrong account, amount, currency, environment and Checkout references', async () => {
  for (const change of [{ amount_total: 1 }, { currency: 'usd' }, { livemode: true }, { metadata: { ticketOrderId: '2' } }, { client_reference_id: '2' }, { id: 'cs_other' }]) {
    const f = fixture(); Object.assign(f.session, change);
    await assert.rejects(f.sales.confirm(1), /does not match/);
    assert.equal(f.state.tickets.length, 0); assert.equal(f.state.order.payment_status, 'pending');
  }
  const f = fixture();
  await assert.rejects(f.sales.confirm(1, 'cs_test_one', 'acct_attacker'), /account mismatch/);
});

test('SMTP failure leaves paid tickets intact and retries the same codes', async () => {
  const f = fixture();
  f.emailService.sendTickets = async () => { throw new Error('SMTP unavailable'); };
  await f.sales.confirm(1);
  const codes = f.state.tickets.map((ticket) => ticket.code);
  assert.equal(f.state.order.payment_status, 'paid'); assert.equal(f.state.retry, true); assert.equal(f.state.sent, false);
  f.state.retry = false;
  f.emailService.sendTickets = async (order) => f.emails.push(order);
  await f.sales.confirm(1);
  assert.deepEqual(f.state.tickets.map((ticket) => ticket.code), codes);
  assert.equal(f.state.sent, true); assert.equal(f.state.attempts, 2); assert.equal(f.emails.length, 1);
});

test('pending reservations prevent another buyer from overselling the last tickets', async () => {
  let rolledBack = false;
  const database = { execute: async (sql) => {
    if (sql.startsWith('SELECT id, starts_at')) return [[{ id: 2, startsAt: '2099-01-01 12:00:00' }]];
    if (sql.includes('FROM event_ticket_types')) return [[{ id: 4, name: 'Last tickets', currency: 'SEK', price: 125, quantityAvailable: 3, quantitySold: 1 }]];
    if (sql.includes('GROUP BY item.ticket_type_id')) return [[{ ticketTypeId: 4, quantity: 2 }]];
    throw new Error('Unexpected query ' + sql);
  }, getConnection: async () => ({ execute: database.execute, beginTransaction: async () => {}, rollback: async () => { rolledBack = true; }, release() {} }) };
  const queries = new Queries(database);
  queries.ticketCheckoutContext = async () => ({ currency: 'SEK' });
  assert.deepEqual(await queries.createTicketOrder(2, { userId: 3, email: 'buyer@example.test' }, [{ ticketTypeId: 4, quantity: 1 }]), { error: 'TICKETS_UNAVAILABLE' });
  assert.equal(rolledBack, true);
});

test('HTTP checkout, signed webhook, and buyer order return complete the purchase flow', async (t) => {
  const f = fixture();
  const authSecret = 'test-session-secret-that-is-more-than-thirty-two-characters';
  const config = { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret, stripe: { secretKey: 'sk_test_example', webhookSecret: 'whsec_test' } } };
  f.queries.findUserById = async (id) => ({ id, sessionVersion: 1, email: 'buyer@example.test', role: 'customer', isEmailConfirmed: true });
  f.queries.ticketCheckoutContext = async () => ({ title: 'Winter gathering', currency: 'SEK', provider: 'stripe', providerAccountId: 'acct_seller', seller: { legalName: 'Organizer' } });
  f.queries.createTicketOrder = async () => f.queries.ticketOrder(1);
  f.queries.updatePaymentAccountCapabilities = async () => {};
  const ftp = { publicPath: () => '/uploads/test' };
  const api = new Api({ config, queries: f.queries, database: f.queries.database, emailService: f.emailService,
    ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp });
  api.ticketSales = f.sales;
  api.stripe.account = async () => ({ charges_enabled: true });
  api.stripe.checkoutSession = async () => ({ ...f.session, status: 'open', url: 'https://checkout.stripe.test/example' });
  f.sales.attachCheckout = async () => {};
  const app = express();
  app.post('/api/payment-webhooks/stripe', express.raw({ type: 'application/json' }));
  api.registerPaymentWebhooks(app); app.use(express.json()); api.register(app);
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (id) => { const body = Buffer.from(JSON.stringify({ id, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url'); return body + '.' + crypto.createHmac('sha256', authSecret).update(body).digest('base64url'); };
  const headers = { Authorization: 'Bearer ' + token(3), 'Content-Type': 'application/json' };
  const checkout = await fetch(base + '/api/events/2/ticket-checkout', { method: 'POST', headers, body: JSON.stringify({ items: [{ ticketTypeId: 4, quantity: 2 }], checkoutKey: crypto.randomUUID() }) });
  assert.equal(checkout.status, 201); assert.match((await checkout.json()).checkoutUrl, /checkout.stripe/);
  const denied = await fetch(base + '/api/ticket-orders/1/confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + token(99) } });
  assert.equal(denied.status, 404);
  const webhook = JSON.stringify({ id: 'evt_test_one', account: 'acct_seller', type: 'checkout.session.completed', data: { object: f.session } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', 'whsec_test').update(`${timestamp}.${webhook}`).digest('hex');
  const invalid = await fetch(base + '/api/payment-webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'invalid' }, body: webhook });
  assert.equal(invalid.status, 400); assert.equal(f.emails.length, 0);
  for (let i = 0; i < 2; i++) {
    const result = await fetch(base + '/api/payment-webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${timestamp},v1=${signature}` }, body: webhook });
    assert.equal(result.status, 200);
  }
  const response = await fetch(base + '/api/ticket-orders/1', { headers });
  const detail = await response.json();
  assert.equal(detail.paymentStatus, 'paid'); assert.equal(detail.tickets.length, 2); assert.equal(detail.emailStatus, 'sent');
  assert.equal(f.emails.length, 1);
});

test('ticket email contains escaped admission codes, test label and offline attachment', async () => {
  const service = new EmailService({ smtp: { host: 'smtp.test', verification: {}, notification: {}, invitation: {} }, domain: 'ykcircle.test', noReplyFrom: 'no-reply@ykcircle.test' });
  let message;
  service.mailer = { sendMail: async (data) => { message = data; return { accepted: [data.to], rejected: [] }; } };
  await service.sendTickets({ id: 1, attendeeEmail: 'buyer@example.test', eventTitle: '<script>test</script>', orderNumber: 'TKT-TEST', testMode: true,
    event: { startsAt: '2026-12-14T16:00:00Z', timezone: 'Europe/Stockholm' }, totalAmount: 125, currency: 'SEK', tickets: [{ name: 'Admission', code: 'YK-123' }] }, 'https://ykcircle.test/tickets/1');
  assert.equal(message.to, 'buyer@example.test'); assert.match(message.subject, /^\[TEST\]/);
  assert.doesNotMatch(message.html, /<script>/); assert.match(message.html, /YK-123/);
  assert.match(message.attachments[0].content, /Show these ticket codes/);
});
