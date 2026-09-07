import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { StripeConnectService } from '../server/stripe-connect.js';

test('verifies Stripe webhook signatures against the original raw payload', () => {
  const secret = 'whsec_test';
  const service = new StripeConnectService({ webhookSecret: secret });
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

  assert.deepEqual(service.verifyWebhook(raw, `t=${timestamp},v1=${signature}`), JSON.parse(raw));
  assert.equal(service.verifyWebhook(`${raw} `, `t=${timestamp},v1=${signature}`), null);
  assert.equal(service.verifyWebhook(raw, `t=${timestamp},v1=not-a-signature`), null);
});

test('formats a direct-charge Checkout request without exposing credentials in its data', async () => {
  const service = new StripeConnectService({ secretKey: 'sk_test_123' });
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { seen.push({ url, options }); return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }) }; };
  try {
    const checkout = await service.createDirectCheckout({ order: { id: 8, currency: 'SEK', totalAmount: 125 }, context: { title: 'Night run', providerAccountId: 'acct_organizer' }, successUrl: 'https://ykcircle.test/tickets/success', cancelUrl: 'https://ykcircle.test/events/1' });
    assert.equal(checkout.id, 'cs_1');
    assert.equal(seen[0].options.headers['Stripe-Account'], 'acct_organizer');
    assert.equal(seen[0].options.headers['Idempotency-Key'], 'ticket-checkout-8');
    assert.match(seen[0].options.body, /payment_intent_data%5Bmetadata%5D%5BticketOrderId%5D=8/);
    assert.doesNotMatch(seen[0].options.body, /sk_test_123/);
  } finally { globalThis.fetch = originalFetch; }
});

test('converts billing-profile country names to Stripe country codes for connected accounts', async () => {
  const service = new StripeConnectService({ secretKey: 'sk_test_123' });
  const originalFetch = globalThis.fetch; let seen;
  globalThis.fetch = async (_url, options) => { seen = options; return { ok: true, json: async () => ({ id: 'acct_1' }) }; };
  try {
    await service.createConnectedAccount({ country: 'Sweden', billingEmail: 'seller@example.test', profileType: 'individual', legalName: 'Example Seller' });
    assert.match(seen.body, /country=SE/);
  } finally { globalThis.fetch = originalFetch; }
});

test('uses the platform account for platform Checkout and preserves checkout idempotency', async () => {
  const service = new StripeConnectService({ secretKey: 'sk_test_123' });
  const originalFetch = globalThis.fetch; let seen;
  globalThis.fetch = async (_url, options) => { seen = options; return { ok: true, json: async () => ({ id: 'cs_platform', url: 'https://checkout.stripe.test/platform' }) }; };
  try {
    await service.createPlatformCheckout({ order: { id: 21, currency: 'SEK', totalAmount: 99, product: { productType: 'event_fee', name: 'Publish event' } }, successUrl: 'https://ykcircle.test/billing/success', cancelUrl: 'https://ykcircle.test/billing' });
    assert.equal(seen.headers['Stripe-Account'], undefined);
    assert.equal(seen.headers['Idempotency-Key'], 'platform-checkout-21');
    assert.match(seen.body, /metadata%5BplatformOrderId%5D=21/);
  } finally { globalThis.fetch = originalFetch; }
});
