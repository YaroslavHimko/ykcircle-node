export function createTicketsCheckIn({ ensureTable, queries }) {
  const representatives = (action) => async (req, res) => {
    const eventId = Number(req.params.id);
    const userId = Number(req.params.userId);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (
      !Number.isSafeInteger(eventId) ||
      eventId < 1 ||
      (action === 'remove' && (!Number.isSafeInteger(userId) || userId < 1)) ||
      (action === 'add' && (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    )
      return res
        .status(422)
        .json({ error: 'Provide a valid event and representative email or user id.' });
    try {
      await ensureTable();
      const result = await queries.manageEventRepresentatives(eventId, req.user.id, req.user.role, {
        action,
        email,
        userId,
      });
      const failures = {
        EVENT_NOT_MANAGED: [
          403,
          'Only the event organizer or a manager can manage representatives.',
        ],
        VERIFIED_ACCOUNT_REQUIRED: [
          422,
          'This email must belong to an existing, verified YKCircle account. Ask the person to register and verify their email first.',
        ],
        ALREADY_MANAGER: [409, 'This person already has full management access to this event.'],
      };
      if (result.error) {
        const [status, error] = failures[result.error] || [
          409,
          'Unable to update representatives.',
        ];
        return res.status(status).json({ code: result.error, error });
      }
      return res.status(action === 'add' && !result.alreadyAssigned ? 201 : 200).json(result);
    } catch {
      return res.status(500).json({ error: 'Unable to manage event representatives.' });
    }
  };
  return { representatives };
}
