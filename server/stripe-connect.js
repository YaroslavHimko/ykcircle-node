import crypto from 'node:crypto';

const asForm = (value, prefix = '', target = new URLSearchParams()) => {
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry === undefined || entry === null || entry === '') continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof entry === 'object' && !Array.isArray(entry)) asForm(entry, name, target);
    else target.append(name, String(entry));
  }
  return target;
};

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
  constructor(stripe = {}) {
    this.secretKey = stripe.secretKey || null;
    this.publishableKey = stripe.publishableKey || null;
    this.webhookSecret = stripe.webhookSecret || null;
  }

  configured() { return Boolean(this.secretKey); }

  async request(path, data = {}, connectedAccountId = null, idempotencyKey = null) {
    if (!this.configured()) throw new Error('Stripe is not configured.');
    const headers = { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (connectedAccountId) headers['Stripe-Account'] = connectedAccountId;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(`https://api.stripe.com/v1${path}`, { method: data === null ? 'GET' : 'POST', headers, body: data === null ? undefined : asForm(data).toString() });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || 'Stripe request failed.');
    return body;
  }

  async createConnectedAccount(profile) {
    const country = stripeCountryCode(profile.country);
    if (!country) {
      const error = new Error('Choose a supported country before starting payment onboarding.');
      error.code = 'UNSUPPORTED_STRIPE_COUNTRY';
      throw error;
    }
    return this.request('/accounts', {
      type: 'express', country, email: profile.billingEmail,
      business_type: profile.profileType === 'organization' ? 'company' : 'individual',
      business_profile: { name: profile.legalName },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    });
  }

  async createOnboardingLink(accountId, { refreshUrl, returnUrl }) {
    return this.request('/account_links', { account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
  }

  async account(accountId) { return this.request(`/accounts/${encodeURIComponent(accountId)}`, null); }

  async createDirectCheckout({ order, context, successUrl, cancelUrl }) {
    return this.request('/checkout/sessions', {
      mode: 'payment', success_url: successUrl, cancel_url: cancelUrl, client_reference_id: String(order.id),
      metadata: { ticketOrderId: String(order.id) },
      payment_intent_data: { metadata: { ticketOrderId: String(order.id) } },
      line_items: { 0: { price_data: { currency: order.currency.toLowerCase(), product_data: { name: `${context.title} tickets` }, unit_amount: Math.round(Number(order.totalAmount) * 100) }, quantity: 1 } },
    }, context.providerAccountId, `ticket-checkout-${order.id}`);
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
    const parts = Object.fromEntries(String(signature).split(',').map((part) => part.split('=', 2)).filter(([key, value]) => key && value));
    const timestamp = Number(parts.t); const signatureValue = parts.v1;
    if (!Number.isInteger(timestamp) || !signatureValue || Math.abs(Date.now() / 1000 - timestamp) > 300) return null;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    const supplied = Buffer.from(signatureValue, 'hex'); const expectedBuffer = Buffer.from(expected, 'hex');
    if (supplied.length !== expectedBuffer.length || !crypto.timingSafeEqual(supplied, expectedBuffer)) return null;
    try { return JSON.parse(rawBody); } catch { return null; }
  }
}
