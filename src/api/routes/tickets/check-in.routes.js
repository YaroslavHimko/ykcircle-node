export function registerTicketsCheckInRoutes(
  app,
  { authenticate, ensureTable, queries, representatives },
) {
  app.get('/api/me/representative-events', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.representativeEvents(req.user.id));
    } catch {
      return res.status(500).json({ error: 'Unable to load assigned events.' });
    }
  });
  app.get('/api/events/:id/check-in', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    if (!Number.isSafeInteger(eventId) || eventId < 1)
      return res.status(422).json({ error: 'A valid event id is required.' });
    try {
      await ensureTable();
      const event = await queries.eventCheckInContext(eventId, req.user.id, req.user.role);
      return event
        ? res.json(event)
        : res.status(403).json({
            error:
              'Ticket check-in is unavailable. Ask the event organizer to assign you as a representative.',
          });
    } catch {
      return res.status(500).json({ error: 'Unable to load ticket check-in.' });
    }
  });
  app.get('/api/events/:id/representatives', authenticate, representatives('list'));
  app.post('/api/events/:id/representatives', authenticate, representatives('add'));
  app.delete('/api/events/:id/representatives/:userId', authenticate, representatives('remove'));
  app.post('/api/events/:id/tickets/check-in', authenticate, async (req, res) => {
    const eventId = Number(req.params.id);
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!Number.isSafeInteger(eventId) || eventId < 1 || !/^YK-[A-F0-9]{32}$/.test(code))
      return res.status(422).json({ error: 'Scan a ticket QR code or enter a valid ticket code.' });
    try {
      await ensureTable();
      const result = await queries.checkInTicket(eventId, req.user.id, req.user.role, code);
      const failures = {
        EVENT_NOT_MANAGED: [
          403,
          'Only the event organizer, an assigned representative, or a manager can check in tickets.',
        ],
        EVENT_NOT_OPEN: [
          409,
          'Tickets cannot be checked in for an unpublished, cancelled, or archived event.',
        ],
        TICKET_NOT_FOUND: [
          404,
          'This ticket was not found for this event. Check that you are scanning the correct event’s ticket.',
        ],
        TICKET_NOT_PAID: [
          409,
          'This ticket is not valid for admission. Its payment is unpaid, refunded, cancelled, or disputed.',
        ],
        ATTENDEE_UNAVAILABLE: [409, 'This ticket no longer has an available participant.'],
        REGISTRATION_INACTIVE: [
          409,
          'This participant’s registration has been cancelled, declined, or withdrawn.',
        ],
      };
      if (result.error) {
        const [status, error] = failures[result.error] || [409, 'Unable to check in this ticket.'];
        return res.status(status).json({ code: result.error, error });
      }
      return res.json(result);
    } catch (error) {
      console.error('Ticket check-in failed:', error.message);
      return res.status(500).json({ error: 'Unable to check in the ticket. Please try again.' });
    }
  });
}
