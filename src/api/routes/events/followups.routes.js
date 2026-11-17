export function registerEventsFollowupsRoutes(
  app,
  {
    authenticate,
    requireManager,
    ensureTable,
    managedCompletedEvent,
    queries,
    followupAudience,
    emailService,
  },
) {
  app.get('/api/events/:id/followups', authenticate, requireManager, async (req, res) => {
    try {
      await ensureTable();
      if (!(await managedCompletedEvent(req, res))) return;
      return res.json(await queries.eventFollowupOverview(req.params.id));
    } catch (error) {
      console.error('Follow-up overview failed:', error.message);
      return res.status(500).json({ error: 'Unable to load follow-up emails.' });
    }
  });
  app.put('/api/events/:id/followups/:audience', authenticate, requireManager, async (req, res) => {
    if (!followupAudience(req.params.audience))
      return res.status(404).json({ error: 'Unknown attendance group.' });
    const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!subject || subject.length > 180 || /[\r\n]/.test(subject) || !body || body.length > 5000)
      return res.status(422).json({
        error:
          'Enter a one-line subject (up to 180 characters) and message (up to 5,000 characters).',
      });
    try {
      await ensureTable();
      if (!(await managedCompletedEvent(req, res))) return;
      if (
        !(await queries.saveEventFollowupTemplate(
          req.params.id,
          req.params.audience,
          subject,
          body,
        ))
      )
        return res
          .status(409)
          .json({ error: 'This follow-up has already started and its message is locked.' });
      return res.json(await queries.eventFollowupOverview(req.params.id));
    } catch (error) {
      console.error('Follow-up template save failed:', error.message);
      return res.status(500).json({ error: 'Unable to save follow-up email.' });
    }
  });
  app.post(
    '/api/events/:id/followups/:audience/send',
    authenticate,
    requireManager,
    async (req, res) => {
      if (!followupAudience(req.params.audience))
        return res.status(404).json({ error: 'Unknown attendance group.' });
      try {
        await ensureTable();
        const event = await managedCompletedEvent(req, res);
        if (!event) return;
        const overview = await queries.eventFollowupOverview(req.params.id);
        const template = overview.templates[req.params.audience];
        if (!template)
          return res.status(409).json({ error: 'Save this follow-up message before sending.' });
        const recipients = await queries.queueEventFollowup(req.params.id, req.params.audience);
        let sent = 0;
        let failed = 0;
        for (const recipient of recipients) {
          if (!(await queries.claimEventFollowupDelivery(recipient.id))) continue;
          let accepted = false;
          try {
            await emailService.sendEventFollowup(
              recipient.email,
              recipient.name,
              event,
              req.params.audience,
              template.subject,
              template.body,
              recipient.id,
            );
            accepted = true;
            await queries.finishEventFollowupDelivery(recipient.id);
            sent += 1;
          } catch (error) {
            console.error('Event follow-up delivery failed:', {
              eventId: event.id,
              deliveryId: recipient.id,
              error: error.message,
            });
            // Keep an accepted message in 'sending' if the database write fails;
            // retrying it automatically could send a duplicate email.
            if (accepted) throw error;
            await queries.finishEventFollowupDelivery(recipient.id, error.message);
            failed += 1;
          }
        }
        return res.json({ sent, failed, ...(await queries.eventFollowupOverview(req.params.id)) });
      } catch (error) {
        console.error('Event follow-up send failed:', error.message);
        return res.status(500).json({ error: 'Unable to send follow-up emails.' });
      }
    },
  );
}
