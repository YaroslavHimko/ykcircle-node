export function registerTicketsCheckoutRoutes(
  app,
  {
    authenticate,
    ensureTable,
    queries,
    requireManager,
    stripe,
    requireVerifiedUser,
    refreshStripeAccount,
    config,
    ticketSales,
  },
) {
  app.get('/api/events/:id/payment-settings', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid event id is required.' });
    try {
      await ensureTable();
      const settings = await queries.eventPaymentSettings(id, req.user.id, req.user.role);
      return settings
        ? res.json(settings)
        : res.json({
            eventId: id,
            sellerBillingProfileId: null,
            paymentAccountId: null,
            paymentsEnabled: false,
            ticketSalesEnabled: false,
          });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event payment settings.' });
    }
  });
  app.get('/api/events/:id/financial-readiness', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid event id is required.' });
    try {
      await ensureTable();
      return res.json(await queries.eventFinancialReadiness(id, req.user.id, req.user.role));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event financial readiness.' });
    }
  });
  app.put('/api/events/:id/payment-settings', authenticate, requireManager, async (req, res) => {
    const id = Number(req.params.id);
    const sellerBillingProfileId =
      req.body.sellerBillingProfileId == null || req.body.sellerBillingProfileId === ''
        ? null
        : Number(req.body.sellerBillingProfileId);
    const paymentAccountId =
      req.body.paymentAccountId == null || req.body.paymentAccountId === ''
        ? null
        : Number(req.body.paymentAccountId);
    const sellerCapacity =
      req.body.sellerCapacity == null || req.body.sellerCapacity === ''
        ? null
        : String(req.body.sellerCapacity);
    const currency = req.body.currency ? String(req.body.currency).toUpperCase() : null;
    const refundPolicy = req.body.refundPolicy == null ? null : req.body.refundPolicy;
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      (sellerBillingProfileId !== null &&
        (!Number.isInteger(sellerBillingProfileId) || sellerBillingProfileId < 1)) ||
      (paymentAccountId !== null &&
        (!Number.isInteger(paymentAccountId) || paymentAccountId < 1)) ||
      (sellerCapacity !== null && !['trader', 'private'].includes(sellerCapacity)) ||
      (currency && !/^[A-Z]{3}$/.test(currency)) ||
      (refundPolicy !== null && (typeof refundPolicy !== 'object' || Array.isArray(refundPolicy)))
    )
      return res.status(422).json({ error: 'Payment settings are invalid.' });
    try {
      await ensureTable();
      const result = await queries.saveEventPaymentSettings(id, req.user.id, req.user.role, {
        sellerBillingProfileId,
        paymentAccountId,
        sellerCapacity,
        currency,
        refundPolicy,
        paymentsEnabled: Boolean(req.body.paymentsEnabled),
        ticketSalesEnabled: Boolean(req.body.ticketSalesEnabled),
      });
      const messages = {
        EVENT_NOT_FOUND: 'Event not found or not managed by you.',
        SELLER_PROFILE_UNAVAILABLE: 'This billing profile is no longer available to your account.',
        PAYMENT_ACCOUNT_MISMATCH:
          'The payment account must belong to the selected seller billing profile.',
        PAYMENT_ACCOUNT_NOT_READY: 'Complete payment setup before starting ticket sales.',
        PAYMENT_SETUP_REQUIRED:
          'Select a seller billing profile and ready payment account before starting ticket sales.',
        SELLER_CAPACITY_REQUIRED:
          'Choose whether you are selling as a trader or a private individual before starting ticket sales.',
      };
      return result?.error
        ? res
            .status(result.error === 'EVENT_NOT_FOUND' ? 404 : 422)
            .json({ code: result.error, error: messages[result.error] })
        : res.json(result);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to save event payment settings.' });
    }
  });
  app.get('/api/events/:id/ticket-types', async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(422).json({ error: 'A valid event id is required.' });
    try {
      await ensureTable();
      if (!(await queries.ticketCheckoutContext(eventId)))
        return res
          .status(404)
          .json({ error: 'Paid ticket sales are not available for this event.' });
      return res.json(await queries.ticketTypes(eventId, { publicOnly: true }));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load ticket types.' });
    }
  });
  app.get('/api/events/:id/ticket-types/manage', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(422).json({ error: 'A valid event id is required.' });
    try {
      await ensureTable();
      const tickets = await queries.managedTicketTypes(eventId, req.user.id, req.user.role);
      return tickets === null
        ? res.status(404).json({ error: 'Event not found or not managed by you.' })
        : res.json(tickets);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load ticket types.' });
    }
  });
  app.get('/api/events/:id/ticket-checkout', async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(422).json({ error: 'A valid event id is required.' });
    try {
      await ensureTable();
      const context = await queries.ticketCheckoutContext(eventId);
      if (!context)
        return res.status(404).json({
          error:
            'Ticket sales are not open yet. The organizer must finish payment setup and open ticket sales.',
        });
      if (!stripe.configured())
        return res.status(503).json({
          error: 'Ticket payments are not configured. Set STRIPE_SECRET_KEY on the API server.',
        });
      return res.json({
        eventId,
        title: context.title,
        currency: context.paymentCurrency || context.currency,
        seller: { legalName: context.seller.legalName, capacity: context.seller.capacity },
        refundPolicy: context.refundPolicy,
        tickets: await queries.ticketTypes(eventId, { publicOnly: true }),
        paymentProvider: 'stripe',
        testMode: stripe.testMode(),
      });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load ticket checkout.' });
    }
  });
  app.post('/api/events/:id/ticket-types', authenticate, requireManager, async (req, res) => {
    const eventId = Number(req.params.id);
    const ticket = {
      name: String(req.body.name || '').trim(),
      description:
        req.body.description == null ? null : String(req.body.description).trim() || null,
      price: Number(req.body.price),
      currency: String(req.body.currency || '').toUpperCase(),
      quantityAvailable:
        req.body.quantityAvailable == null || req.body.quantityAvailable === ''
          ? null
          : Number(req.body.quantityAvailable),
      salesStartAt: req.body.salesStartAt || null,
      salesEndAt: req.body.salesEndAt || null,
      isActive: req.body.isActive !== false,
    };
    if (
      !Number.isInteger(eventId) ||
      eventId < 1 ||
      !ticket.name ||
      ticket.name.length > 160 ||
      !Number.isFinite(ticket.price) ||
      ticket.price < 0 ||
      !/^[A-Z]{3}$/.test(ticket.currency) ||
      (ticket.quantityAvailable !== null &&
        (!Number.isInteger(ticket.quantityAvailable) || ticket.quantityAvailable < 1))
    )
      return res.status(422).json({ error: 'Ticket type is invalid.' });
    try {
      await ensureTable();
      const result = await queries.saveTicketType(
        eventId,
        req.user.id,
        req.user.role,
        null,
        ticket,
      );
      return result
        ? res.status(201).json(result)
        : res.status(404).json({ error: 'Event not found or not managed by you.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to save ticket type.' });
    }
  });
  app.post(
    '/api/events/:id/ticket-checkout',
    authenticate,
    requireVerifiedUser,
    async (req, res) => {
      const eventId = Number(req.params.id);
      const selections = Array.isArray(req.body.items) ? req.body.items : [];
      const checkoutKey = String(req.body.checkoutKey || '');
      if (
        !Number.isInteger(eventId) ||
        eventId < 1 ||
        !selections.length ||
        selections.length > 10 ||
        selections.some(
          (item) =>
            !item ||
            !Number.isInteger(item.ticketTypeId) ||
            item.ticketTypeId < 1 ||
            !Number.isInteger(item.quantity) ||
            item.quantity < 1 ||
            item.quantity > 20,
        ) ||
        !/^[a-zA-Z0-9_-]{16,100}$/.test(checkoutKey)
      )
        return res.status(422).json({ error: 'Choose valid tickets and retry checkout.' });
      if (!stripe.configured())
        return res.status(503).json({
          code: 'PAYMENT_PROVIDER_UNAVAILABLE',
          error: 'Set STRIPE_SECRET_KEY on the API server to enable ticket payments.',
        });
      try {
        await ensureTable();
        const context = await queries.ticketCheckoutContext(eventId);
        if (!context || context.provider !== 'stripe')
          return res.status(422).json({
            code: 'PAYMENT_SETUP_REQUIRED',
            error: 'Ticket payments are not available for this event.',
          });
        const seller = await refreshStripeAccount(context.providerAccountId);
        if (!seller.charges_enabled)
          return res.status(422).json({
            error: 'The organizer must complete Stripe onboarding before selling tickets.',
          });
        const order = await queries.createTicketOrder(
          eventId,
          { userId: req.user.id, email: req.user.email },
          selections,
          checkoutKey,
        );
        if (order.error)
          return res.status(422).json({
            code: order.error,
            error:
              'Selected tickets are unavailable or sales have ended. Refresh and choose available tickets.',
          });
        if (order.paymentStatus !== 'pending')
          return res.status(409).json({
            error:
              'This checkout is already completed or expired. Check My tickets before starting another purchase.',
            orderId: order.id,
          });
        // Return destinations are generated by the server and contain only this buyer's order.
        const successUrl = `${config.site.siteUrl}/tickets/${order.id}?checkout=success`;
        const cancelUrl = `${config.site.siteUrl}/tickets/${order.id}?checkout=cancelled`;
        const existing = await ticketSales.checkoutOrder(order.id);
        const checkout = existing?.checkoutSessionId
          ? await stripe.checkoutSession(existing.checkoutSessionId, existing.providerAccountId)
          : await stripe.createDirectCheckout({ order, context, successUrl, cancelUrl });
        if (!checkout.url || checkout.status === 'expired')
          return res.status(409).json({ error: 'Checkout has expired. Start a new purchase.' });
        await ticketSales.attachCheckout(order.id, checkout);
        return res.status(201).json({
          orderId: order.id,
          orderNumber: order.orderNumber,
          checkoutUrl: checkout.url,
          testMode: stripe.testMode(),
        });
      } catch (error) {
        console.error('Stripe ticket checkout failed:', error.message);
        return res.status(502).json({
          error: stripe.testMode()
            ? 'Unable to start test checkout. Check the sandbox API key, connected account onboarding, and ticket currency on the server.'
            : 'Unable to start ticket checkout. Please try again.',
        });
      }
    },
  );
}
