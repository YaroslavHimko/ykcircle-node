import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { Api } from '../server/api.js';
import { logoImage, validateBranding, MAX_LOGO_BYTES } from '../server/branding.js';
import { EmailService } from '../server/email-service.js';
import { renderInvoicePdf } from '../server/invoice-pdf.js';
import { Queries } from '../server/queries.js';

const jpeg = fs.readFileSync(new URL('./fixtures/customer-logo.jpg', import.meta.url));
const logo = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const branding = { brandName: 'North <Studio>', logoImage: logo, legalName: 'North Studio AB' };

test('logos accept bounded JPEGs and reject URLs, active content, oversized and malformed images', () => {
  assert.equal(logoImage(logo).width, 480);
  assert.equal(logoImage(logo).height, 120);
  assert.deepEqual(logoImage(logo).bytes, jpeg);
  for (const invalid of ['https://example.test/logo.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,aGVsbG8=', `data:image/jpeg;base64,${Buffer.alloc(MAX_LOGO_BYTES + 1).toString('base64')}`, `data:image/jpeg;base64,${jpeg.subarray(0, 40).toString('base64')}`]) {
    const errors = {};
    validateBranding({ logoImage: invalid }, errors);
    assert.ok(errors.logoImage);
  }
  const errors = {};
  validateBranding({ logoImage: '', brandName: 'x'.repeat(161) }, errors);
  assert.ok(errors.brandName);
  assert.equal(errors.logoImage, undefined);
});

test('event emails feature the customer and attach the logo inline without changing the sender address', async () => {
  const messages = [];
  const service = new EmailService({ smtp: { host: 'smtp.test', verification: {}, invitation: {}, applicationNotification: {} }, domain: 'ykcircle.test', brandName: 'YKCircle', noReplyFrom: 'YKCircle <no-reply@ykcircle.test>', invitationFrom: 'invites@ykcircle.test', notificationFrom: 'updates@ykcircle.test', eventDetailsUrl: 'https://ykcircle.test/events', invitationResponseUrl: 'https://ykcircle.test/invitations' });
  service.mailer = service.invitationMailer = service.notificationMailer = { sendMail: async message => { messages.push(message); return { accepted: [message.to], rejected: [] }; } };
  const event = { ...branding, id: 5, title: 'Studio gathering', startsAt: '2099-01-01T12:00:00Z', timezone: 'UTC', invitationToken: 'token' };
  await service.sendRegistrationConfirmation('guest@example.test', 'Guest', event);
  await service.sendRegistrationApproved('guest@example.test', 'Guest', event);
  await service.sendRegistrationWithdrawal('guest@example.test', 'Guest', event);
  await service.sendEventInvitation('guest@example.test', 'Guest', event);
  await service.sendGroupEventNotification('guest@example.test', 'Guest', { name: 'Studio members' }, event);
  await service.sendTickets({ id: 1, seller: branding, eventTitle: event.title, event, orderNumber: 'TKT-1', attendeeEmail: 'guest@example.test', totalAmount: 10, currency: 'SEK', tickets: [{ name: 'Admission', code: 'YK-TICKET' }] }, 'https://ykcircle.test/tickets/1');
  for (const message of messages) {
    assert.equal(message.from.name, branding.brandName);
    assert.match(message.html, /North &lt;Studio&gt;/);
    assert.doesNotMatch(message.html, /North <Studio>/);
    assert.equal((message.html.match(/YKCircle/g) || []).length, 1);
    assert.match(message.html, /src="cid:customer-logo"/);
    assert.deepEqual(message.attachments.find(attachment => attachment.cid === 'customer-logo').content, jpeg);
  }
  assert.equal(messages[0].from.address, 'no-reply@ykcircle.test');
  const offline = messages.at(-1).attachments.find(attachment => attachment.filename === 'tickets.html');
  assert.ok(offline.content.includes(logo));
  assert.ok(offline.content.includes('YK-TICKET'));
  assert.doesNotMatch(offline.content, /cid:customer-logo/);
  assert.match(offline.content, /name="viewport"/);
});

test('invoice PDFs embed the snapshotted customer logo with valid object offsets and name fallback', () => {
  const invoice = { id: 1, seller: branding, currency: 'SEK', items: [], subtotal: 100, taxAmount: 0, totalAmount: 100 };
  const pdf = renderInvoicePdf(invoice);
  const source = pdf.toString('utf8');
  assert.match(source, /\/Subtype \/Image \/Width 480 \/Height 120/);
  assert.ok(source.includes(jpeg.toString('hex')));
  assert.ok(source.includes(Buffer.from('North <Studio>').toString('hex').toUpperCase()));
  assert.doesNotMatch(source, /<594B20434952434C45>/); // former platform wordmark
  const entries = source.match(/xref\n0 \d+\n([\s\S]*?)trailer/)[1].trim().split('\n').slice(1);
  entries.forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10));
    assert.equal(pdf.subarray(offset, offset + `${index + 1} 0 obj`.length).toString(), `${index + 1} 0 obj`);
  });
  const fallback = renderInvoicePdf({ ...invoice, seller: { legalName: 'North Studio AB' } }).toString();
  assert.doesNotMatch(fallback, /\/Subtype \/Image/);
  assert.ok(fallback.includes(Buffer.from('North Studio AB').toString('hex').toUpperCase()));
});

test('issued venue invoices freeze the logo and brand independently of later venue edits', async () => {
  let saved = null;
  const context = { id: 2, status: 'confirmed', invoiceMode: 'ykcircle', venueName: 'Studio room', venueBrandName: branding.brandName, venueLogoImage: logo, sellerOrganizationId: 4,
    bookingType: 'hourly', startAt: '2099-01-01T12:00:00Z', endAt: '2099-01-01T14:00:00Z', hourlyRate: 100, currency: 'SEK', taxMode: 'no_tax', methods: ['bankgiro'], bankgiro: '123-4567',
    acceptedTermsVersion: '2026-09-09', acceptedAt: new Date(), acceptedByUserId: 7, paymentTermsDays: 30,
    seller: { id: 3, ownerOrganizationId: 4, isActive: true, profileType: 'organization', legalName: 'North Studio AB', addressLine1: 'Main 1', postalCode: '111 11', city: 'Stockholm', country: 'Sweden', billingEmail: 'billing@example.test', invoicePrefix: 'NS' },
    buyer: { id: 5, isActive: true, legalName: 'Buyer' } };
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, execute: async (sql, params) => {
    if (sql.startsWith('SELECT id FROM invoices')) return [saved ? [{ id: 9 }] : []];
    if (sql.startsWith('INSERT INTO invoices')) saved = JSON.parse(params[14]);
    return [{ insertId: 9, affectedRows: 1 }];
  } };
  const queries = new Queries({ execute: connection.execute, getConnection: async () => connection });
  queries.venueBookingFinancialContext = async () => context;
  queries.allocateInvoiceNumber = async () => ({ invoiceNumber: 'NS-1', seriesId: 1 });
  assert.equal((await queries.ensureVenueBookingInvoice(2, 7)).invoiceId, 9);
  assert.equal(saved.logoImage, logo);
  assert.equal(saved.brandName, branding.brandName);
  context.venueLogoImage = null; context.venueBrandName = 'New branding';
  await queries.ensureVenueBookingInvoice(2, 7);
  assert.equal(saved.logoImage, logo);
  assert.equal(saved.brandName, branding.brandName);
});

test('ticket checkout snapshots organizer branding alongside the legal seller', async () => {
  let saved;
  const execute = async (sql, params) => {
    if (sql.startsWith('SELECT id, starts_at')) return [[{ id: 5, startsAt: '2099-01-01T12:00:00Z' }]];
    if (sql.includes('FROM event_ticket_types')) return [[{ id: 1, name: 'Admission', currency: 'SEK', price: 100, quantityAvailable: 10, quantitySold: 0 }]];
    if (sql.includes('GROUP BY item.ticket_type_id')) return [[]];
    if (sql.startsWith('INSERT INTO ticket_orders')) saved = JSON.parse(params[10]);
    return [{ insertId: 8 }];
  };
  const queries = new Queries({ execute, getConnection: async () => ({ execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }) });
  queries.ticketCheckoutContext = async () => ({ currency: 'SEK', seller: branding });
  queries.ticketOrder = async () => ({ id: 8, seller: saved });
  const order = await queries.createTicketOrder(5, { userId: 7, email: 'guest@example.test' }, [{ ticketTypeId: 1, quantity: 1 }]);
  assert.deepEqual(order.seller, branding);
});

test('event and venue APIs save logos, reject invalid images and support removing them', async (t) => {
  const secret = 'customer-branding-test-secret-at-least-thirty-two-characters';
  let event = null, venue = null;
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 7, role: 'organizer', sessionVersion: 1, isEmailConfirmed: true }),
    createRichEventSeries: async data => { event = { ...data, id: 5, status: 'Draft' }; return { eventIds: [5] }; },
    updateRichEventAndBooking: async (_id, _user, _role, data) => { event = { ...event, ...data }; return true; },
    richEvent: async () => event,
    createVenue: async (_user, data) => { venue = { ...data, id: 6 }; return 6; },
    updateVenue: async (_id, _user, _role, data) => { venue = { ...venue, ...data }; return true; },
    venue: async () => venue,
  };
  const ftp = { publicPath: () => '/uploads/test' };
  const app = express(); app.use(express.json({ limit: '256kb' }));
  new Api({ config: { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret } }, database: {}, queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp, venueFtpService: ftp }).register(app);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const payload = Buffer.from(JSON.stringify({ id: 7, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const request = async (route, method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const eventBody = { title: 'Studio gathering', startsAtUtc: '2099-01-01T12:00:00Z', timezone: 'UTC', locationType: 'online', brandName: branding.brandName, logoImage: logo };
  const venueBody = { name: 'North Studio', businessName: branding.brandName, formattedAddress: 'Stockholm, Sweden', country: 'Sweden', city: 'Stockholm', latitude: 59.3, longitude: 18, venueType: 'studio', availability: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }], logoImage: logo };
  for (const [create, update, body] of [['/api/events/drafts', '/api/events/5', eventBody], ['/api/venues', '/api/venues/6', venueBody]]) {
    const created = await request(create, 'POST', body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.logoImage, logo);
    const invalid = await request(update, 'PATCH', { ...body, logoImage: 'https://example.test/logo.jpg' });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.data.fields.logoImage);
    const cleared = await request(update, 'PATCH', { ...body, logoImage: '' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.ok(!cleared.data.logoImage);
  }
  await request('/api/venues/6', 'PATCH', { logoImage: logo });
  const unchanged = await request('/api/venues/6', 'PATCH', { name: 'Renamed studio' });
  assert.equal(unchanged.data.logoImage, logo);
});
