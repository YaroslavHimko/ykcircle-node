import crypto from 'node:crypto';
import { renderInvoicePdf } from '../../../services/billing/invoice-pdf.js';

export function registerVenuesBookingsRoutes(
  app,
  { authenticate, ensureTable, queries, eventFitsVenueAvailability, requireVenueOwner },
) {
  app.post('/api/events/:id/venue-booking', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    const venueId = Number(req.body.venueId);
    if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'Valid eventId and venueId values are required.' });
    try {
      await ensureTable();
      const context = await queries.venueBookingContext(
        eventId,
        venueId,
        req.user.id,
        req.user.role,
      );
      if (context.error === 'EVENT_NOT_FOUND')
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      if (context.error === 'VENUE_NOT_FOUND')
        return res.status(404).json({ error: 'Venue not found or inactive.' });
      const availability = await eventFitsVenueAvailability(context.event, context.venue);
      if (availability.error)
        return res.status(availability.unavailable ? 409 : 422).json({ error: availability.error });
      const result = await queries.requestVenueBooking(
        eventId,
        venueId,
        context.event.managerId,
        req.user.role,
        req.body.buyerBillingProfileId,
      );
      if (result.error === 'EVENT_ALREADY_BOOKED')
        return res.status(409).json({ error: 'This event already has an active venue booking.' });
      if (result.error === 'VENUE_UNAVAILABLE')
        return res.status(409).json({ error: 'The venue is already booked for this time.' });
      if (result.error === 'BILLING_PROFILE_REQUIRED')
        return res.status(422).json({
          code: result.error,
          error: 'Add billing details before requesting this paid venue.',
        });
      if (result.error === 'BILLING_PROFILE_UNAVAILABLE')
        return res.status(422).json({
          code: result.error,
          error: 'This billing profile is no longer available to your account.',
        });
      if (result.error) return res.status(404).json({ error: 'Event or venue not found.' });
      return res
        .status(201)
        .json(await queries.eventVenueBooking(eventId, req.user.id, req.user.role));
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({
          code: error.code,
          error: error.message,
          owner: error.owner,
          subscribeUrl: error.subscribeUrl,
        });
      console.error('Venue booking request failed:', error.message);
      return res.status(500).json({ error: 'Unable to request venue booking.' });
    }
  });
  app.get('/api/events/:id/venue-booking', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const booking = await queries.eventVenueBooking(req.params.id, req.user.id, req.user.role);
      return booking
        ? res.json(booking)
        : res.status(404).json({ error: 'Venue booking not found or not available to you.' });
    } catch (error) {
      console.error('Venue booking lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue booking.' });
    }
  });
  app.get('/api/venue-bookings/:id/billing-readiness', authenticate, async (req, res) => {
    const bookingId = Number(req.params.id);
    if (!Number.isInteger(bookingId) || bookingId < 1)
      return res.status(422).json({ error: 'A valid booking id is required.' });
    try {
      await ensureTable();
      if (!(await queries.canAccessVenueBooking(bookingId, req.user.id, req.user.role)))
        return res.status(403).json({ error: 'This booking is not available to you.' });
      const readiness = await queries.getVenueBookingBillingReadiness(bookingId);
      return readiness
        ? res.json(readiness)
        : res.status(404).json({ error: 'Booking not found.' });
    } catch (error) {
      console.error('Booking billing readiness lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to check booking billing readiness.' });
    }
  });
  app.get('/api/venue-bookings/:id/external-invoice', authenticate, async (req, res) => {
    const bookingId = Number(req.params.id);
    if (!Number.isInteger(bookingId) || bookingId < 1)
      return res.status(422).json({ error: 'A valid booking id is required.' });
    try {
      await ensureTable();
      const invoice = await queries.externalInvoice(bookingId, req.user.id, req.user.role);
      return invoice
        ? res.json(invoice)
        : res.status(404).json({ error: 'External invoice not found or not available to you.' });
    } catch (error) {
      console.error('External invoice lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load the external invoice.' });
    }
  });
  app.patch('/api/venue-bookings/:id/buyer-billing-profile', authenticate, async (req, res) => {
    const bookingId = Number(req.params.id);
    const buyerBillingProfileId = Number(req.body.buyerBillingProfileId);
    if (
      !Number.isInteger(bookingId) ||
      bookingId < 1 ||
      !Number.isInteger(buyerBillingProfileId) ||
      buyerBillingProfileId < 1
    )
      return res.status(422).json({ error: 'Choose a valid buyer Billing Profile.' });
    try {
      await ensureTable();
      const result = await queries.updateVenueBookingBuyerBillingProfile(
        bookingId,
        req.user.id,
        req.user.role,
        buyerBillingProfileId,
      );
      if (result?.error === 'BUYER_PROFILE_INCOMPLETE')
        return res.status(422).json({
          code: result.error,
          missing: result.missing || [],
          error: 'Complete the selected buyer Billing Profile before using it for this Venue.',
        });
      if (result?.error === 'BILLING_PROFILE_UNAVAILABLE')
        return res
          .status(422)
          .json({ code: result.error, error: 'This Billing Profile is not available to you.' });
      if (result?.error)
        return res.status(409).json({
          code: result.error,
          error: 'Only the event organizer can update a requested booking.',
        });
      return res.json({
        booking: await queries.eventVenueBooking(result.eventId, req.user.id, req.user.role),
      });
    } catch (error) {
      console.error('Venue booking buyer Billing Profile update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update the booking buyer.' });
    }
  });
  app.put(
    '/api/venue-bookings/:id/external-invoice',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const bookingId = Number(req.params.id);
      const externalInvoiceNumber =
        req.body.externalInvoiceNumber == null
          ? null
          : String(req.body.externalInvoiceNumber).trim() || null;
      const externalInvoiceDate =
        req.body.externalInvoiceDate == null || req.body.externalInvoiceDate === ''
          ? null
          : String(req.body.externalInvoiceDate);
      const amount =
        req.body.amount == null || req.body.amount === '' ? null : Number(req.body.amount);
      const currency =
        req.body.currency == null || req.body.currency === ''
          ? null
          : String(req.body.currency).toUpperCase();
      const dueDate =
        req.body.dueDate == null || req.body.dueDate === '' ? null : String(req.body.dueDate);
      const externalInvoiceUrl =
        req.body.externalInvoiceUrl == null || req.body.externalInvoiceUrl === ''
          ? null
          : String(req.body.externalInvoiceUrl).trim();
      const validUrl =
        !externalInvoiceUrl ||
        (() => {
          try {
            return new URL(externalInvoiceUrl).protocol === 'https:';
          } catch {
            return false;
          }
        })();
      if (
        !Number.isInteger(bookingId) ||
        bookingId < 1 ||
        externalInvoiceNumber?.length > 120 ||
        (externalInvoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(externalInvoiceDate)) ||
        (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) ||
        (amount !== null && (!Number.isFinite(amount) || amount < 0)) ||
        (currency && !/^[A-Z]{3}$/.test(currency)) ||
        !validUrl ||
        externalInvoiceUrl?.length > 2048
      )
        return res.status(422).json({ error: 'External invoice details are invalid.' });
      try {
        await ensureTable();
        const result = await queries.saveExternalInvoice(bookingId, req.user.id, req.user.role, {
          externalInvoiceNumber,
          externalInvoiceDate,
          amount,
          currency,
          dueDate,
          externalInvoiceUrl,
        });
        if (result?.error === 'INVALID_MODE')
          return res.status(409).json({ error: 'This Venue uses YKCircle-generated invoices.' });
        if (result?.error)
          return res.status(403).json({ error: 'This booking is not managed by you.' });
        return res.json(result);
      } catch (error) {
        if (error.status && error.code)
          return res.status(error.status).json({
            code: error.code,
            error: error.message,
            owner: error.owner,
            subscribeUrl: error.subscribeUrl,
          });
        console.error('External invoice update failed:', error.message);
        return res.status(500).json({ error: 'Unable to save the external invoice.' });
      }
    },
  );
  app.post(
    '/api/venue-bookings/:id/external-invoice/mark-paid',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const bookingId = Number(req.params.id);
      if (!Number.isInteger(bookingId) || bookingId < 1 || req.body.confirmReceived !== true)
        return res.status(422).json({ error: 'Confirm that the Venue received this payment.' });
      try {
        await ensureTable();
        return (await queries.markExternalInvoicePaid(bookingId, req.user.id, req.user.role))
          ? res.json({ bookingId, status: 'paid', paymentSource: 'confirmed_by_venue' })
          : res.status(403).json({ error: 'External invoice not found or not managed by you.' });
      } catch (error) {
        console.error('External invoice payment update failed:', error.message);
        return res.status(500).json({ error: 'Unable to mark the external invoice paid.' });
      }
    },
  );
  app.post('/api/events/:id/venue-booking/cancel', authenticate, async (req, res) => {
    try {
      await ensureTable();
      if (!(await queries.cancelVenueBooking(req.params.id, req.user.id, req.user.role)))
        return res
          .status(404)
          .json({ error: 'Active venue booking not found or not managed by you.' });
      return res.json({ message: 'Venue booking cancelled.' });
    } catch (error) {
      console.error('Venue booking cancellation failed:', error.message);
      return res.status(500).json({ error: 'Unable to cancel venue booking.' });
    }
  });
  app.patch('/api/venue-bookings/:id', authenticate, requireVenueOwner, async (req, res) => {
    const bookingId = Number(req.params.id);
    const status = String(req.body.status || '');
    const ownerNote = req.body.ownerNote == null ? null : String(req.body.ownerNote).trim() || null;
    if (
      !Number.isInteger(bookingId) ||
      bookingId < 1 ||
      !['confirmed', 'declined'].includes(status)
    )
      return res
        .status(422)
        .json({ error: 'A booking id and status of confirmed or declined are required.' });
    try {
      await ensureTable();
      const result = await queries.reviewVenueBooking(
        bookingId,
        req.user.id,
        req.user.role,
        status,
        ownerNote,
      );
      if (result?.error === 'CONFLICT')
        return res.status(409).json({ error: 'The venue is already occupied for this time.' });
      if (['SELLER_PROFILE_INCOMPLETE', 'FINANCIAL_SETUP_INCOMPLETE'].includes(result?.error))
        return res.status(422).json({
          code: result.error,
          missing: result.missing || [],
          error: 'Complete the Venue invoicing setup before approving this paid booking.',
        });
      if (result?.error === 'BUYER_PROFILE_INCOMPLETE')
        return res.status(422).json({
          code: result.error,
          error: 'Select who is paying for this Venue before approval.',
        });
      if (result?.error === 'BILLING_PERMISSION_REQUIRED')
        return res.status(403).json({
          code: result.error,
          error:
            'Organization owner or billing admin permission is required to issue this invoice.',
        });
      if (
        ['PRICE_NOT_CONFIGURED', 'INVALID_BOOKING_INTERVAL', 'INVALID_TAX_CONFIGURATION'].includes(
          result?.error,
        )
      )
        return res.status(422).json({
          code: result.error,
          error: 'The authoritative booking price or tax configuration is incomplete.',
        });
      if (!result)
        return res
          .status(404)
          .json({ error: 'Pending venue booking not found or not managed by you.' });
      let warning = result.warning || null;
      if (result.invoiceId) {
        try {
          const invoice = await queries.invoice(result.invoiceId, req.user.id, req.user.role);
          const pdf = renderInvoicePdf(invoice);
          await queries.storeInvoiceDocument(
            result.invoiceId,
            pdf,
            crypto.createHash('sha256').update(pdf).digest('hex'),
          );
        } catch (pdfError) {
          warning = 'INVOICE_DOCUMENT_GENERATION_FAILED';
          await queries.markVenueInvoiceGenerationFailed(bookingId, pdfError.message);
        }
      }
      return res.json({
        id: bookingId,
        status,
        ownerNote,
        invoiceId: result.invoiceId || null,
        externalInvoiceId: result.externalInvoiceId || null,
        invoiceMode: result.invoiceMode || null,
        invoiceGenerationStatus: warning ? 'failed' : 'succeeded',
        warning,
      });
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({
          code: error.code,
          error: error.message,
          owner: error.owner,
          subscribeUrl: error.subscribeUrl,
        });
      console.error('Venue booking review failed:', error.message);
      return res.status(500).json({ error: 'Unable to review venue booking.' });
    }
  });
  app.get('/api/venue-bookings/:id/messages', authenticate, async (req, res) => {
    const bookingId = Number(req.params.id);
    if (!Number.isInteger(bookingId) || bookingId < 1)
      return res.status(422).json({ error: 'A valid booking id is required.' });
    try {
      await ensureTable();
      const messages = await queries.venueBookingMessages(bookingId, req.user.id, req.user.role);
      return messages === null
        ? res.status(403).json({ error: 'This booking conversation is not available to you.' })
        : res.json(messages);
    } catch (error) {
      console.error('Venue booking messages lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load booking messages.' });
    }
  });
  app.post('/api/venue-bookings/:id/messages', authenticate, async (req, res) => {
    const bookingId = Number(req.params.id);
    const body = String(req.body.body || '').trim();
    if (!Number.isInteger(bookingId) || bookingId < 1 || !body || body.length > 5000)
      return res
        .status(422)
        .json({ error: 'A booking id and message of up to 5,000 characters are required.' });
    try {
      await ensureTable();
      const message = await queries.createVenueBookingMessage(
        bookingId,
        req.user.id,
        req.user.role,
        body,
      );
      return message
        ? res.status(201).json(message)
        : res.status(403).json({ error: 'This booking conversation is not available to you.' });
    } catch (error) {
      console.error('Venue booking message creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to send booking message.' });
    }
  });
}
