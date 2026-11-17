export function registerSubscriptionsPlatformRoutes(
  app,
  {
    ensureTable,
    queries,
    authenticate,
    requireAdmin,
    requirePlatformStaff,
    requireVerifiedUser,
    config,
    sameSiteUrl,
    stripe,
  },
) {
  app.get('/api/platform/products', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.platformProducts());
    } catch (error) {
      console.error('Platform products lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load platform products.' });
    }
  });
  app.post('/api/admin/platform/billing-profile', authenticate, requireAdmin, async (req, res) => {
    const billingProfileId = Number(req.body.billingProfileId);
    if (!Number.isInteger(billingProfileId) || billingProfileId < 1)
      return res.status(422).json({ error: 'A valid platform billing profile is required.' });
    try {
      await ensureTable();
      return (await queries.setPlatformBillingProfile(billingProfileId, req.user.id))
        ? res.status(204).end()
        : res.status(422).json({ error: 'The platform billing profile must be active.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to configure the platform billing profile.' });
    }
  });
  app.post('/api/admin/platform/products', authenticate, requirePlatformStaff, async (req, res) => {
    const product = {
      productType: String(req.body.productType || ''),
      code: String(req.body.code || '')
        .trim()
        .toLowerCase(),
      name: String(req.body.name || '').trim(),
      description:
        req.body.description == null ? null : String(req.body.description).trim() || null,
      entitlementFeature:
        req.body.entitlementFeature == null
          ? null
          : String(req.body.entitlementFeature).trim() || null,
      isActive: req.body.isActive !== false,
    };
    if (
      !['subscription', 'event_fee', 'featured_listing', 'other'].includes(product.productType) ||
      !/^[a-z0-9][a-z0-9_-]{1,99}$/.test(product.code) ||
      !product.name ||
      product.name.length > 255
    )
      return res.status(422).json({ error: 'Platform product is invalid.' });
    try {
      await ensureTable();
      const result = await queries.savePlatformProduct(null, product, req.user.id);
      return res.status(201).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to create platform product.' });
    }
  });
  app.put(
    '/api/admin/platform/products/:id',
    authenticate,
    requirePlatformStaff,
    async (req, res) => {
      const id = Number(req.params.id);
      const product = {
        productType: String(req.body.productType || ''),
        code: String(req.body.code || '')
          .trim()
          .toLowerCase(),
        name: String(req.body.name || '').trim(),
        description:
          req.body.description == null ? null : String(req.body.description).trim() || null,
        entitlementFeature:
          req.body.entitlementFeature == null
            ? null
            : String(req.body.entitlementFeature).trim() || null,
        isActive: req.body.isActive !== false,
      };
      if (
        !Number.isInteger(id) ||
        id < 1 ||
        !['subscription', 'event_fee', 'featured_listing', 'other'].includes(product.productType) ||
        !/^[a-z0-9][a-z0-9_-]{1,99}$/.test(product.code) ||
        !product.name ||
        product.name.length > 255
      )
        return res.status(422).json({ error: 'Platform product is invalid.' });
      try {
        await ensureTable();
        const result = await queries.savePlatformProduct(id, product, req.user.id);
        return result
          ? res.json(result)
          : res.status(404).json({ error: 'Platform product not found.' });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to update platform product.' });
      }
    },
  );
  app.post(
    '/api/admin/platform/products/:id/prices',
    authenticate,
    requirePlatformStaff,
    async (req, res) => {
      const productId = Number(req.params.id);
      const price = {
        currency: String(req.body.currency || '').toUpperCase(),
        amount: Number(req.body.amount),
        billingInterval:
          req.body.billingInterval == null || req.body.billingInterval === ''
            ? null
            : String(req.body.billingInterval),
        providerPriceId:
          req.body.providerPriceId == null ? null : String(req.body.providerPriceId).trim() || null,
        isActive: req.body.isActive !== false,
      };
      if (
        !Number.isInteger(productId) ||
        productId < 1 ||
        !/^[A-Z]{3}$/.test(price.currency) ||
        !Number.isFinite(price.amount) ||
        price.amount < 0 ||
        ![null, 'month', 'year'].includes(price.billingInterval)
      )
        return res.status(422).json({ error: 'Platform price is invalid.' });
      try {
        await ensureTable();
        const result = await queries.savePlatformPrice(productId, price, req.user.id);
        return result
          ? res.status(201).json(result)
          : res.status(404).json({ error: 'Platform product not found.' });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to create platform price.' });
      }
    },
  );
  app.post('/api/platform/orders', authenticate, requireVerifiedUser, async (req, res) => {
    const idempotencyKey = req.get('idempotency-key') || null;
    const request = {
      buyerBillingProfileId: Number(req.body.buyerBillingProfileId),
      productId: Number(req.body.productId),
      priceId: Number(req.body.priceId),
      eventId:
        req.body.eventId == null || req.body.eventId === '' ? null : Number(req.body.eventId),
      buyerCapacity: String(req.body.buyerCapacity || ''),
      termsVersion:
        req.body.termsVersion == null ? null : String(req.body.termsVersion).trim() || null,
      idempotencyKey,
    };
    if (
      !Number.isInteger(request.buyerBillingProfileId) ||
      !Number.isInteger(request.productId) ||
      !Number.isInteger(request.priceId) ||
      (request.eventId !== null && !Number.isInteger(request.eventId)) ||
      !['consumer', 'business'].includes(request.buyerCapacity) ||
      (idempotencyKey !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))
    )
      return res.status(422).json({ error: 'Platform order is invalid.' });
    try {
      await ensureTable();
      const result = await queries.createPlatformOrder(req.user.id, req.user.role, request);
      const messages = {
        BUYER_PROFILE_UNAVAILABLE: 'This billing profile is not available to your account.',
        PRODUCT_UNAVAILABLE: 'This platform product or price is unavailable.',
        INVALID_PRODUCT_CONTEXT: 'This product cannot be purchased for an event.',
        EVENT_UNAVAILABLE: 'The event is not found or not managed by you.',
      };
      return result.error
        ? res.status(422).json({ code: result.error, error: messages[result.error] })
        : res.status(201).json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to create platform order.' });
    }
  });
  app.post(
    '/api/platform/orders/:id/checkout',
    authenticate,
    requireVerifiedUser,
    async (req, res) => {
      const orderId = Number(req.params.id);
      const successUrl =
        typeof req.body.successUrl === 'string'
          ? req.body.successUrl
          : `${config.site.siteUrl}/billing/success`;
      const cancelUrl =
        typeof req.body.cancelUrl === 'string'
          ? req.body.cancelUrl
          : `${config.site.siteUrl}/billing`;
      if (
        !Number.isInteger(orderId) ||
        orderId < 1 ||
        !sameSiteUrl(successUrl) ||
        !sameSiteUrl(cancelUrl)
      )
        return res.status(422).json({ error: 'Platform checkout is invalid.' });
      if (!stripe.configured())
        return res.status(503).json({
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          error: 'Platform payments are not configured.',
        });
      try {
        await ensureTable();
        if (!(await queries.platformBillingProfileReady()))
          return res.status(422).json({
            code: 'PLATFORM_BILLING_INCOMPLETE',
            error: 'Platform billing is not configured yet.',
          });
        const order = await queries.platformOrderForBuyer(orderId, req.user.id, req.user.role);
        if (!order) return res.status(404).json({ error: 'Platform order not found.' });
        if (order.product?.productType === 'subscription')
          return res.status(409).json({
            code: 'USE_SUBSCRIPTION_CHECKOUT',
            error: 'Use the Subscribe page for subscriptions.',
          });
        if (order.paymentStatus !== 'pending')
          return res.status(409).json({ error: 'This platform order is no longer payable.' });
        const checkout = await stripe.createPlatformCheckout({ order, successUrl, cancelUrl });
        await queries.attachPlatformProviderPayment(order.id, 'stripe', checkout.id);
        return res.status(201).json({
          orderId: order.id,
          checkoutUrl: checkout.url,
          publishableKey: stripe.publishableKey,
        });
      } catch (error) {
        console.error('Stripe platform checkout creation failed:', error.message);
        return res.status(502).json({ error: 'Unable to start platform checkout.' });
      }
    },
  );
  app.get('/api/platform/subscriptions', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.platformSubscriptions(req.user.id, req.user.role));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load subscriptions.' });
    }
  });
  app.post('/api/platform/subscriptions/:id/cancel', authenticate, async (req, res) => {
    const subscriptionId = Number(req.params.id);
    if (!Number.isInteger(subscriptionId) || subscriptionId < 1)
      return res.status(422).json({ error: 'A valid subscription is required.' });
    try {
      await ensureTable();
      const subscription = await queries.subscriptionForViewer(
        subscriptionId,
        req.user.id,
        req.user.role,
      );
      if (!subscription) return res.status(404).json({ error: 'Subscription not found.' });
      if (subscription.provider === 'stripe' && subscription.providerSubscriptionId) {
        if (!stripe.configured())
          return res.status(503).json({
            code: 'PAYMENT_PROVIDER_UNAVAILABLE',
            error: 'Platform payments are not configured.',
          });
        await stripe.cancelSubscriptionAtPeriodEnd(subscription.providerSubscriptionId);
      }
      await queries.markSubscriptionCancellation(subscriptionId);
      return res.json({ id: subscriptionId, cancelAtPeriodEnd: true });
    } catch (error) {
      console.error('Subscription cancellation failed:', error.message);
      return res.status(502).json({ error: 'Unable to cancel subscription.' });
    }
  });
}
