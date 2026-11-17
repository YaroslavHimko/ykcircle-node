export function registerSubscriptionsProductAccessRoutes(app, { ensureTable, subscriptions }) {
  app.use('/api', async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
    const path = req.path.replace(/\/+$/, '').toLowerCase(),
      body = req.body || {};
    const eventWrite = /^\/(?:groups\/[^/]+\/)?events(?:\/[^/]+)?(?:\/drafts)?$/.test(path);
    const ticketWrite = /^\/events\/[^/]+\/(?:payment-settings|ticket-types|ticket-checkout)$/.test(
      path,
    );
    const resumeCheckout = /^\/ticket-orders\/[^/]+\/checkout$/.test(path);
    const venueWrite = /^\/venues(?:\/[^/]+)?(?:\/booking-settings)?$/.test(path);
    try {
      if (/^\/platform\/orders(?:\/[^/]+\/checkout)?$/.test(path)) {
        await ensureTable();
        if (!(await subscriptions.access.configuration()).paidServicesEnabled)
          return res.status(403).json({
            code: 'PAID_SERVICES_DISABLED',
            error: 'Paid platform services are currently disabled.',
          });
      }
      if (
        resumeCheckout ||
        (eventWrite && (body.pricingType === 'paid' || Number(body.fee) > 0)) ||
        (ticketWrite &&
          (Number(body.price) > 0 ||
            body.paymentsEnabled ||
            body.ticketSalesEnabled ||
            path.endsWith('/ticket-checkout')))
      ) {
        await ensureTable();
        await subscriptions.access.requirePaidFeature('paidEventsEnabled');
      }
      if (
        venueWrite &&
        ['priceFrom', 'hourlyRate', 'dailyRate'].some((key) => Number(body[key]) > 0)
      ) {
        await ensureTable();
        await subscriptions.access.requirePaidFeature('paidVenuesEnabled');
      }
      return next();
    } catch (error) {
      return res.status(error.status || 503).json({
        code: error.code,
        error: error.status ? error.message : 'Product configuration is unavailable.',
      });
    }
  });
}
