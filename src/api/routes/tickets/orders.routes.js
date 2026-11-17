export function registerTicketsOrdersRoutes(
  app,
  { authenticate, ensureTable, queries, ticketSales, stripe, database },
) {
  app.get('/api/me/tickets', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.ticketOrdersForAttendee(req.user.id));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load tickets.' });
    }
  });
  app.get('/api/ticket-orders/:id', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid ticket order is required.' });
    try {
      await ensureTable();
      const order = await queries.ticketOrder(id, req.user.id, req.user.role);
      res.set('Cache-Control', 'private, no-store');
      return order
        ? res.json(await ticketSales.details(order))
        : res.status(404).json({ error: 'Ticket order not found or not available to you.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load ticket order.' });
    }
  });
  app.post('/api/ticket-orders/:id/confirm', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid ticket order is required.' });
    try {
      await ensureTable();
      const order = await queries.ticketOrder(id, req.user.id, req.user.role);
      if (!order || Number(order.attendeeUserId) !== Number(req.user.id))
        return res.status(404).json({ error: 'Ticket order not found.' });
      if (!stripe.configured())
        return res.status(503).json({ error: 'Ticket payments are not configured.' });
      await ticketSales.confirm(id);
      res.set('Cache-Control', 'private, no-store');
      return res.json(
        await ticketSales.details(await queries.ticketOrder(id, req.user.id, req.user.role)),
      );
    } catch (error) {
      console.error('Ticket confirmation failed:', error.message);
      return res.status(502).json({
        error:
          'Payment confirmation is still pending. Your tickets will be emailed after Stripe confirms payment.',
      });
    }
  });
  app.post('/api/ticket-orders/:id/resend', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1)
      return res.status(422).json({ error: 'A valid ticket order is required.' });
    try {
      await ensureTable();
      const order = await queries.ticketOrder(id, req.user.id, req.user.role);
      if (!order || Number(order.attendeeUserId) !== Number(req.user.id))
        return res.status(404).json({ error: 'Ticket order not found.' });
      if (order.paymentStatus !== 'paid')
        return res.status(409).json({ error: 'Only paid tickets can be emailed.' });
      const [result] = await database.execute(
        `UPDATE ticket_email_deliveries SET sent_at=NULL,next_attempt_at=NOW()
          WHERE ticket_order_id=? AND sent_at<DATE_SUB(NOW(),INTERVAL 5 MINUTE)`,
        [id],
      );
      if (!result.affectedRows)
        return res.status(429).json({
          error: 'Your email is already queued or was sent recently. Please wait five minutes.',
        });
      await ticketSales.deliver(id);
      return res.json({ message: 'Your ticket email has been queued.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to resend tickets.' });
    }
  });
  for (const action of ['checkout', 'cancel'])
    app.post(`/api/ticket-orders/:id/${action}`, authenticate, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1)
        return res.status(422).json({ error: 'A valid ticket order is required.' });
      try {
        await ensureTable();
        const order = await ticketSales.checkoutOrder(id);
        if (!order || Number(order.attendeeUserId) !== Number(req.user.id))
          return res.status(404).json({ error: 'Ticket order not found.' });
        if (order.paymentStatus !== 'pending' || !order.checkoutSessionId)
          return res
            .status(409)
            .json({ error: 'No open Stripe checkout is available for this order.' });
        if (!stripe.configured())
          return res.status(503).json({ error: 'Ticket payments are not configured.' });
        const session = await stripe.checkoutSession(
          order.checkoutSessionId,
          order.providerAccountId,
        );
        if (action === 'checkout' && session.status === 'open')
          return res.json({ checkoutUrl: session.url });
        if (action === 'cancel' && session.status === 'open') {
          // Expire at Stripe before releasing stock, so the old payment link cannot charge later.
          await stripe.stripeClient.checkout.sessions.expire(
            session.id,
            {},
            { stripeAccount: order.providerAccountId },
          );
        }
        await ticketSales.confirm(id);
        return res.json({ message: 'Order status updated.' });
      } catch (error) {
        return res
          .status(502)
          .json({ error: 'Unable to update checkout. Refresh payment status and try again.' });
      }
    });
  app.post('/api/ticket-orders/:id/refunds', authenticate, async (req, res) => {
    const orderId = Number(req.params.id);
    const amount =
      req.body.amount == null || req.body.amount === '' ? null : Number(req.body.amount);
    if (
      !Number.isInteger(orderId) ||
      orderId < 1 ||
      (amount !== null && (!Number.isFinite(amount) || amount <= 0))
    )
      return res.status(422).json({ error: 'Refund request is invalid.' });
    if (!stripe.configured())
      return res.status(503).json({
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        error: 'Ticket payments are not configured.',
      });
    try {
      await ensureTable();
      const order = await queries.ticketRefundContext(orderId, req.user.id, req.user.role);
      if (!order || order.provider !== 'stripe')
        return res.status(404).json({ error: 'Ticket order not found or not managed by you.' });
      if (order.paymentStatus !== 'paid' || !order.providerPaymentId)
        return res.status(409).json({ error: 'Only a paid ticket order can be refunded.' });
      if (amount !== null && amount > Number(order.totalAmount))
        return res.status(422).json({ error: 'Refund amount exceeds the ticket order total.' });
      const refund = await stripe.createDirectRefund(
        order.providerPaymentId,
        order.providerAccountId,
        amount === null ? null : Math.round(amount * 100),
      );
      return res.status(202).json({ refundId: refund.id, status: refund.status });
    } catch (error) {
      console.error('Stripe direct refund creation failed:', error.message);
      return res.status(502).json({ error: 'Unable to create organizer refund.' });
    }
  });
}
