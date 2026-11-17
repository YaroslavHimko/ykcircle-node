export function createEventsFollowups({ queries }) {
  const followupAudience = (value) => ['attended', 'no_show'].includes(value);
  const managedCompletedEvent = async (req, res) => {
    const event = await queries.managedFollowupEvent(req.params.id, req.user.id, req.user.role);
    if (!event) {
      res.status(404).json({ error: 'Event not found or not managed by you.' });
      return null;
    }
    if (event.status !== 'Completed') {
      res
        .status(409)
        .json({ error: 'Mark this event finished before preparing follow-up emails.' });
      return null;
    }
    return event;
  };
  return { followupAudience, managedCompletedEvent };
}
