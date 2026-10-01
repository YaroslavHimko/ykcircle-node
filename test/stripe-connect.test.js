import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import http from 'node:http';
import Stripe from 'stripe';
import { StripeConnectService } from '../server/stripe-connect.js';

test('verifies raw webhook bytes, timestamp tolerance and rotated signatures', () => {
  const secret = 'whsec_test';
  const service = new StripeConnectService({ webhookSecret: secret });
  const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = (time) => crypto.createHmac('sha256', secret).update(`${time}.${raw}`).digest('hex');
  assert.deepEqual(service.verifyWebhook(raw, `t=${timestamp},v1=bad,v1=${sign(timestamp)}`), JSON.parse(raw));
  assert.equal(service.verifyWebhook(raw + ' ', `t=${timestamp},v1=${sign(timestamp)}`), null);
  assert.equal(service.verifyWebhook(raw, `t=${timestamp - 600},v1=${sign(timestamp - 600)}`), null);
  assert.equal(service.verifyWebhook(raw, 'invalid'), null);
});

test('ticket and subscription signatures use separate secrets without fallback', () => {
  const secrets = { webhookSecret: 'whsec_tickets', subscriptionWebhookSecret: 'whsec_subscriptions', thinWebhookSecret: 'whsec_thin' };
  const service = new StripeConnectService(secrets);
  const event = { id: 'evt_subscription', type: 'customer.subscription.updated' };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = (secret, time = timestamp) => `t=${time},v1=${crypto.createHmac('sha256', secret).update(`${time}.${raw}`).digest('hex')}`;
  for (const [name, secret] of Object.entries(secrets)) {
    assert.deepEqual(service.verifyWebhook(raw, sign(secret)), name === 'webhookSecret' ? event : null);
    assert.deepEqual(service.verifySubscriptionWebhook(raw, sign(secret)), name === 'subscriptionWebhookSecret' ? event : null);
  }
  assert.equal(service.verifySubscriptionWebhook(raw + ' ', sign(secrets.subscriptionWebhookSecret)), null);
  assert.equal(service.verifySubscriptionWebhook(raw, sign(secrets.subscriptionWebhookSecret, timestamp - 600)), null);
  assert.equal(service.verifySubscriptionWebhook(raw, undefined), null);
  assert.equal(service.verifySubscriptionWebhook(raw, 'invalid'), null);
  const ticketOnly = new StripeConnectService({ webhookSecret: secrets.webhookSecret });
  assert.equal(ticketOnly.verifySubscriptionWebhook(raw, sign(secrets.webhookSecret)), null);
  assert.equal(ticketOnly.verifySubscriptionWebhook(raw, sign(secrets.subscriptionWebhookSecret)), null);
});

test('official SDK sends itemized direct Checkout and v2 account creation to Stripe', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/v2/') ? { id: 'acct_seller' } : { id: 'cs_ticket', url: 'https://checkout.stripe.test/example' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const stripeClient = new Stripe('sk_test_example', { host: '127.0.0.1', port: server.address().port, protocol: 'http', maxNetworkRetries: 0 });
  const service = new StripeConnectService({ secretKey: 'sk_test_example', applicationFeePercent: 5 }, stripeClient);
  assert.equal(service.testMode(), true);
  await service.createDirectCheckout({ order: { id: 8, attendeeEmail: 'buyer@example.test', totalAmount: 250, currency: 'SEK', items: [{ ticketType: { name: 'Admission' }, quantity: 2, unitPrice: 125 }] }, context: { title: 'Night run', providerAccountId: 'acct_seller' }, successUrl: 'https://ykcircle.test/tickets/8', cancelUrl: 'https://ykcircle.test/events/1' });
  const form = new URLSearchParams(requests[0].body);
  assert.equal(requests[0].headers['stripe-account'], 'acct_seller');
  assert.equal(requests[0].headers['idempotency-key'], 'ticket-checkout-8');
  assert.equal(form.get('line_items[0][quantity]'), '2');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '12500');
  assert.equal(form.get('payment_intent_data[application_fee_amount]'), '1250');
  assert.equal(form.get('customer_email'), 'buyer@example.test');
  assert.equal(form.get('payment_method_types[0]'), 'card');
  assert.doesNotMatch(requests[0].body, /sk_test/);
  await service.createConnectedAccount({ id: 3, country: 'Sweden', billingEmail: 'seller@example.test', legalName: 'Example Seller' });
  assert.equal(requests[1].path, '/v2/core/accounts');
  const account = JSON.parse(requests[1].body);
  assert.equal(account.identity.country, 'SE');
  assert.equal(account.dashboard, 'full');
  assert.equal(account.type, undefined);
  assert.deepEqual(account.defaults.responsibilities, { fees_collector: 'stripe', losses_collector: 'stripe' });
  await service.createPlatformCheckout({ order: { id: 21, currency: 'SEK', totalAmount: 99, product: { productType: 'event_fee', name: 'Publish event' } }, successUrl: 'https://ykcircle.test/billing', cancelUrl: 'https://ykcircle.test/billing' });
  assert.equal(requests[2].headers['stripe-account'], undefined);
  assert.equal(requests[2].headers['idempotency-key'], 'platform-checkout-21');
});

test('refreshes v2 card capability status and creates onboarding links', async () => {
  let link;
  const service = new StripeConnectService({ secretKey: 'sk_test_example' }, { v2: { core: {
    accounts: { retrieve: async () => ({ id: 'acct_seller', configuration: { merchant: { capabilities: { card_payments: { status: 'active' } } } }, requirements: {} }) },
    accountLinks: { create: async (data) => { link = data; return { url: 'https://connect.stripe.com/onboarding' }; } },
  } } });
  assert.equal((await service.account('acct_seller')).charges_enabled, true);
  await service.createOnboardingLink('acct_seller', { refreshUrl: 'https://example.test/refresh', returnUrl: 'https://example.test/return' });
  assert.deepEqual(link.use_case.account_onboarding.configurations, ['merchant', 'customer']);
});

test('only allows HTTPS Stripe-hosted onboarding links', () => {
  const service = new StripeConnectService();
  assert.equal(service.onboardingUrl({ url: 'https://connect.stripe.com/setup?account=acct_seller' }), 'https://connect.stripe.com/setup?account=acct_seller');
  assert.throws(() => service.onboardingUrl({ url: 'otpauth://totp/Stripe?secret=redacted' }), { code: 'INVALID_STRIPE_ONBOARDING_URL' });
  assert.throws(() => service.onboardingUrl({ url: 'https://stripe.example.test/setup' }), { code: 'INVALID_STRIPE_ONBOARDING_URL' });
});
