export function registerEventsRegistrationAccessRoutes(
  app,
  { authenticate, ensureTable, queries },
) {
  app.post('/api/events/:id/registrations', authenticate, async (req, res, next) => {
    try {
      await ensureTable();
      if (
        (await queries.eventVisibility(req.params.id)) === 'Private' &&
        !(await queries.privateInvitationExists(req.params.id, req.user.id)) &&
        req.user.id !== (await queries.eventManagerId(req.params.id))
      )
        return res.status(403).json({
          code: 'INVITATION_REQUIRED',
          error: 'A direct invitation is required to register for this private event.',
        });
      return next();
    } catch (error) {
      return res.status(500).json({ error: 'Unable to validate event access.' });
    }
  });
}
