import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import express from 'express';
import { Api } from '../server/api.js';
import { billingIdentityUsage, paymentsOverview, ticketReadiness, venuePaymentSummary } from '../server/payments-overview.js';
import { safeReturnPath } from '../server/organizer-subscriptions.js';

test('subscription setup can return to Payments while keeping destinations local and allowlisted', () => {
  for (const path of ['/account/payments', '/account/payments/plan', '/profile/events/12/edit']) assert.equal(safeReturnPath(path), path);
  for (const path of ['//other.test/account/payments', '/account/payments/../../admin', 'https://other.test', '/account/payments?redirect=external']) assert.equal(safeReturnPath(path), '/profile/events');
});

test('ticket readiness distinguishes absent, incomplete, restricted and enabled sellers', () => {
  assert.equal(ticketReadiness(false, []), 'business_required');
  assert.equal(ticketReadiness(true, []), 'not_set_up');
  assert.equal(ticketReadiness(true, [{ onboardingStatus: 'pending', chargesEnabled: false }]), 'incomplete');
  assert.equal(ticketReadiness(true, [{ onboardingStatus: 'ready', chargesEnabled: false }]), 'action_required');
  assert.equal(ticketReadiness(true, [{ onboardingStatus: 'restricted', chargesEnabled: false }]), 'action_required');
  assert.equal(ticketReadiness(true, [{ onboardingStatus: 'ready', chargesEnabled: true, payoutsEnabled: false }]), 'ready');
});

test('Venue summaries use domain readiness, organization defaults and booking prices', () => {
  const venue = { id: 1, name: 'Studio', priceUnit: 'day', priceFrom: 500, currency: 'SEK' };
  const settings = { sellerBillingProfileId: 9, invoiceMode: 'ykcircle', methods: ['bankgiro'], paymentTermsDays: 10 };
  const ready = { canIssueInvoice: true, missing: [] };
  const summary = venuePaymentSummary(venue, settings, { dailyRate: 3500 }, ready, 'Studio AB');
  assert.equal(summary.rate, 3500);
  assert.equal(summary.unit, 'day');
  assert.equal(summary.status, 'ready');
  assert.equal(summary.sellerBillingProfileId, 9);
  assert.equal(venuePaymentSummary(venue, settings, {}, { canIssueInvoice: false, missing: ['paymentInstructions'] }).status, 'incomplete');
  assert.equal(venuePaymentSummary({ ...venue, priceFrom: 0 }, settings, {}, ready).status, 'free');
  assert.deepEqual(venuePaymentSummary({ ...venue, priceFrom: null }, settings, {}, ready).missing, ['pricing']);
  assert.equal(venuePaymentSummary({ ...venue, priceUnit: 'contact', priceFrom: 0 }, settings, {}, ready).status, 'incomplete');
});

test('usage is scoped to authorized identities and never queries an empty IN list', async () => {
  assert.equal((await billingIdentityUsage({ execute: () => assert.fail('Unexpected query') }, [])).size, 0);
  const usage = await billingIdentityUsage({ execute: async (sql, args) => {
    assert.match(sql, /payment_status='paid'/);
    assert.deepEqual(args, [3, 8, 3, 8, 3, 8, 3, 8, 3, 8]);
    return [[{ profileId: 3, purpose: 'ticket_seller', count: 2 }, { profileId: 3, purpose: 'platform_subscription', count: 1 }, { profileId: 8, purpose: 'venue_buyer', count: 4 }]];
  } }, [{ id: 3 }, { id: 8 }]);
  assert.equal(usage.get(3).length, 2);
  assert.equal(usage.get(8)[0].purpose, 'venue_buyer');
});

test('account overview separates seller revenue, buyer documents and personal access, even for administrators', async () => {
  const scopes = [];
  const profiles = [{ id: 3, profileType: 'individual', legalName: 'Personal' }, { id: 8, profileType: 'organization', ownerOrganizationId: 7, legalName: 'Studio AB' }];
  const scope = (id, role) => { assert.equal(id, 42); scopes.push(role); };
  const queries = {
    database: { execute: async () => [[{ profileId: 8, purpose: 'platform_subscription', count: 1 }]] },
    billingProfiles: async (...args) => { scope(...args); return profiles; },
    managedOrganizations: async (...args) => { scope(...args); return [{ id: 7, name: 'Studio AB' }]; },
    venuesForViewer: async (id, role, options) => { scope(id, role); assert.deepEqual(options, { managedOnly: true }); return [{ id: 1, name: 'Studio', priceFrom: 500, priceUnit: 'hour' }, { id: 2, name: 'Room', priceFrom: 0, priceUnit: 'hour' }]; },
    invoicesForViewer: async (...args) => { scope(...args); return [
      { id: 1, contextType: 'venue_booking', bookingId: 10, buyerUserId: 42, status: 'issued' },
      { id: 2, contextType: 'venue_booking', bookingId: 11, buyerUserId: 99, status: 'issued' },
      { id: 3, contextType: 'platform_service', buyerUserId: 42, status: 'paid' },
      { id: 4, contextType: 'ticket_order', buyerUserId: 42, status: 'paid' },
      { id: 5, contextType: 'venue_booking', buyerUserId: 42, status: 'void' },
    ]; },
    paymentAccounts: async (profileId) => profileId === 8 ? [{ id: 4, provider: 'stripe', providerAccountId: 'acct_secret', onboardingStatus: 'ready', chargesEnabled: true, payoutsEnabled: true }] : [],
    billingProfileCompleteness: () => ({ complete: true }),
    venueFinancialSettings: async () => ({ sellerBillingProfileId: 8, invoiceMode: 'ykcircle', methods: ['swish'], paymentTermsDays: 10 }),
    venueBookingSettings: async () => ({}),
    getVenueFinancialReadiness: async () => ({ canIssueInvoice: true, missing: [] }),
  };
  const subscriptions = {
    access: { configuration: async () => ({ subscriptionsEnabled: false }) },
    owners: async () => [{ id: 42, type: 'user', name: 'Personal account' }, { id: 7, type: 'organization', name: 'Studio AB' }],
    summary: async (owner, id, feature) => ({ subscriptions: feature === 'organizer.publish_event' ? [{ id: owner.id, planName: 'Organizer', status: 'active', providerSubscriptionId: 'sub_secret' }] : [], invoices: owner.type === 'organization' ? [{ id: 'in_stripe', status: 'open', currency: 'SEK', amountDue: 29900, hostedInvoiceUrl: 'https://invoice.stripe.com/example' }] : [] }),
  };
  const result = await paymentsOverview({ queries, subscriptions, user: { id: 42, role: 'admin' } });
  assert.ok(scopes.every((value) => value === 'customer'));
  assert.equal(result.plan.earlyAccess, true);
  assert.equal(result.businesses[0].usedFor.length, 0);
  assert.equal(result.businesses[1].usedFor.filter((usage) => usage.purpose === 'venue_seller').length, 2);
  assert.equal(result.documents.length, 5);
  assert.equal(result.unpaidInvoices, 2); // Buyer invoice + subscription, never seller invoices or voids.
  assert.equal(result.documents.at(-1).totalAmount, 299);
  assert.equal(result.venuePayments[1].status, 'free');
  assert.doesNotMatch(JSON.stringify(result), /acct_secret|sub_secret|ticket_order/);
});

test('payments overview API requires authentication and never caches financial details', async (t) => {
  const secret = 'payments overview test secret that exceeds thirty two characters';
  let reads = 0;
  const queries = {
    initialize: async () => {},
    findUserById: async () => ({ id: 42, role: 'customer', sessionVersion: 1, isEmailConfirmed: true }),
    billingProfiles: async () => { reads++; return []; },
    managedOrganizations: async () => [], venuesForViewer: async () => [], invoicesForViewer: async () => [],
  };
  const ftp = { publicPath: () => '/uploads' };
  const api = new Api({ config: { site: { brandName: 'YKCircle', siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: {}, queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp });
  api.subscriptions.owners = async () => [];
  api.subscriptions.access.configuration = async () => ({ subscriptionsEnabled: false });
  const app = express(); app.use(express.json()); api.register(app);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/account/payments-overview`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(reads, 0);
  const payload = Buffer.from(JSON.stringify({ id: 42, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.json();
  assert.deepEqual(body.businesses, []);
  assert.deepEqual(body.documents, []);
  assert.equal(body.plan.earlyAccess, true);
});
