export function registerPaymentWebhooks(
  app,
  { stripe, queries, ticketSales, subscriptions, refreshStripeAccount },
) {
  app.post('/api/payment-webhooks/stripe', async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = stripe.verifyWebhook(rawBody, req.get('stripe-signature'));
    if (!event) return res.status(400).json({ error: 'Invalid Stripe webhook signature.' });
    const object = event.data?.object;
    // Preserve legacy one-off platform orders, but never record misplaced
    // subscription events here: that would consume their reconciliation IDs.
    if (
      !event.account &&
      !object?.metadata?.platformOrderId &&
      !object?.metadata?.platform_order_id
    ) {
      return res
        .status(400)
        .json({ error: 'Use the subscription webhook endpoint for platform subscription events.' });
    }
    try {
      await queries.initialize();
      if (object?.metadata?.ticketOrderId && event.type.startsWith('checkout.session.')) {
        if (!event.account)
          return res.status(400).json({ error: 'A connected-account event is required.' });
        await ticketSales.confirm(Number(object.metadata.ticketOrderId), object.id, event.account);
        return res.json({ received: true });
      }
      await queries.processTicketProviderEvent({
        provider: 'stripe',
        providerEventId: event.id,
        eventType: event.type,
        payload: event,
      });
      return res.status(200).json({ received: true });
    } catch (error) {
      console.error('Stripe webhook processing failed:', error.message);
      return res.status(500).json({ error: 'Webhook processing failed.' });
    }
  });
  app.post('/api/payment-webhooks/stripe/subscriptions', async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = stripe.verifySubscriptionWebhook(rawBody, req.get('stripe-signature'));
    if (!event)
      return res.status(400).json({ error: 'Invalid Stripe subscription webhook signature.' });
    if (event.account)
      return res.status(400).json({ error: 'A platform-account event is required.' });
    try {
      await queries.initialize();
      await subscriptions.webhook(event);
      return res.json({ received: true });
    } catch (error) {
      console.error('Stripe subscription webhook processing failed:', error.message);
      return res.status(500).json({ error: 'Subscription webhook processing failed.' });
    }
  });
  app.post('/api/payment-webhooks/stripe/thin', async (req, res) => {
    const notification = stripe.verifyThinWebhook(req.body, req.get('stripe-signature'));
    if (!notification)
      return res.status(400).json({ error: 'Invalid Stripe thin event signature.' });
    try {
      const event = await stripe.stripeClient.v2.core.events.retrieve(notification.id);
      const accountId = event.related_object?.id;
      if (accountId && event.type.startsWith('v2.core.account')) {
        await queries.initialize();
        await refreshStripeAccount(accountId);
      }
      return res.json({ received: true });
    } catch (error) {
      console.error('Stripe account refresh failed:', error.message);
      return res.status(500).json({ error: 'Unable to refresh connected account.' });
    }
  });
}
