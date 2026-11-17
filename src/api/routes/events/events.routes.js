import { isEventStatus } from '../../../domain/events/event-status.js';
import { isInvitationStatus } from '../../../domain/events/invitation-status.js';

export function registerEventsRoutes(
  app,
  {
    optionalAuthenticate,
    ensureTable,
    queries,
    decorateEventImage,
    authenticate,
    decorateEventImages,
    requireManager,
    emailService,
    asStoredUtcDate,
    subscriptions,
    validateRichEvent,
    notifyGroupEventMembers,
  },
) {
  app.get('/api/events/:id', optionalAuthenticate, async (req, res) => {
    try {
      await ensureTable();
      const event = await queries.richEvent(
        req.params.id,
        req.user?.id ?? null,
        req.user?.role ?? null,
      );
      if (!event) return res.status(404).json({ error: 'Event not found.' });
      const canViewArchived =
        ['manager', 'admin'].includes(req.user?.role) || event.managerId === req.user?.id;
      if (event.status === 'Archived' && !canViewArchived)
        return res.status(404).json({ error: 'Event not found.' });
      event.participants = await queries.publicEventParticipants(req.params.id);
      if (req.user)
        event.myParticipantStatus = await queries.eventParticipantStatus(event.id, req.user.id);
      return res.json(
        decorateEventImage(event, { userId: req.user?.id ?? null, role: req.user?.role ?? null }),
      );
    } catch (error) {
      console.error('Event detail lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load event.' });
    }
  });
  app.get('/api/events/:id/rating', optionalAuthenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(404).json({ error: 'Event not found.' });
    try {
      await ensureTable();
      const summary = await queries.eventRatingSummary(eventId, req.user?.id ?? null);
      if (!summary) return res.status(404).json({ error: 'Event not found.' });
      return res.json(summary);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event rating.' });
    }
  });
  app.put('/api/events/:id/rating', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    const rating = Number(req.body.rating);
    if (
      !Number.isInteger(eventId) ||
      eventId < 1 ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    )
      return res.status(422).json({ error: 'rating must be an integer from 1 to 5.' });
    try {
      await ensureTable();
      const result = await queries.rateEvent(eventId, req.user.id, rating);
      if (result.error === 'NO_SHOW')
        return res.status(403).json({
          code: 'EVENT_RATING_NO_SHOW',
          error: 'No-show participants cannot rate this event.',
        });
      if (result.error === 'NOT_ATTENDED')
        return res.status(403).json({
          code: 'EVENT_RATING_REQUIRES_ATTENDANCE',
          error: 'Only participants marked as Attended can rate this event.',
        });
      return res.json(result.summary);
    } catch (error) {
      return res.status(500).json({ error: 'Unable to save event rating.' });
    }
  });
  app.get('/api/events/:id/threads', optionalAuthenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId < 1)
      return res.status(404).json({ error: 'Event not found.' });
    try {
      await ensureTable();
      if (!(await queries.eventForumAccess(eventId, req.user?.id ?? null, req.user?.role ?? null)))
        return res.status(404).json({ error: 'Event forum not found.' });
      return res.json(await queries.forumThreads('event', eventId, req.user?.id ?? null));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event threads.' });
    }
  });
  app.post('/api/events/:id/threads', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    const title = String(req.body.title || '').trim();
    const body = String(req.body.body || '').trim();
    if (!req.user.isEmailConfirmed)
      return res
        .status(403)
        .json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' });
    if (
      !Number.isInteger(eventId) ||
      eventId < 1 ||
      title.length < 3 ||
      title.length > 180 ||
      !body ||
      body.length > 4000
    )
      return res.status(422).json({
        error: 'Thread title must be 3-180 characters and body must be 1-4,000 characters.',
      });
    try {
      await ensureTable();
      if (!(await queries.eventForumAccess(eventId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Event forum not found.' });
      const id = await queries.createForumThread('event', eventId, req.user.id, title, body);
      return res.status(201).json({ id, eventId, title, status: 'active' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to create event thread.' });
    }
  });
  app.get(
    '/api/events/:eventId/threads/:threadId/messages',
    optionalAuthenticate,
    async (req, res) => {
      const eventId = Number(req.params.eventId);
      const threadId = Number(req.params.threadId);
      if (!Number.isInteger(eventId) || !Number.isInteger(threadId))
        return res.status(404).json({ error: 'Event thread not found.' });
      try {
        await ensureTable();
        if (
          !(await queries.eventForumAccess(eventId, req.user?.id ?? null, req.user?.role ?? null))
        )
          return res.status(404).json({ error: 'Event forum not found.' });
        const thread = await queries.forumThread('event', eventId, threadId);
        if (!thread || thread.status === 'removed')
          return res.status(404).json({ error: 'Event thread not found.' });
        const messages = await queries.forumMessages('event', threadId);
        if (req.user)
          await queries.markForumThreadRead('event', threadId, req.user.id, messages.at(-1)?.id);
        return res.json(messages);
      } catch (error) {
        return res.status(500).json({ error: 'Unable to load thread messages.' });
      }
    },
  );
  app.post('/api/events/:eventId/threads/:threadId/messages', authenticate, async (req, res) => {
    const eventId = Number(req.params.eventId);
    const threadId = Number(req.params.threadId);
    const body = String(req.body.body || '').trim();
    if (!req.user.isEmailConfirmed)
      return res
        .status(403)
        .json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' });
    if (!Number.isInteger(eventId) || !Number.isInteger(threadId) || !body || body.length > 4000)
      return res.status(422).json({ error: 'Message must be between 1 and 4,000 characters.' });
    try {
      await ensureTable();
      if (!(await queries.eventForumAccess(eventId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Event forum not found.' });
      const thread = await queries.forumThread('event', eventId, threadId);
      if (!thread || thread.status === 'removed')
        return res.status(404).json({ error: 'Event thread not found.' });
      if (thread.status !== 'active')
        return res.status(409).json({ error: 'This event thread is locked.' });
      const id = await queries.addForumMessage('event', threadId, req.user.id, body);
      return res.status(201).json({ id, threadId, body });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to send thread message.' });
    }
  });
  app.patch('/api/events/:eventId/threads/:threadId', authenticate, async (req, res) => {
    const eventId = Number(req.params.eventId);
    const threadId = Number(req.params.threadId);
    const status = String(req.body.status || '');
    if (
      !Number.isInteger(eventId) ||
      !Number.isInteger(threadId) ||
      !['active', 'locked', 'removed'].includes(status)
    )
      return res.status(422).json({ error: 'Invalid thread status.' });
    try {
      await ensureTable();
      if (
        !(await queries.canManageEventForum(eventId, req.user.id, req.user.role)) ||
        !(await queries.forumThread('event', eventId, threadId))
      )
        return res.status(404).json({ error: 'Event thread not found or not managed by you.' });
      await queries.setForumThreadStatus('event', threadId, status);
      return res.json({ id: threadId, status });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to moderate event thread.' });
    }
  });
  app.delete('/api/events/:id', authenticate, async (req, res) => {
    try {
      await ensureTable();
      if (!(await queries.softDeleteEvent(req.params.id, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      return res.json({ message: 'Event deleted.' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to delete event.' });
    }
  });
  app.get('/api/my/events', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const viewer = { userId: req.user.id, role: req.user.role };
      return res.json(
        decorateEventImages(
          await queries.eventsForViewer(req.user.id, req.user.role, {
            managedOnly: true,
            categorySlug: req.query.category ? String(req.query.category) : null,
          }),
          viewer,
        ),
      );
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load your events.' });
    }
  });
  app.get('/api/my/attending-events', authenticate, async (req, res) => {
    try {
      await ensureTable();
      const events = await queries.attendingEvents(req.user.id, req.user.email);
      return res.json(
        decorateEventImages(events, {
          userId: req.user.id,
          role: req.user.role,
          attendingAccess: true,
        }),
      );
    } catch (error) {
      console.error('Attending event lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load your events.' });
    }
  });
  app.post('/api/events/:id/invitations', authenticate, requireManager, async (req, res) => {
    const { name, email } = req.body;
    if (!name?.trim() || !email?.trim())
      return res.status(400).json({ error: 'Name and email are required.' });
    try {
      await ensureTable();
      const invitation = await queries.createInvitation(
        req.params.id,
        req.user.id,
        name.trim(),
        email.trim().toLowerCase(),
      );
      if (invitation.error === 'EVENT_NOT_FOUND')
        return res.status(404).json({ error: 'Event not found.' });
      if (invitation.error === 'ALREADY_INVITED')
        return res
          .status(409)
          .json({ error: 'This customer has already been invited to the event.' });
      await emailService.sendEventInvitation(email.trim().toLowerCase(), name.trim(), invitation);
      return res.status(201).json({ message: 'Invitation sent.' });
    } catch (error) {
      console.error('Event invitation failed:', error.message);
      return res.status(500).json({ error: 'Unable to send event invitation.' });
    }
  });
  app.post(
    '/api/events/:eventId/invitations/:invitationId/resend',
    authenticate,
    requireManager,
    async (req, res) => {
      try {
        await ensureTable();
        const invitation = await queries.resendInvitation(
          req.params.eventId,
          req.params.invitationId,
          req.user.id,
        );
        if (!invitation)
          return res
            .status(404)
            .json({ error: 'Pending invitation not found or not managed by you.' });
        await emailService.sendEventInvitation(invitation.email, invitation.name, invitation);
        return res.json({ message: 'Invitation resent.' });
      } catch (error) {
        console.error('Invitation resend failed:', error.message);
        return res.status(500).json({ error: 'Unable to resend invitation.' });
      }
    },
  );
  app.get('/api/events/:id/invitations', authenticate, requireManager, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.invitations(req.params.id, req.user.id));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load event invitations.' });
    }
  });
  app.patch(
    '/api/events/:eventId/invitations/:invitationId/status',
    authenticate,
    requireManager,
    async (req, res) => {
      if (!isInvitationStatus(req.body.status))
        return res.status(400).json({ error: 'Invalid invitation status.' });
      try {
        await ensureTable();
        if (
          !(await queries.updateInvitationStatus(
            req.params.invitationId,
            req.params.eventId,
            req.user.id,
            req.body.status,
          ))
        )
          return res.status(404).json({ error: 'Invitation not found.' });
        return res.json({ message: 'Invitation status updated.', status: req.body.status });
      } catch (error) {
        return res.status(500).json({ error: 'Unable to update invitation status.' });
      }
    },
  );
  app.patch('/api/events/:id/status', authenticate, requireManager, async (req, res, next) => {
    if (req.body.status !== 'Completed') return next();
    try {
      await ensureTable();
      const event = await queries.managedFollowupEvent(req.params.id, req.user.id, req.user.role);
      if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' });
      if (
        event.status !== 'Published' ||
        !event.startsAt ||
        asStoredUtcDate(event.endsAt || event.startsAt).getTime() > Date.now()
      )
        return res.status(409).json({
          error: 'Only a published event whose scheduled time has passed can be marked finished.',
        });
      if (!(await queries.finishEvent(req.params.id, req.user.id, req.user.role)))
        return res
          .status(409)
          .json({ error: 'Event could not be marked finished. Refresh and try again.' });
      return res.json({ message: 'Event marked finished.', status: 'Completed' });
    } catch (error) {
      console.error('Event finish failed:', error.message);
      return res.status(500).json({ error: 'Unable to finish event.' });
    }
  });
  app.patch('/api/events/:id/status', authenticate, requireManager, async (req, res) => {
    if (!isEventStatus(req.body.status))
      return res.status(400).json({ error: 'Invalid event status.' });
    try {
      await ensureTable();
      const event =
        req.body.status === 'Published'
          ? await queries.richEvent(req.params.id, req.user.id, req.user.role)
          : null;
      if ((event?.venue?.id || event?.venueId) && event.venueBookingStatus !== 'confirmed')
        return res.status(409).json({
          code: 'VENUE_BOOKING_NOT_CONFIRMED',
          error: 'The venue owner must confirm the booking before this event can be published.',
        });
      if (req.body.status === 'Published') {
        if (!event) return res.status(404).json({ error: 'Event not found.' });
        await subscriptions.access.requirePublication(req.params.id, req.user.id, req.user.role);
        const validation = await validateRichEvent(event, { publishing: true });
        if (!event.coverImage)
          validation.errors.coverImage = 'A cover image is required before publication.';
        if (Object.keys(validation.errors).length)
          return res
            .status(422)
            .json({ error: 'Event cannot be published.', fields: validation.errors });
      }
      if (
        !(await queries.updateEventStatus(
          req.params.id,
          req.user.id,
          req.body.status,
          req.user.role,
        ))
      )
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      if (event?.groupId && event.status !== 'Published')
        await notifyGroupEventMembers(req.params.id);
      return res.json({ message: 'Event status updated.', status: req.body.status });
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({
          code: error.code,
          error: error.message,
          owner: error.owner,
          subscribeUrl: error.subscribeUrl,
        });
      return res.status(500).json({ error: 'Unable to update event status.' });
    }
  });
}
