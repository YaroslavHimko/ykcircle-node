import { accessError } from '../../../domain/subscriptions/product-access.js';

export function registerEventsDraftsRoutes(
  app,
  {
    authenticate,
    requireVerifiedUser,
    creationGuards,
    createRichDraft,
    parseEventCover,
    ensureTable,
    queries,
    eventFtpService,
    utcDateTime,
    decorateEventImage,
    updateGuards,
    validateRichEvent,
    richEventData,
    bookingFailure,
    subscriptions,
    notifyGroupEventMembers,
    optionalAuthenticate,
    decorateEventImages,
  },
) {
  app.post('/api/events/drafts', authenticate, requireVerifiedUser, ...creationGuards, (req, res) =>
    createRichDraft(req, res),
  );
  app.post('/api/groups/:id/events/drafts', authenticate, ...creationGuards, (req, res) =>
    createRichDraft(req, res, req.params.id),
  );
  app.post('/api/events/:id/cover', authenticate, parseEventCover, async (req, res) => {
    if (!req.file)
      return res.status(400).json({ error: 'A JPEG, PNG, or WebP cover image is required.' });
    try {
      await ensureTable();
      const event = await queries.richEvent(req.params.id, req.user.id, req.user.role);
      if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' });
      const coverImage = await eventFtpService.uploadEventCover(req.params.id, req.file);
      if (!(await queries.setEventCover(req.params.id, req.user.id, req.user.role, coverImage)))
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      return res.json({ coverImage });
    } catch (error) {
      if (error.code === 'INVALID_IMAGE') return res.status(400).json({ error: error.message });
      if (error.code === 'FTP_NOT_CONFIGURED')
        return res.status(503).json({ error: 'Event image storage is not configured.' });
      console.error('Event cover upload failed:', error);
      return res.status(502).json({ error: 'Unable to upload event cover.' });
    }
  });
  app.patch('/api/events/:id/schedule', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    const venueId = Number(req.body.venueId);
    const startsAt = utcDateTime(req.body.startsAtUtc);
    const endsAt = utcDateTime(req.body.endsAtUtc);
    if (
      !Number.isInteger(eventId) ||
      eventId < 1 ||
      !Number.isInteger(venueId) ||
      venueId < 1 ||
      !startsAt ||
      !endsAt ||
      startsAt >= endsAt
    )
      return res
        .status(422)
        .json({ error: 'Venue schedule requires UTC start/end timestamps and a venue.' });
    try {
      await ensureTable();
      const venue = await queries.eventLocationVenue(venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found or unavailable.' });
      if (
        !(await queries.updateEventSchedule(eventId, req.user.id, req.user.role, {
          startsAt,
          endsAt,
          venueId,
          timezone: venue.timezone,
        }))
      )
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      return res.json(
        decorateEventImage(await queries.richEvent(eventId, req.user.id, req.user.role), {
          userId: req.user.id,
          role: req.user.role,
        }),
      );
    } catch (error) {
      console.error('Event schedule update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update the event schedule.' });
    }
  });
  app.patch('/api/events/:id', authenticate, ...updateGuards, async (req, res) => {
    try {
      await ensureTable();
      const validation = await validateRichEvent(req.body);
      if (Object.keys(validation.errors).length)
        return res
          .status(422)
          .json({ error: 'Event draft is invalid.', fields: validation.errors });
      const draft = richEventData(req.body, req.user.id, validation);
      if ('organizerOrganizationId' in req.body) {
        const existing = await queries.richEvent(req.params.id, req.user.id, req.user.role);
        if (
          Number(existing?.organizerOrganizationId || 0) !==
          Number(req.body.organizerOrganizationId || 0)
        )
          throw accessError(
            'ORGANIZER_IMMUTABLE',
            'The organizing account cannot be changed after a draft is created.',
            422,
          );
      }
      if (
        !(await queries.updateRichEventAndBooking(
          req.params.id,
          req.user.id,
          req.user.role,
          draft,
          req.body.buyerBillingProfileId,
        ))
      )
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      const event = await queries.richEvent(req.params.id, req.user.id, req.user.role);
      const booking = draft.venueId
        ? await queries.eventVenueBooking(req.params.id, req.user.id, req.user.role)
        : null;
      return res.json({
        ...decorateEventImage(event, { userId: req.user.id, role: req.user.role }),
        venueBooking: booking,
      });
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({
          code: error.code,
          error: error.message,
          owner: error.owner,
          subscribeUrl: error.subscribeUrl,
        });
      if (bookingFailure(res, error)) return;
      console.error('Rich event update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update event.' });
    }
  });
  app.post('/api/events/:id/publish', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const event = await queries.richEvent(req.params.id, req.user.id, req.user.role);
      if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' });
      if (event.status === 'Completed')
        return res.status(409).json({ error: 'A finished event cannot be republished.' });
      if ((event.venue?.id || event.venueId) && event.venueBookingStatus !== 'confirmed')
        return res.status(409).json({
          code: 'VENUE_BOOKING_NOT_CONFIRMED',
          error: 'The venue owner must confirm the booking before this event can be published.',
        });
      await subscriptions.access.requirePublication(req.params.id, req.user.id, req.user.role);
      const validation = await validateRichEvent(event, { publishing: true });
      if (!event.coverImage)
        validation.errors.coverImage = 'A cover image is required before publication.';
      if (!event.categoryId || !event.typeId)
        validation.errors.taxonomy = 'Category and event type are required before publication.';
      if (Object.keys(validation.errors).length)
        return res
          .status(422)
          .json({ error: 'Event cannot be published.', fields: validation.errors });
      await queries.publishRichEvent(req.params.id, req.user.id, req.user.role);
      if (event.groupId && event.status !== 'Published')
        await notifyGroupEventMembers(req.params.id);
      return res.json(
        decorateEventImage(await queries.richEvent(req.params.id, req.user.id, req.user.role), {
          userId: req.user.id,
          role: req.user.role,
        }),
      );
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({
          code: error.code,
          error: error.message,
          owner: error.owner,
          subscribeUrl: error.subscribeUrl,
        });
      console.error('Rich event publication failed:', error.message);
      return res.status(500).json({ error: 'Unable to publish event.' });
    }
  });
  app.get('/api/events', optionalAuthenticate, async (req, res) => {
    const categorySlug =
      req.query.category == null
        ? null
        : String(req.query.category)
            .trim()
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    if (req.query.category != null && !categorySlug)
      return res.status(422).json({ error: 'category must be a valid category slug.' });
    try {
      await ensureTable();
      const viewer = { userId: req.user?.id ?? null, role: req.user?.role ?? null };
      return res.json(
        decorateEventImages(
          await queries.eventsForViewer(viewer.userId, viewer.role, { categorySlug }),
          viewer,
        ),
      );
    } catch (error) {
      console.error('Event lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load events.' });
    }
  });
}
