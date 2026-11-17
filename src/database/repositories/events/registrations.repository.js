import { foodSelections, jsonValue } from '../../../utils/serialization.js';
export class EventsRegistrationsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async registrations(eventId, managerId, isAdmin = false) {
    await this.database.execute(
      "UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.payment_status = CASE WHEN e.participation_fee > 0 THEN 'Payment Required' ELSE 'Not Required' END WHERE r.event_id = ? AND r.status <> 'Withdrawn' AND r.payment_status <> 'Paid'",
      [eventId],
    );
    const ownership = isAdmin ? '' : ' AND e.manager_id = ?';
    const params = isAdmin ? [eventId] : [eventId, managerId];
    const [rows] = await this.database.execute(
      `SELECT r.id, r.event_id AS eventId, r.user_id AS userId, r.status, r.selected_food_options AS selectedFoodOptions, r.payment_status AS paymentStatus, r.created_at AS createdAt, COALESCE(u.name, r.attendee_name) AS name, COALESCE(r.attendee_email, u.email) AS email, COALESCE(r.attendee_phone, u.phone) AS phone FROM event_registrations r JOIN events e ON e.id = r.event_id LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status <> 'Withdrawn'${ownership} ORDER BY r.created_at DESC`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      selectedFoodOptions: foodSelections(row.selectedFoodOptions),
    }));
  }

  async userRegistrations(userId) {
    const [rows] = await this.database.execute(
      'SELECT r.id, r.event_id AS eventId, r.status, r.created_at AS createdAt, e.title, e.custom_formatted_address AS location, e.starts_at AS startsAt FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.user_id = ? ORDER BY r.created_at DESC',
      [userId],
    );
    return rows;
  }

  async attendingEvents(userId, email) {
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const [rows] = await this.database.execute(
      `SELECT e.id, e.title, e.custom_formatted_address AS location,
      e.starts_at AS startsAt, e.ends_at AS endsAt, e.status, e.visibility,
      e.manager_id AS managerId, u.name AS managerName, e.brand_name AS brandName,
      e.short_description AS shortDescription, e.description, e.cover_image AS coverImage,
      e.location_type AS locationType, e.participation_fee AS fee, e.currency, e.timezone,
      v.name AS venueName,
      (SELECT JSON_ARRAYAGG(o.id) FROM ticket_orders o WHERE o.event_id = e.id AND o.attendee_user_id = ?
        AND o.payment_status = 'paid' AND EXISTS (SELECT 1 FROM issued_tickets t WHERE t.ticket_order_id = o.id)) AS ticketOrderIds,
      EXISTS (SELECT 1 FROM event_registrations r WHERE r.event_id = e.id
        AND (r.user_id = ? OR LOWER(r.attendee_email) = ?) AND r.status NOT IN ('Cancelled', 'Declined', 'Withdrawn')) AS isRegistered,
      EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id = e.id
        AND (p.user_id = ? OR LOWER(p.participant_email) = ?)) AS isParticipating,
      EXISTS (SELECT 1 FROM event_invitations i WHERE i.event_id = e.id AND LOWER(i.email) = ?
        AND (i.status = 'Accepted' OR (i.status = 'Pending' AND i.token_expires_at > NOW()))) AS isInvited
      FROM events e JOIN users u ON u.id=e.manager_id LEFT JOIN venues v ON v.id=e.venue_id
      WHERE e.deleted_at IS NULL AND e.status IN ('Published', 'Completed', 'Cancelled')
      HAVING isRegistered OR isParticipating OR isInvited
      ORDER BY e.starts_at DESC, e.id DESC`,
      [userId, userId, normalizedEmail, userId, normalizedEmail, normalizedEmail],
    );
    return rows.map((row) => ({
      ...row,
      ticketOrderIds: jsonValue(row.ticketOrderIds) || [],
      isRegistered: Boolean(row.isRegistered),
      isParticipating: Boolean(row.isParticipating),
      isInvited: Boolean(row.isInvited),
    }));
  }

  async registration(id, managerId) {
    const [rows] = await this.database.execute(
      "SELECT r.id, r.event_id AS eventId, r.user_id AS userId, r.status, COALESCE(r.attendee_email, u.email) AS email, COALESCE(u.name, r.attendee_name) AS name, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone FROM event_registrations r JOIN events e ON e.id = r.event_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status <> 'Withdrawn' AND e.manager_id = ?",
      [id, managerId],
    );
    return rows[0];
  }

  async existingEventRegistration(eventId, userId = null, email = null) {
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const lookupByUser = Number.isInteger(userId) && userId > 0;
    const condition = lookupByUser
      ? 'r.user_id = ?'
      : "LOWER(COALESCE(r.attendee_email, u.email, '')) = ?";
    const participantCondition = lookupByUser
      ? 'p.user_id = ?'
      : "LOWER(COALESCE(p.participant_email, u.email, '')) = ?";
    const value = lookupByUser ? userId : normalizedEmail;
    const [rows] = await this.database.execute(
      `SELECT id, status, source FROM (
        SELECT r.id, r.status, 'registration' AS source
        FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.event_id = ? AND ${condition}
        UNION ALL
        SELECT p.id, p.status, 'participant' AS source
        FROM event_participants p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.event_id = ? AND ${participantCondition}
      ) matches LIMIT 1`,
      [eventId, value, eventId, value],
    );
    return rows[0] || null;
  }

  async registerForEvent(eventId, userId, email, selectedFoodOptions = []) {
    const [events] = await this.database.execute(
      'SELECT e.id, e.id AS eventId, e.title, e.food_options AS foodOptions, e.brand_name AS brandName, e.logo_image AS logoImage, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.participation_fee AS fee, e.timezone, e.status, manager.email AS managerEmail, manager.name AS managerName FROM events e JOIN users manager ON manager.id = e.manager_id WHERE e.id = ?',
      [eventId],
    );
    const event = events[0];
    if (!event || event.status !== 'Published') return { error: 'EVENT_UNAVAILABLE' };
    const available = foodSelections(event.foodOptions);
    if (
      !Array.isArray(selectedFoodOptions) ||
      selectedFoodOptions.length > 12 ||
      selectedFoodOptions.some(
        (option) => typeof option !== 'string' || !available.includes(option),
      )
    )
      return { error: 'INVALID_FOOD_OPTIONS' };
    const selected = JSON.stringify([...new Set(selectedFoodOptions)]);
    const existing = await this.queries.existingEventRegistration(eventId, userId, email);
    if (existing && !(existing.source === 'registration' && existing.status === 'Withdrawn'))
      return { error: 'ALREADY_REGISTERED' };
    const normalizedEmail =
      String(email || '')
        .trim()
        .toLowerCase() || null;
    const id = existing
      ? existing.id
      : (
          await this.database.execute(
            "INSERT INTO event_registrations (event_id, user_id, attendee_email, selected_food_options, status) VALUES (?, ?, ?, ?, 'Pending')",
            [eventId, userId, normalizedEmail, selected],
          )
        )[0].insertId;
    if (existing)
      await this.database.execute(
        "UPDATE event_registrations SET user_id = COALESCE(user_id, ?), attendee_email = ?, selected_food_options = ?, status = 'Pending', payment_status = CASE WHEN payment_status = 'Paid' THEN 'Paid' ELSE 'Payment Required' END WHERE id = ?",
        [userId, normalizedEmail, selected, id],
      );
    await this.database.execute(
      "DELETE i FROM event_invitations i JOIN users u ON LOWER(u.email) = LOWER(i.email) WHERE i.event_id = ? AND u.id = ? AND i.status = 'Pending'",
      [eventId, userId],
    );
    return { ...event, id, selectedFoodOptions: JSON.parse(selected) };
  }

  async updateRegistrationStatus(id, managerId, status, isAdmin = false) {
    const ownership = isAdmin ? '' : ' AND e.manager_id = ?';
    const params = isAdmin ? [status, id] : [status, id, managerId];
    const [result] = await this.database.execute(
      `UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.status = ? WHERE r.id = ? AND r.status <> 'Withdrawn'${ownership}`,
      params,
    );
    if (result.affectedRows && status === 'Confirmed') {
      const [registration] = await this.database.execute(
        'SELECT r.event_id AS eventId, r.user_id AS userId, COALESCE(u.name, r.attendee_name) AS name, COALESCE(r.attendee_email, u.email) AS email, COALESCE(r.attendee_phone, u.phone) AS phone, r.selected_food_options AS selectedFoodOptions, r.payment_status AS paymentStatus FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?',
        [id],
      );
      if (registration[0] && registration[0].name) {
        await this.database.execute(
          'INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, payment_status, selected_food_options) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE participant_name = VALUES(participant_name), participant_email = VALUES(participant_email), participant_phone = VALUES(participant_phone), payment_status = VALUES(payment_status), selected_food_options = VALUES(selected_food_options)',
          [
            registration[0].eventId,
            registration[0].userId,
            registration[0].name,
            registration[0].email,
            registration[0].phone,
            registration[0].paymentStatus,
            JSON.stringify(foodSelections(registration[0].selectedFoodOptions)),
          ],
        );
        await this.database.execute('DELETE FROM event_registrations WHERE id = ?', [id]);
      }
    }
    if (result.affectedRows && ['Cancelled', 'Declined', 'Withdrawn'].includes(status)) {
      const [registration] = await this.database.execute(
        'SELECT event_id AS eventId, user_id AS userId, attendee_email AS email FROM event_registrations WHERE id = ?',
        [id],
      );
      if (registration[0])
        await this.database.execute(
          'DELETE FROM event_participants WHERE event_id = ? AND (user_id = ? OR (user_id IS NULL AND participant_email = ?))',
          [registration[0].eventId, registration[0].userId, registration[0].email],
        );
    }
    return result.affectedRows > 0;
  }

  async withdrawRegistration(id, userId) {
    const [result] = await this.database.execute(
      "UPDATE event_registrations SET status = 'Withdrawn' WHERE id = ? AND user_id = ? AND status NOT IN ('Attended', 'Withdrawn')",
      [id, userId],
    );
    return result.affectedRows > 0;
  }

  async findActiveRegistrationForUser(eventId, userId) {
    const [rows] = await this.database.execute(
      `SELECT id, source FROM (SELECT r.id, 'registration' AS source FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status IN ('Pending', 'Confirmed') AND (r.user_id = ? OR (r.user_id IS NULL AND LOWER(r.attendee_email) = LOWER((SELECT email FROM users WHERE id = ?)))) UNION ALL SELECT p.id, 'participant' AS source FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? AND p.status = 'Pending' AND (p.user_id = ? OR (p.user_id IS NULL AND LOWER(p.participant_email) = LOWER((SELECT email FROM users WHERE id = ?))))) active_records LIMIT 1`,
      [eventId, userId, userId, eventId, userId, userId],
    );
    return rows[0] || null;
  }

  async markRegistrationWithdrawn(registration) {
    if (registration.source === 'participant') {
      const [result] = await this.database.execute('DELETE FROM event_participants WHERE id = ?', [
        registration.id,
      ]);
      return result.affectedRows > 0;
    }
    const [result] = await this.database.execute(
      "UPDATE event_registrations SET status = 'Withdrawn' WHERE id = ? AND status IN ('Pending', 'Confirmed')",
      [registration.id],
    );
    return result.affectedRows > 0;
  }

  async customerRegistration(id, userId) {
    const [rows] = await this.database.execute(
      'SELECT r.id, u.email, u.name, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone FROM event_registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id WHERE r.id = ? AND r.user_id = ?',
      [id, userId],
    );
    return rows[0];
  }
}
