import { foodSelections } from '../../../utils/serialization.js';
export class EventsAttendanceRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async events(userId = null, includeUnpublished = false) {
    const statusFilter = includeUnpublished ? '' : " AND e.status = 'Published'";
    const [rows] = await this.database.execute(
      `SELECT e.id, e.manager_id AS managerId, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.participation_fee AS fee, e.status, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE 1 = 1${statusFilter} ORDER BY e.created_at DESC`,
      [userId],
    );
    return rows;
  }

  async event(id) {
    const [rows] = await this.database.execute(
      'SELECT e.id, e.manager_id AS managerId, e.organizer_organization_id AS organizerOrganizationId, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.participation_fee AS fee, e.status, e.created_at AS createdAt, u.name AS managerName FROM events e JOIN users u ON u.id = e.manager_id WHERE e.id = ?',
      [id],
    );
    return rows[0];
  }

  async eventParticipants(eventId, canSeeContact = false) {
    await this.database.execute(
      "UPDATE event_participants p JOIN events e ON e.id = p.event_id SET p.payment_status = CASE WHEN e.participation_fee > 0 THEN 'Payment Required' ELSE 'Not Required' END WHERE p.event_id = ? AND (p.payment_status <> 'Paid' OR p.payment_status IS NULL)",
      [eventId],
    );
    const [rows] = await this.database.execute(
      `SELECT p.id, p.user_id AS userId, COALESCE(u.name, p.participant_name) AS name, u.profile_picture AS profilePicture, CASE WHEN ${canSeeContact ? 'TRUE' : 'FALSE'} THEN COALESCE(p.participant_email, u.email) ELSE NULL END AS email, CASE WHEN ${canSeeContact ? 'TRUE' : 'FALSE'} THEN COALESCE(p.participant_phone, u.phone) ELSE NULL END AS phone, ${canSeeContact ? 'p.selected_food_options AS selectedFoodOptions,' : ''} p.status, CASE WHEN ${canSeeContact ? 'TRUE' : 'FALSE'} THEN p.payment_status ELSE NULL END AS paymentStatus, p.joined_at AS joinedAt FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.joined_at DESC`,
      [eventId],
    );
    return canSeeContact
      ? rows.map((row) => ({
          ...row,
          selectedFoodOptions: foodSelections(row.selectedFoodOptions),
        }))
      : rows;
  }

  async eventRatingSummary(eventId, userId = null) {
    const [rows] = await this.database.execute(
      `SELECT e.id AS eventId, ROUND(AVG(r.rating), 2) AS ratingAverage, COUNT(r.rating) AS ratingCount,
    MAX(CASE WHEN r.user_id = ? THEN r.rating END) AS myRating
    FROM events e LEFT JOIN event_ratings r ON r.event_id = e.id WHERE e.id = ? AND e.deleted_at IS NULL GROUP BY e.id`,
      [userId, eventId],
    );
    return rows[0] || null;
  }

  async rateEvent(eventId, userId, rating) {
    const [participants] = await this.database.execute(
      'SELECT status FROM event_participants WHERE event_id = ? AND user_id = ?',
      [eventId, userId],
    );
    const participant = participants[0];
    if (!participant) return { error: 'NOT_ATTENDED' };
    if (participant.status === 'No Show') return { error: 'NO_SHOW' };
    if (participant.status !== 'Attended') return { error: 'NOT_ATTENDED' };
    await this.database.execute(
      'INSERT INTO event_ratings (event_id, user_id, rating) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rating = VALUES(rating), updated_at = CURRENT_TIMESTAMP',
      [eventId, userId, rating],
    );
    return { summary: await this.queries.eventRatingSummary(eventId, userId) };
  }

  async updateParticipantStatus(id, managerId, status, isAdmin = false) {
    const ownership = isAdmin ? '' : ' AND e.manager_id = ?';
    const params = isAdmin ? [status, id] : [status, id, managerId];
    const [result] = await this.database.execute(
      `UPDATE event_participants p JOIN events e ON e.id = p.event_id SET p.status = ? WHERE p.id = ? AND NOT EXISTS (SELECT 1 FROM event_followup_deliveries d WHERE d.participant_id = p.id)${ownership}`,
      params,
    );
    return result.affectedRows > 0;
  }

  async updateParticipantPaymentStatus(id, managerId, status, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const ownership = globalAccess ? '' : ' AND e.manager_id = ?';
    const params = globalAccess ? [status, id] : [status, id, managerId];
    const [result] = await this.database.execute(
      `UPDATE event_participants p JOIN events e ON e.id = p.event_id SET p.payment_status = ? WHERE p.id = ?${ownership}`,
      params,
    );
    return result.affectedRows > 0;
  }

  async participantFee(id) {
    const [rows] = await this.database.execute(
      'SELECT e.participation_fee AS fee FROM event_participants p JOIN events e ON e.id = p.event_id WHERE p.id = ?',
      [id],
    );
    return Number(rows[0]?.fee || 0);
  }

  async updateRegistrationPaymentStatus(id, managerId, status, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const ownership = globalAccess ? '' : ' AND e.manager_id = ?';
    const params = globalAccess ? [status, id] : [status, id, managerId];
    const [result] = await this.database.execute(
      `UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.payment_status = ? WHERE r.id = ?${ownership} AND r.status = 'Pending'`,
      params,
    );
    return result.affectedRows > 0;
  }

  async registrationFee(id) {
    const [rows] = await this.database.execute(
      'SELECT e.participation_fee AS fee FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.id = ?',
      [id],
    );
    return Number(rows[0]?.fee || 0);
  }

  async managerEvents(managerId) {
    const [rows] = await this.database.execute(
      'SELECT id, manager_id AS managerId, title, description, custom_formatted_address AS location, starts_at AS startsAt, ends_at AS endsAt, status, created_at AS createdAt FROM events WHERE manager_id = ? ORDER BY created_at DESC',
      [managerId],
    );
    return rows;
  }

  async softDeleteEvent(id, userId, role) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?';
    const params = ['manager', 'admin'].includes(role) ? [id] : [id, userId];
    const [result] = await this.database.execute(
      `UPDATE events SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL${scope}`,
      params,
    );
    return result.affectedRows > 0;
  }
}
