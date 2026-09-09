import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateVenueBookingPrice, venueFinancialReadiness } from '../server/venue-finance.js';

test('prices only the selected hourly interval and applies configured tax', () => {
  const price = calculateVenueBookingPrice({
    bookingType: 'hourly', startAt: '2026-09-18T12:00:00Z', endAt: '2026-09-18T15:00:00Z',
    hourlyRate: 500, currency: 'SEK', taxMode: 'configured', defaultTaxRate: 25,
  });
  assert.equal(price.lineItems[0].quantity, 3);
  assert.equal(price.subtotal, 1500);
  assert.equal(price.taxAmount, 375);
  assert.equal(price.total, 1875);
});

test('extracts tax from tax-inclusive prices without hardcoding a rate', () => {
  const price = calculateVenueBookingPrice({
    bookingType: 'hourly', startAt: '2026-09-18T12:00:00Z', endAt: '2026-09-18T15:00:00Z',
    hourlyRate: 625, currency: 'SEK', taxMode: 'configured', defaultTaxRate: 25, pricesIncludeTax: true,
  });
  assert.equal(price.subtotal, 1500);
  assert.equal(price.taxAmount, 375);
  assert.equal(price.total, 1875);
});

test('venue invoice readiness requires organization seller, instructions, tax decision, and authorization', () => {
  const settings = { invoiceMode: 'ykcircle', taxMode: 'no_tax', acceptedTermsVersion: '2026-09-09', acceptedAt: new Date(), acceptedByUserId: 7 };
  const seller = { isActive: true, profileType: 'organization', legalName: 'Stockholm Studio AB', addressLine1: 'Main 1', postalCode: '111 11', city: 'Stockholm', country: 'Sweden', billingEmail: 'billing@example.test', invoicePrefix: 'SS' };
  const payment = { methods: ['bankgiro'], bankgiro: '123-4567' };
  assert.equal(venueFinancialReadiness(settings, seller, payment).canIssueInvoice, true);
  assert.deepEqual(venueFinancialReadiness(settings, seller, { methods: [] }).missing, ['paymentInstructions']);
});

test('external invoice mode never depends on Stripe or YKCircle invoice setup', () => {
  const readiness = venueFinancialReadiness({ invoiceMode: 'external' }, null, null);
  assert.equal(readiness.canIssueInvoice, true);
  assert.deepEqual(readiness.missing, []);
});
