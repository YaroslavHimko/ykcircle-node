import Stripe from 'stripe';

const stripeCountryCode = (country) => {
  const value = String(country || '').trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  const countries = {
    australia: 'AU', austria: 'AT', belgium: 'BE', brazil: 'BR', bulgaria: 'BG', canada: 'CA', croatia: 'HR', cyprus: 'CY',
    czechia: 'CZ', 'czech republic': 'CZ', denmark: 'DK', estonia: 'EE', finland: 'FI', france: 'FR', germany: 'DE',
    gibraltar: 'GI', greece: 'GR', 'hong kong': 'HK', hungary: 'HU', india: 'IN', indonesia: 'ID', ireland: 'IE', italy: 'IT',
    japan: 'JP', latvia: 'LV', liechtenstein: 'LI', lithuania: 'LT', luxembourg: 'LU', malaysia: 'MY', malta: 'MT', mexico: 'MX',
    netherlands: 'NL', 'new zealand': 'NZ', norway: 'NO', poland: 'PL', portugal: 'PT', romania: 'RO', singapore: 'SG',
    slovakia: 'SK', slovenia: 'SI', spain: 'ES', sweden: 'SE', switzerland: 'CH', thailand: 'TH', 'united arab emirates': 'AE',
    'united kingdom': 'GB', uk: 'GB', 'united states': 'US', usa: 'US', us: 'US',
  };
  return countries[value.toLowerCase()] || null;
};

export class StripeConnectService {
  constructor(stripe = {}, stripeClient = null) {
    this.secretKey = stripe.secretKey || null;
    this.publishableKey = stripe.publishableKey || null;
    this.webhookSecret = stripe.webhookSecret || null;
    this.thinWebhookSecret = stripe.thinWebhookSecret || null;
    this.applicationFeePercent = Number(stripe.applicationFeePercent || 0);
    // Placeholder: STRIPE_SECRET_KEY must be a sandbox sk_test_… key for testing.
    // The SDK selects its supported API version; never send credentials to the browser.
    this.stripeClient = stripeClient || (this.secretKey ? new Stripe(this.secretKey, { maxNetworkRetries: 2, timeout: 20000 }) : null);
  }

  configured() { return Boolean(this.secretKey); }
  testMode() { return /^(sk|rk)_test_/.test(this.secretKey || ''); }

  onboardingStatus(account) {
    const chargesEnabled = account?.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
    const requirementsStatus = account?.requirements?.summary?.minimum_deadline?.status;
    const requirementsComplete = !['currently_due', 'past_due'].includes(requirementsStatus);
    return {
      chargesEnabled,
      payoutsEnabled: account?.configuration?.merchant?.capabilities?.stripe_balance?.payouts?.status === 'active',
      detailsSubmitted: Boolean(chargesEnabled || requirementsComplete),
      onboardingStatus: chargesEnabled ? 'ready' : requirementsComplete ? 'restricted' : 'pending',
      requirementsStatus: requirementsStatus || null,
    };
  }

  async request(path, data = {}, connectedAccountId = null, idempotencyKey = null) {
    if (!this.configured()) throw new Error('Set STRIPE_SECRET_KEY to your Stripe sandbox secret key before accepting ticket payments.');
    return this.stripeClient.rawRequest(data === null ? 'GET' : 'POST', `/v1${path}`, data || {}, {
      ...(connectedAccountId ? { stripeAccount: connectedAccountId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async createConnectedAccount(profile) {
    const country = stripeCountryCode(profile.country);
    if (!country) {
      const error = new Error('Choose a supported country before starting payment onboarding.');
      error.code = 'UNSUPPORTED_STRIPE_COUNTRY';
      throw error;
    }
    if (!this.stripeClient) throw new Error('Set STRIPE_SECRET_KEY before onboarding a seller.');
    return this.stripeClient.v2.core.accounts.create({
      display_name: profile.legalName, contact_email: profile.billingEmail,
      identity: { country }, dashboard: 'full',
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: { customer: {}, merchant: { capabilities: { card_payments: { requested: true } } } },
    }, { idempotencyKey: `seller-${profile.id}-${this.testMode() ? 'test' : 'live'}` });
  }

  async createOnboardingLink(accountId, { refreshUrl, returnUrl }) {
    const account = await this.account(accountId);
    // Existing Express accounts retain their original onboarding flow.
    if (account.legacy) return this.stripeClient.accountLinks.create({ account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
    return this.stripeClient.v2.core.accountLinks.create({ account: accountId, use_case: {
      type: 'account_onboarding', account_onboarding: { configurations: ['merchant', 'customer'], refresh_url: refreshUrl, return_url: returnUrl },
    } });
  }

  async account(accountId) {
    try {
      const account = await this.stripeClient.v2.core.accounts.retrieve(accountId, { include: ['configuration.merchant', 'requirements'] });
      const status = this.onboardingStatus(account);
      return { ...account, charges_enabled: status.chargesEnabled, payouts_enabled: status.payoutsEnabled, details_submitted: status.detailsSubmitted, onboarding_status: status.onboardingStatus, requirements_status: status.requirementsStatus };
    } catch (error) {
      if (!['resource_missing', 'account_invalid', 'v2_account_not_found'].includes(error.code)) throw error;
      return { ...await this.stripeClient.accounts.retrieve(accountId), legacy: true };
    }
  }

  checkoutSession(sessionId, accountId) {
    return this.stripeClient.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: accountId });
  }

  async createDirectCheckout({ order, context, successUrl, cancelUrl }) {
    const fee = Math.round(Number(order.totalAmount) * this.applicationFeePercent);
    if (!Number.isFinite(fee) || fee < 0 || fee > Math.round(Number(order.totalAmount) * 100)) throw new Error('STRIPE_APPLICATION_FEE_PERCENT must be between 0 and 100.');
    return this.stripeClient.checkout.sessions.create({
      mode: 'payment', success_url: successUrl, cancel_url: cancelUrl, client_reference_id: String(order.id),
      customer_email: order.attendeeEmail,
      payment_method_types: ['card'],
      expires_at: Math.floor(new Date(order.createdAt || Date.now()).getTime() / 1000) + 35 * 60,
      metadata: { ticketOrderId: String(order.id) },
      payment_intent_data: { metadata: { ticketOrderId: String(order.id) }, ...(fee ? { application_fee_amount: fee } : {}) },
      // Prices and quantities come from the locked database order, not the browser.
      line_items: order.items.map((item) => ({ price_data: { currency: order.currency.toLowerCase(), product_data: { name: `${context.title}: ${item.ticketType.name}` }, unit_amount: Math.round(Number(item.unitPrice) * 100) }, quantity: item.quantity })),
    }, { stripeAccount: context.providerAccountId, idempotencyKey: `ticket-checkout-${order.id}` });
  }

  async createPlatformCheckout({ order, successUrl, cancelUrl }) {
    const product = order.product || {};
    const recurring = product.productType === 'subscription' && order.providerPriceId ? { price: order.providerPriceId, quantity: 1 } : {
      price_data: { currency: order.currency.toLowerCase(), product_data: { name: product.name || 'YKCircle service' }, unit_amount: Math.round(Number(order.totalAmount) * 100) }, quantity: 1,
    };
    return this.request('/checkout/sessions', {
      mode: product.productType === 'subscription' && order.providerPriceId ? 'subscription' : 'payment', success_url: successUrl, cancel_url: cancelUrl,
      client_reference_id: String(order.id), metadata: { platformOrderId: String(order.id) },
      payment_intent_data: product.productType === 'subscription' && order.providerPriceId ? undefined : { metadata: { platformOrderId: String(order.id) } },
      subscription_data: product.productType === 'subscription' && order.providerPriceId ? { metadata: { platformOrderId: String(order.id) } } : undefined,
      line_items: { 0: recurring },
    }, null, `platform-checkout-${order.id}`);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId) {
    return this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: true });
  }

  async createDirectRefund(paymentIntentId, connectedAccountId, amount = null) {
    return this.request('/refunds', { payment_intent: paymentIntentId, amount }, connectedAccountId, `ticket-refund-${paymentIntentId}-${amount || 'full'}`);
  }

  verifyWebhook(rawBody, signature) {
    if (!this.webhookSecret || !signature) return null;
    try { return Stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret); } catch { return null; }
  }

  verifyThinWebhook(rawBody, signature) {
    if (!this.thinWebhookSecret || !signature || !this.stripeClient) return null;
    try { return this.stripeClient.parseEventNotification(rawBody, signature, this.thinWebhookSecret); } catch { return null; }
  }
}
