export class EventsCatalogRepository {
  constructor({ database }) {
    this.database = database;
  }
  async publicEventParticipants(eventId) {
    const [rows] = await this.database.execute(
      'SELECT p.id, p.user_id AS userId, COALESCE(u.name, p.participant_name) AS name, u.profile_picture AS profilePicture, p.joined_at AS joinedAt FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.joined_at DESC',
      [eventId],
    );
    return rows;
  }

  async eventParticipantStatus(eventId, userId) {
    const [rows] = await this.database.execute(
      'SELECT status FROM event_participants WHERE event_id = ? AND user_id = ?',
      [eventId, userId],
    );
    return rows[0]?.status || null;
  }

  async publicEvents(userId = null) {
    const [rows] = await this.database.execute(
      `SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.participation_fee AS fee, e.status, e.visibility, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, v.id AS venueId, v.name AS venueName, v.formatted_address AS venueLocation, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_groups g ON g.id = e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id AND vb.status = 'confirmed' LEFT JOIN venues v ON v.id = vb.venue_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE e.status = 'Published' AND e.visibility = 'Public' ORDER BY e.starts_at ASC, e.created_at DESC`,
      [userId],
    );
    return rows;
  }

  async eventsForViewer(
    userId = null,
    role = null,
    { categorySlug = null, managedOnly = false } = {},
  ) {
    const privileged = ['manager', 'admin'].includes(role);
    const access = managedOnly
      ? 'e.manager_id = ?'
      : privileged
        ? 'TRUE'
        : `e.manager_id = ? OR (e.status = 'Published' AND e.visibility = 'Private' AND (r.id IS NOT NULL OR EXISTS (SELECT 1 FROM event_invitations i JOIN users invited ON LOWER(invited.email) = LOWER(i.email) WHERE i.event_id = e.id AND invited.id = ? AND i.status = 'Pending' AND i.token_expires_at > NOW())))`;
    const params = managedOnly
      ? [userId, userId]
      : privileged
        ? [userId]
        : [userId, userId, userId];
    const categoryFilter = categorySlug ? ' AND c.slug = ?' : '';
    if (categorySlug) params.push(categorySlug);
    const [rows] = await this.database.execute(
      `SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.participation_fee AS fee, e.status, e.visibility, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, v.id AS venueId, v.name AS venueName, v.formatted_address AS venueLocation, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_categories c ON c.id = e.category_id LEFT JOIN event_groups g ON g.id = e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id AND vb.status = 'confirmed' LEFT JOIN venues v ON v.id = vb.venue_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE e.deleted_at IS NULL AND (${managedOnly ? access : `(e.status = 'Published' AND e.visibility = 'Public') OR (${access})`})${categoryFilter} ORDER BY e.starts_at ASC, e.created_at DESC`,
      params,
    );
    return rows;
  }

  async privateInvitationExists(eventId, userId) {
    const [rows] = await this.database.execute(
      "SELECT i.id FROM event_invitations i JOIN users u ON LOWER(u.email) = LOWER(i.email) WHERE i.event_id = ? AND u.id = ? AND i.status = 'Pending' AND i.token_expires_at > NOW()",
      [eventId, userId],
    );
    return rows.length > 0;
  }

  async eventVisibility(eventId) {
    const [rows] = await this.database.execute('SELECT visibility FROM events WHERE id = ?', [
      eventId,
    ]);
    return rows[0]?.visibility;
  }

  async eventManagerId(eventId) {
    const [rows] = await this.database.execute(
      'SELECT manager_id AS managerId FROM events WHERE id = ?',
      [eventId],
    );
    return rows[0]?.managerId;
  }

  async eventFee(eventId) {
    const [rows] = await this.database.execute(
      'SELECT participation_fee AS fee FROM events WHERE id = ?',
      [eventId],
    );
    return Number(rows[0]?.fee || 0);
  }
}
