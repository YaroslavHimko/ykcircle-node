export function registerBillingInvoicesRoutes(
  app,
  {
    authenticate,
    ensureTable,
    queries,
    downloadInvoicePdf,
    testPaymentsEnabled,
    requireVenueOwner,
  },
) {
  app.get('/api/invoices', authenticate, async (req, res) => {
    const venueId =
      req.query.venueId == null || req.query.venueId === '' ? null : Number(req.query.venueId);
    if (venueId !== null && (!Number.isInteger(venueId) || venueId < 1))
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      return res.json(await queries.invoicesForViewer(req.user.id, req.user.role, { venueId }));
    } catch (error) {
      console.error('Invoice list failed:', error.message);
      return res.status(500).json({ error: 'Unable to load invoices.' });
    }
  });
  app.get('/api/invoices/:id', authenticate, async (req, res) => {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId < 1)
      return res.status(422).json({ error: 'A valid invoice id is required.' });
    try {
      await ensureTable();
      const invoice = await queries.invoice(invoiceId, req.user.id, req.user.role);
      return invoice
        ? res.json(invoice)
        : res.status(403).json({ error: 'Invoice not found or not available to you.' });
    } catch (error) {
      console.error('Invoice lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load invoice.' });
    }
  });
  app.get('/api/invoices/:id/download', authenticate, downloadInvoicePdf);
  app.get('/api/invoices/:id/pdf', authenticate, downloadInvoicePdf);
  app.post('/api/test-payments', authenticate, async (req, res) => {
    if (!testPaymentsEnabled)
      return res.status(404).json({ error: 'Test payments are unavailable.' });
    const invoiceId = Number(req.body.invoiceId);
    const outcome = String(req.body.outcome || 'succeeded');
    if (!Number.isInteger(invoiceId) || invoiceId < 1 || !['succeeded', 'failed'].includes(outcome))
      return res.status(422).json({ error: 'A valid invoice and test outcome are required.' });
    try {
      await ensureTable();
      const result = await queries.simulatePayment(
        invoiceId,
        req.user.id,
        req.user.role,
        outcome === 'succeeded',
      );
      if (result?.error === 'INVALID_STATE')
        return res.status(409).json({ error: 'Only issued invoices can be simulated.' });
      if (!result)
        return res.status(403).json({ error: 'Invoice not found or not available to you.' });
      return res.status(201).json(result);
    } catch (error) {
      console.error('Test payment simulation failed:', error.message);
      return res.status(500).json({ error: 'Unable to simulate payment.' });
    }
  });
  app.post('/api/invoices/:id/mark-paid', authenticate, requireVenueOwner, async (req, res) => {
    const invoiceId = Number(req.params.id);
    const paymentMethod = String(req.body.paymentMethod || '');
    const paymentReference =
      req.body.paymentReference == null ? null : String(req.body.paymentReference).trim() || null;
    const paidDate =
      req.body.paidDate == null || req.body.paidDate === '' ? null : String(req.body.paidDate);
    const internalNote =
      req.body.internalNote == null ? null : String(req.body.internalNote).trim() || null;
    if (
      !Number.isInteger(invoiceId) ||
      invoiceId < 1 ||
      !['bank_transfer', 'bankgiro', 'plusgiro', 'swish', 'cash', 'other'].includes(
        paymentMethod,
      ) ||
      paymentReference?.length > 255 ||
      (paidDate && !/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) ||
      internalNote?.length > 5000 ||
      req.body.confirmReceived !== true
    )
      return res.status(422).json({
        error: 'Confirm receipt and provide a valid payment date, method, and optional reference.',
      });
    try {
      await ensureTable();
      const result = await queries.markInvoicePaid(invoiceId, req.user.id, req.user.role, {
        paymentMethod,
        paymentReference,
        paidDate,
        internalNote,
      });
      if (result?.error === 'INVALID_STATE')
        return res.status(409).json({ error: 'Only issued invoices can be marked paid.' });
      if (!result)
        return res.status(403).json({ error: 'Invoice not found or not available to you.' });
      return res.json({ id: invoiceId, status: 'paid', paymentSource: 'confirmed_by_venue' });
    } catch (error) {
      console.error('Invoice payment update failed:', error.message);
      return res.status(500).json({ error: 'Unable to mark invoice paid.' });
    }
  });
}
