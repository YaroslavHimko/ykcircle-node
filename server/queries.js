import crypto from 'node:crypto';

import { addDays, calculateAvailability, isDateOnly, localDateTimeToUtc } from './venue-availability.js';
import { zonedDateTime } from './time.js';
import { calculateVenueBookingPrice, venueFinancialReadiness as evaluateVenueFinancialReadiness } from './venue-finance.js';

const utcTimestamp = (value) => {
  if (!value) return value;
  const instant = value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T').replace(/Z$/i, '')}Z`);
  return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
};
const dateOnly = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const date = String(value ?? '').slice(0, 10);
  return isDateOnly(date) ? date : null;
};
const jsonValue = (value) => {
  if (!value || typeof value === 'object') return value || null;
  try { return JSON.parse(value); } catch { return null; }
};

export class Queries {
  // Representative is an event-scoped role, never an upgrade to users.role.
  async isEventRepresentative(eventId, userId, database = this.database) {
    const [rows] = await database.execute(`SELECT r.user_id FROM event_representatives r
      JOIN users u ON u.id=r.user_id AND u.isEmailConfirmed=TRUE
      WHERE r.event_id=? AND r.user_id=?`, [eventId, userId]);
    return rows.length > 0;
  }

  async representativeEvents(userId) {
    const [rows] = await this.database.execute(`SELECT e.id, e.title, e.starts_at AS startsAt, e.timezone, e.status
      FROM event_representatives r JOIN events e ON e.id=r.event_id
      JOIN users u ON u.id=r.user_id AND u.isEmailConfirmed=TRUE
      WHERE r.user_id=? AND e.deleted_at IS NULL AND e.status IN ('Published','Completed') ORDER BY e.starts_at DESC`, [userId]);
    return rows.map((event) => ({ ...event, accessRole: 'representative' }));
  }

  async eventCheckInContext(eventId, userId, role) {
    const [events] = await this.database.execute(`SELECT id, manager_id AS managerId, title, starts_at AS startsAt, timezone, status
      FROM events WHERE id=? AND deleted_at IS NULL`, [eventId]);
    const event = events[0];
    if (!event) return null;
    const fullAccess = ['manager', 'admin'].includes(role) || Number(event.managerId) === Number(userId);
    if (!fullAccess && (!['Published', 'Completed'].includes(event.status) || !await this.isEventRepresentative(eventId, userId))) return null;
    return { id: event.id, title: event.title, startsAt: utcTimestamp(event.startsAt), timezone: event.timezone, status: event.status,
      accessRole: fullAccess ? 'organizer' : 'representative' };
  }

  async manageEventRepresentatives(eventId, actorId, role, { action = 'list', email, userId } = {}) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const reject = async (error) => { await connection.rollback(); return { error }; };
      // Use the same event lock as check-in so revocation and admission are ordered.
      const [events] = await connection.execute('SELECT id, manager_id AS managerId FROM events WHERE id=? AND deleted_at IS NULL FOR UPDATE', [eventId]);
      if (!events[0] || (!['manager', 'admin'].includes(role) && Number(events[0].managerId) !== Number(actorId))) return await reject('EVENT_NOT_MANAGED');
      let alreadyAssigned = false;
      if (action === 'add') {
        const [users] = await connection.execute('SELECT id, role, isEmailConfirmed FROM users WHERE LOWER(email)=? FOR UPDATE', [email]);
        const user = users[0];
        if (!user || !user.isEmailConfirmed) return await reject('VERIFIED_ACCOUNT_REQUIRED');
        if (Number(user.id) === Number(events[0].managerId) || ['manager', 'admin'].includes(user.role)) return await reject('ALREADY_MANAGER');
        const [existing] = await connection.execute('SELECT user_id FROM event_representatives WHERE event_id=? AND user_id=?', [eventId, user.id]);
        alreadyAssigned = existing.length > 0;
        if (!alreadyAssigned) await connection.execute('INSERT INTO event_representatives (event_id, user_id, assigned_by_user_id) VALUES (?, ?, ?)', [eventId, user.id, actorId]);
      } else if (action === 'remove') {
        await connection.execute('DELETE FROM event_representatives WHERE event_id=? AND user_id=?', [eventId, userId]);
      }
      const [representatives] = await connection.execute(`SELECT r.user_id AS userId, u.name, u.email, r.created_at AS assignedAt
        FROM event_representatives r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.created_at, r.user_id`, [eventId]);
      await connection.commit();
      return { representatives: representatives.map((user) => ({ ...user, role: 'representative' })), alreadyAssigned };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async checkInTicket(eventId, userId, role, code) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const reject = async (error) => { await connection.rollback(); return { error }; };
      // Serialize check-ins for this event, including different tickets belonging
      // to the same purchaser. Authorization and all attendance writes are atomic.
      const [events] = await connection.execute('SELECT id, manager_id AS managerId, status FROM events WHERE id=? AND deleted_at IS NULL FOR UPDATE', [eventId]);
      const event = events[0];
      if (!event) return await reject('EVENT_NOT_MANAGED');
      const fullAccess = ['manager', 'admin'].includes(role) || Number(event.managerId) === Number(userId);
      if (!fullAccess && !await this.isEventRepresentative(eventId, userId, connection)) return await reject('EVENT_NOT_MANAGED');
      if (!['Published', 'Completed'].includes(event.status)) return await reject('EVENT_NOT_OPEN');
      const [tickets] = await connection.execute(`SELECT t.id, t.code, t.checked_in_at AS checkedInAt,
        o.id AS orderId, o.attendee_user_id AS attendeeUserId, o.attendee_email AS attendeeEmail,
        o.payment_status AS paymentStatus, o.test_mode AS testMode
        FROM issued_tickets t JOIN ticket_orders o ON o.id=t.ticket_order_id
        WHERE t.code=? AND o.event_id=? FOR UPDATE`, [code, eventId]);
      const ticket = tickets[0];
      if (!ticket) return await reject('TICKET_NOT_FOUND');
      if (ticket.paymentStatus !== 'paid') return await reject('TICKET_NOT_PAID');
      if (!ticket.attendeeUserId) return await reject('ATTENDEE_UNAVAILABLE');
      const [users] = await connection.execute('SELECT id, name, email, phone, profile_picture AS profilePicture FROM users WHERE id=?', [ticket.attendeeUserId]);
      if (!users[0]) return await reject('ATTENDEE_UNAVAILABLE');
      const [registrations] = await connection.execute('SELECT id, status FROM event_registrations WHERE event_id=? AND user_id=? FOR UPDATE', [eventId, ticket.attendeeUserId]);
      if (registrations.some((registration) => ['Cancelled', 'Declined', 'Withdrawn'].includes(registration.status))) return await reject('REGISTRATION_INACTIVE');
      const attendee = users[0];
      if (!ticket.checkedInAt) {
        await connection.execute(`INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, status, payment_status)
          VALUES (?, ?, ?, ?, ?, 'Attended', 'Paid') ON DUPLICATE KEY UPDATE status='Attended', payment_status='Paid'`,
        [eventId, attendee.id, attendee.name || ticket.attendeeEmail || 'Ticket holder', ticket.attendeeEmail || attendee.email, attendee.phone]);
        await connection.execute("UPDATE event_registrations SET status='Attended', payment_status='Paid' WHERE event_id=? AND user_id=?", [eventId, attendee.id]);
        await connection.execute('UPDATE issued_tickets SET checked_in_at=UTC_TIMESTAMP(), checked_in_by_user_id=? WHERE id=? AND checked_in_at IS NULL', [userId, ticket.id]);
      }
      const [participants] = await connection.execute(`SELECT id, user_id AS userId, participant_name AS name, participant_email AS email,
        participant_phone AS phone, status, payment_status AS paymentStatus, joined_at AS joinedAt FROM event_participants WHERE event_id=? AND user_id=?`, [eventId, attendee.id]);
      const [saved] = await connection.execute('SELECT checked_in_at AS checkedInAt FROM issued_tickets WHERE id=?', [ticket.id]);
      await connection.commit();
      return { ticketId: ticket.id, code: ticket.code, eventId, alreadyCheckedIn: Boolean(ticket.checkedInAt),
        checkedInAt: utcTimestamp(saved[0].checkedInAt), testMode: Boolean(ticket.testMode),
        participant: participants[0] ? (fullAccess ? { ...participants[0], profilePicture: attendee.profilePicture }
          : { id: participants[0].id, name: participants[0].name, status: participants[0].status }) : null };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async createContentReport(report) {
    const [result] = await this.database.execute(
      `INSERT INTO content_reports
        (reference, reporter_user_id, reporter_email, entity_type, entity_id, content_url, reason_code, description, supporting_details, alleged_illegal, good_faith_declared)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [report.reference, report.reporterUserId, report.reporterEmail, report.entityType, report.entityId, report.contentUrl, report.reasonCode, report.description, report.supportingDetails, report.allegedIllegal, true],
    );
    return result.insertId;
  }
  async contentReports(status = null) {
    const [rows] = await this.database.execute(`SELECT r.id, r.reference, r.reporter_user_id AS reporterUserId, r.reporter_email AS reporterEmail, r.entity_type AS entityType, r.entity_id AS entityId, r.content_url AS contentUrl, r.reason_code AS reasonCode, r.description, r.alleged_illegal AS allegedIllegal, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt, r.reviewed_by_user_id AS reviewedByUserId
      FROM content_reports r${status ? ' WHERE r.status = ?' : ''} ORDER BY r.created_at DESC`, status ? [status] : []);
    return rows;
  }
  async reviewContentReport(id, status, reviewerUserId) {
    const [result] = await this.database.execute('UPDATE content_reports SET status = ?, reviewed_at = NOW(), reviewed_by_user_id = ? WHERE id = ?', [status, reviewerUserId, id]);
    return result.affectedRows > 0;
  }
  async ensureLegalDocumentVersion(document) {
    const documentType = document.documentType || document.slug;
    await this.database.execute('UPDATE legal_document_versions SET is_current = FALSE WHERE document_type = ? AND version <> ?', [documentType, document.version]);
    await this.database.execute(`INSERT INTO legal_document_versions (document_type, version, published_at, content_hash, requires_reacceptance, is_current)
      VALUES (?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE published_at = VALUES(published_at), content_hash = VALUES(content_hash), requires_reacceptance = VALUES(requires_reacceptance), is_current = TRUE`,
    [documentType, document.version, document.lastUpdated ? new Date(document.lastUpdated) : new Date(), document.contentHash, document.requiresReacceptance === true]);
  }
  async recordLegalAcceptance(userId, document, { source = 'account', contextType = null, contextId = null, organizationId = null } = {}) {
    const documentType = document.documentType || document.slug;
    const normalizedContextType = contextType == null ? null : String(contextType).trim() || null;
    const normalizedContextId = contextId == null ? null : String(contextId).trim() || null;
    const normalizedOrganizationId = Number.isInteger(Number(organizationId)) && Number(organizationId) > 0 ? Number(organizationId) : null;
    const [existing] = await this.database.execute(`SELECT id, accepted_at AS acceptedAt FROM user_legal_acceptances
      WHERE user_id = ? AND document_type = ? AND version = ?
      AND context_type <=> ? AND context_id <=> ? AND organization_id <=> ?
      ORDER BY accepted_at DESC LIMIT 1`, [userId, documentType, document.version, normalizedContextType, normalizedContextId, normalizedOrganizationId]);
    if (existing[0]) return { id: existing[0].id, acceptedAt: existing[0].acceptedAt, created: false };
    const [result] = await this.database.execute(`INSERT INTO user_legal_acceptances
      (user_id, document_type, version, source, context_type, context_id, organization_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [userId, documentType, document.version, source, normalizedContextType, normalizedContextId, normalizedOrganizationId]);
    return { id: result.insertId, acceptedAt: new Date(), created: true };
  }
  async audit(actorUserId, eventType, entityType = null, entityId = null, metadata = null) {
    await this.database.execute('INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)', [actorUserId, eventType, entityType, entityId == null ? null : String(entityId), metadata]);
  }
  async publicEventParticipants(eventId) { const [rows] = await this.database.execute('SELECT p.id, p.user_id AS userId, COALESCE(u.name, p.participant_name) AS name, u.profile_picture AS profilePicture, p.joined_at AS joinedAt FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.joined_at DESC', [eventId]); return rows; }
  async eventParticipantStatus(eventId, userId) { const [rows] = await this.database.execute('SELECT status FROM event_participants WHERE event_id = ? AND user_id = ?', [eventId, userId]); return rows[0]?.status || null; }
  async publicEvents(userId = null) { const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.visibility, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, v.id AS venueId, v.name AS venueName, v.formatted_address AS venueLocation, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_groups g ON g.id = e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id AND vb.status = 'confirmed' LEFT JOIN venues v ON v.id = vb.venue_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE e.status = 'Published' AND e.visibility = 'Public' ORDER BY e.starts_at ASC, e.created_at DESC`, [userId]); return rows; }
  async eventsForViewer(userId = null, role = null, { categorySlug = null } = {}) { const privileged = ['manager', 'admin'].includes(role); const access = privileged ? 'TRUE' : `e.manager_id = ? OR (e.status = 'Published' AND e.visibility = 'Private' AND (r.id IS NOT NULL OR EXISTS (SELECT 1 FROM event_invitations i JOIN users invited ON LOWER(invited.email) = LOWER(i.email) WHERE i.event_id = e.id AND invited.id = ? AND i.status = 'Pending' AND i.token_expires_at > NOW())))`; const params = privileged ? [userId] : [userId, userId, userId]; const categoryFilter = categorySlug ? ' AND c.slug = ?' : ''; if (categorySlug) params.push(categorySlug); const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.visibility, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, v.id AS venueId, v.name AS venueName, v.formatted_address AS venueLocation, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_categories c ON c.id = e.category_id LEFT JOIN event_groups g ON g.id = e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id AND vb.status = 'confirmed' LEFT JOIN venues v ON v.id = vb.venue_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE e.deleted_at IS NULL AND ((e.status = 'Published' AND e.visibility = 'Public') OR (${access}))${categoryFilter} ORDER BY e.starts_at ASC, e.created_at DESC`, params); return rows; }
  async privateInvitationExists(eventId, userId) { const [rows] = await this.database.execute("SELECT i.id FROM event_invitations i JOIN users u ON LOWER(u.email) = LOWER(i.email) WHERE i.event_id = ? AND u.id = ? AND i.status = 'Pending' AND i.token_expires_at > NOW()", [eventId, userId]); return rows.length > 0; }
  async eventVisibility(eventId) { const [rows] = await this.database.execute('SELECT visibility FROM events WHERE id = ?', [eventId]); return rows[0]?.visibility; }
  async eventManagerId(eventId) { const [rows] = await this.database.execute('SELECT manager_id AS managerId FROM events WHERE id = ?', [eventId]); return rows[0]?.managerId; }
  async eventFee(eventId) { const [rows] = await this.database.execute('SELECT participation_fee AS fee FROM events WHERE id = ?', [eventId]); return Number(rows[0]?.fee || 0); }
  constructor(database) {
    this.database = database;
    const execute = database.execute.bind(database);
    const normalizeParams = (params) => Array.isArray(params) ? params.map((value) => {
      if (value === undefined || (typeof value === 'number' && Number.isNaN(value))) return null;
      if (value instanceof Date && Number.isNaN(value.getTime())) return null;
      if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) return JSON.stringify(value);
      return value;
    }) : params;
    database.execute = (sql, params) => {
      if (/^\s*SELECT\b/i.test(sql) && /\b(?:FROM|JOIN) events\b/i.test(sql) && !/\bdeleted_at\b/i.test(sql)) {
        const column = /\b(?:FROM|JOIN) events\s+e\b/i.test(sql) ? 'e.deleted_at' : 'deleted_at';
        const whereIndex = sql.toUpperCase().lastIndexOf(' WHERE ');
        if (whereIndex >= 0) {
          const orderIndex = sql.toUpperCase().indexOf(' ORDER BY ', whereIndex);
          const endIndex = orderIndex >= 0 ? orderIndex : sql.length;
          const condition = sql.slice(whereIndex + 7, endIndex);
          sql = `${sql.slice(0, whereIndex)} WHERE (${condition}) AND ${column} IS NULL${sql.slice(endIndex)}`;
        }
      }
      if (/^\s*SELECT\b/i.test(sql) && /\b(?:FROM|JOIN) events\b/i.test(sql) && !/\bparticipation_fee\b/i.test(sql)) sql = sql.replace(/e\.capacity,/, 'e.capacity, e.participation_fee AS fee,');
      return execute(sql, normalizeParams(params));
    };
  }
  async initialize() { return this.database.initialize(); }
  async findUserById(id) { const [rows] = await this.database.execute('SELECT id, email, role, isEmailConfirmed, session_version AS sessionVersion FROM users WHERE id = ? AND deleted_at IS NULL', [id]); return rows[0]; }
  async findUserByEmail(email) { const [rows] = await this.database.execute('SELECT id, profile_picture AS profilePicture, name, email, password_hash, phone, role, isEmailConfirmed, session_version AS sessionVersion FROM users WHERE email = ? AND deleted_at IS NULL', [email]); return rows[0]; }
  async emailExists(email) { const [rows] = await this.database.execute('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [email]); return rows.length > 0; }
  async verifyEmail(tokenHash) { const [result] = await this.database.execute('UPDATE users SET isEmailConfirmed = TRUE, verification_token_hash = NULL, verification_expires_at = NULL WHERE verification_token_hash = ? AND verification_expires_at > NOW()', [tokenHash]); return result.affectedRows > 0; }
  async refreshVerification(email, tokenHash) { const [rows] = await this.database.execute('SELECT name, email, isEmailConfirmed, verification_resend_available_at AS availableAt FROM users WHERE email = ?', [email]); const user = rows[0]; if (!user || user.isEmailConfirmed) return null; if (user.availableAt && new Date(user.availableAt).getTime() > Date.now()) return { cooldownSeconds: Math.ceil((new Date(user.availableAt).getTime() - Date.now()) / 1000) }; const [result] = await this.database.execute('UPDATE users SET verification_token_hash = ?, verification_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR), verification_resend_available_at = DATE_ADD(NOW(), INTERVAL 30 SECOND) WHERE email = ? AND isEmailConfirmed = FALSE', [tokenHash, email]); return result.affectedRows ? { name: user.name, email: user.email } : null; }
  async createPasswordReset(email, tokenHash) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute('SELECT id, name, email FROM users WHERE email = ? FOR UPDATE', [email]);
      const user = users[0];
      if (!user) { await connection.commit(); return null; }
      const [tokens] = await connection.execute('SELECT resend_available_at AS availableAt FROM password_reset_tokens WHERE user_id = ? FOR UPDATE', [user.id]);
      if (tokens[0]?.availableAt && new Date(tokens[0].availableAt).getTime() > Date.now()) { await connection.commit(); return { cooldown: true }; }
      await connection.execute('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, resend_available_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 30 SECOND)) ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), expires_at = VALUES(expires_at), resend_available_at = VALUES(resend_available_at), created_at = CURRENT_TIMESTAMP', [user.id, tokenHash]);
      await connection.commit();
      return user;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async resetPassword(tokenHash, passwordHash) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [tokens] = await connection.execute('SELECT user_id AS userId FROM password_reset_tokens WHERE token_hash = ? AND expires_at > NOW() FOR UPDATE', [tokenHash]);
      if (!tokens[0]) { await connection.commit(); return false; }
      await connection.execute('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [passwordHash, tokens[0].userId]);
      await connection.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [tokens[0].userId]);
      await connection.commit();
      return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async profile(id) { const [rows] = await this.database.execute("SELECT u.id, u.profile_picture AS profilePicture, u.name, u.email, u.phone, u.role, u.isEmailConfirmed, u.timezone_display_mode AS timezoneDisplayMode, u.preferred_timezone AS preferredTimezone, u.created_at AS createdAt, COALESCE((SELECT marketing_opt_in FROM marketing_email_preferences p WHERE LOWER(p.email) = LOWER(u.email)), FALSE) AS marketingConsent FROM users u WHERE u.id = ? AND u.deleted_at IS NULL", [id]); return rows[0]; }
  async setMarketingEmailPreference(email, enabled, policyVersion = null, source = 'settings') {
    await this.database.execute('INSERT INTO marketing_email_preferences (email, marketing_opt_in, policy_version, source) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE marketing_opt_in = VALUES(marketing_opt_in), policy_version = VALUES(policy_version), source = VALUES(source), changed_at = CURRENT_TIMESTAMP', [email.toLowerCase(), enabled, policyVersion, source]);
    return enabled;
  }
  async marketingEmailPreference(email) { const [rows] = await this.database.execute('SELECT marketing_opt_in AS marketingOptIn FROM marketing_email_preferences WHERE LOWER(email) = LOWER(?)', [email]); return Boolean(rows[0]?.marketingOptIn); }
  async updateProfilePicture(id, profilePicture) { const [result] = await this.database.execute('UPDATE users SET profile_picture = ? WHERE id = ?', [profilePicture, id]); return result.affectedRows > 0; }
  async updateTimezonePreference(id, timezoneDisplayMode, preferredTimezone) { const [result] = await this.database.execute('UPDATE users SET timezone_display_mode=?, preferred_timezone=? WHERE id=? AND deleted_at IS NULL', [timezoneDisplayMode, preferredTimezone, id]); return result.affectedRows > 0; }
  async deleteUser(id) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT id, email, name, profile_picture AS profilePicture FROM users WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
      const user = rows[0];
      if (!user) { await connection.rollback(); return null; }
      const deletedEmail = `deleted-${user.id}-${Date.now()}@deleted.invalid`;
      await connection.execute("UPDATE users SET name = 'Deleted user', email = ?, phone = NULL, profile_picture = NULL, password_hash = ?, isEmailConfirmed = FALSE, session_version = session_version + 1, deleted_at = NOW() WHERE id = ?", [deletedEmail, `deleted:${Date.now()}`, id]);
      await connection.execute("UPDATE events SET deleted_at = NOW(), status = 'Archived' WHERE manager_id = ? AND deleted_at IS NULL", [id]);
      await connection.execute("UPDATE event_groups SET visibility = 'Private', status = 'archived' WHERE organizer_id = ?", [id]);
      await connection.execute('UPDATE venues SET is_active = FALSE WHERE owner_user_id = ?', [id]);
      await connection.execute("UPDATE articles SET status = 'removed', is_indexable = FALSE WHERE author_user_id = ?", [id]);
      for (const table of ['group_forum_messages', 'event_forum_messages']) {
        const authorColumn = 'author_user_id';
        await connection.execute(`UPDATE ${table} SET body = '[Deleted]' WHERE ${authorColumn} = ?`, [id]);
      }
      await connection.execute('INSERT INTO account_deletion_jobs (user_id, requested_by_user_id, status, details, completed_at) VALUES (?, ?, \'completed\', ?, NOW())', [id, id, JSON.stringify({ profilePicture: user.profilePicture, contentAnonymised: true })]);
      await connection.execute('INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, \'account_deleted\', \'user\', ?, ?)', [id, String(id), JSON.stringify({ contentAnonymised: true })]);
      await connection.commit();
      return user;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async applicationsForUser(email) { const [rows] = await this.database.execute('SELECT id, name, email, contact, activity, additional_information AS additionalInformation, status, created_at AS createdAt FROM contact_submissions WHERE email = ? ORDER BY created_at DESC', [email]); return rows; }
  async applicationActivities() { const [rows] = await this.database.execute('SELECT id, name FROM application_activities WHERE is_active = TRUE ORDER BY sort_order ASC, name ASC'); return rows; }
  async applications() { const [rows] = await this.database.execute('SELECT id, name, email, contact, activity, additional_information AS additionalInformation, status, created_at AS createdAt FROM contact_submissions ORDER BY created_at DESC'); return rows; }
  async application(id) { const [rows] = await this.database.execute('SELECT id, name, email, contact, activity, additional_information AS additionalInformation, status, created_at AS createdAt FROM contact_submissions WHERE id = ?', [id]); return rows[0]; }
  async updateApplicationStatus(id, status) { const [result] = await this.database.execute('UPDATE contact_submissions SET status = ? WHERE id = ?', [status, id]); return result.affectedRows > 0; }
  async reviewOrganizerApplication(id, status) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [applications] = await connection.execute("SELECT id, email, activity, status FROM contact_submissions WHERE id = ? FOR UPDATE", [id]);
      const application = applications[0];
      if (!application || application.activity.trim().toLowerCase() !== 'event organizer') return { error: 'NOT_ORGANIZER_APPLICATION' };
      if (status === 'Approved') {
        const [users] = await connection.execute("SELECT id, role FROM users WHERE LOWER(email) = LOWER(?) FOR UPDATE", [application.email]);
        if (!users[0]) return { error: 'CUSTOMER_NOT_FOUND' };
        if (!['customer', 'organizer'].includes(users[0].role)) return { error: 'INVALID_CUSTOMER_ROLE' };
        await connection.execute("UPDATE users SET role = 'organizer' WHERE id = ?", [users[0].id]);
      }
      await connection.execute('UPDATE contact_submissions SET status = ? WHERE id = ?', [status, id]);
      await connection.commit();
      return { success: true, status };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async createApplication(data) { const [result] = await this.database.execute('INSERT INTO contact_submissions (name, email, contact, activity, additional_information) VALUES (?, ?, ?, ?, ?)', [data.name, data.email, data.contact, data.activity, data.additionalInformation]); return result.insertId; }
  async createUser(data, sendVerification) {
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction(); const [result] = await connection.execute('INSERT INTO users (profile_picture, name, email, password_hash, phone, role, isEmailConfirmed, verification_token_hash, verification_expires_at, verification_resend_available_at) VALUES (?, ?, ?, ?, ?, ?, FALSE, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), DATE_ADD(NOW(), INTERVAL 30 SECOND))', [data.profilePicture, data.name, data.email, data.passwordHash, data.phone, data.role || 'customer', data.tokenHash]); if (data.termsVersion) await connection.execute("INSERT INTO user_legal_acceptances (user_id, document_type, version, source) VALUES (?, 'terms', ?, 'registration')", [result.insertId, data.termsVersion]); await connection.execute('INSERT INTO marketing_email_preferences (email, marketing_opt_in, policy_version, source) VALUES (?, ?, ?, \'registration\')', [data.email, Boolean(data.marketingConsent), data.marketingPolicyVersion || null]); await connection.execute('INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, \'registration\', \'user\', ?, ?)', [result.insertId, String(result.insertId), JSON.stringify({ termsVersion: data.termsVersion, marketingConsent: Boolean(data.marketingConsent) })]); await sendVerification(); await connection.commit(); return result.insertId; }
    catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async events(userId = null, includeUnpublished = false) { const statusFilter = includeUnpublished ? '' : " AND e.status = 'Published'"; const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE 1 = 1${statusFilter} ORDER BY e.created_at DESC`, [userId]); return rows; }
  async event(id) { const [rows] = await this.database.execute('SELECT e.id, e.manager_id AS managerId, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.participation_fee AS fee, e.status, e.created_at AS createdAt, u.name AS managerName FROM events e JOIN users u ON u.id = e.manager_id WHERE e.id = ?', [id]); return rows[0]; }
  async eventParticipants(eventId, canSeeContact = false) { await this.database.execute("UPDATE event_participants p JOIN events e ON e.id = p.event_id SET p.payment_status = CASE WHEN e.participation_fee > 0 THEN 'Payment Required' ELSE 'Not Required' END WHERE p.event_id = ? AND (p.payment_status <> 'Paid' OR p.payment_status IS NULL)", [eventId]); const [rows] = await this.database.execute(`SELECT p.id, p.user_id AS userId, COALESCE(u.name, p.participant_name) AS name, u.profile_picture AS profilePicture, CASE WHEN ${canSeeContact ? 'TRUE' : 'FALSE'} THEN COALESCE(p.participant_email, u.email) ELSE NULL END AS email, CASE WHEN ${canSeeContact ? 'TRUE' : 'FALSE'} THEN COALESCE(p.participant_phone, u.phone) ELSE NULL END AS phone, p.status, CASE WHEN ${canSeeContact ? 'TRUE' : 'FALSE'} THEN p.payment_status ELSE NULL END AS paymentStatus, p.joined_at AS joinedAt FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.joined_at DESC`, [eventId]); return rows; }
  async eventRatingSummary(eventId, userId = null) { const [rows] = await this.database.execute(`SELECT e.id AS eventId, ROUND(AVG(r.rating), 2) AS ratingAverage, COUNT(r.rating) AS ratingCount,
    MAX(CASE WHEN r.user_id = ? THEN r.rating END) AS myRating
    FROM events e LEFT JOIN event_ratings r ON r.event_id = e.id WHERE e.id = ? AND e.deleted_at IS NULL GROUP BY e.id`, [userId, eventId]); return rows[0] || null; }
  async rateEvent(eventId, userId, rating) {
    const [participants] = await this.database.execute('SELECT status FROM event_participants WHERE event_id = ? AND user_id = ?', [eventId, userId]);
    const participant = participants[0];
    if (!participant) return { error: 'NOT_ATTENDED' };
    if (participant.status === 'No Show') return { error: 'NO_SHOW' };
    if (participant.status !== 'Attended') return { error: 'NOT_ATTENDED' };
    await this.database.execute('INSERT INTO event_ratings (event_id, user_id, rating) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rating = VALUES(rating), updated_at = CURRENT_TIMESTAMP', [eventId, userId, rating]);
    return { summary: await this.eventRatingSummary(eventId, userId) };
  }
  async updateParticipantStatus(id, managerId, status, isAdmin = false) { const ownership = isAdmin ? '' : ' AND e.manager_id = ?'; const params = isAdmin ? [status, id] : [status, id, managerId]; const [result] = await this.database.execute(`UPDATE event_participants p JOIN events e ON e.id = p.event_id SET p.status = ? WHERE p.id = ?${ownership}`, params); return result.affectedRows > 0; }
  async updateParticipantPaymentStatus(id, managerId, status, role) { const globalAccess = ['manager', 'admin'].includes(role); const ownership = globalAccess ? '' : ' AND e.manager_id = ?'; const params = globalAccess ? [status, id] : [status, id, managerId]; const [result] = await this.database.execute(`UPDATE event_participants p JOIN events e ON e.id = p.event_id SET p.payment_status = ? WHERE p.id = ?${ownership}`, params); return result.affectedRows > 0; }
  async participantFee(id) { const [rows] = await this.database.execute('SELECT e.participation_fee AS fee FROM event_participants p JOIN events e ON e.id = p.event_id WHERE p.id = ?', [id]); return Number(rows[0]?.fee || 0); }
  async updateRegistrationPaymentStatus(id, managerId, status, role) { const globalAccess = ['manager', 'admin'].includes(role); const ownership = globalAccess ? '' : ' AND e.manager_id = ?'; const params = globalAccess ? [status, id] : [status, id, managerId]; const [result] = await this.database.execute(`UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.payment_status = ? WHERE r.id = ?${ownership} AND r.status = 'Pending'`, params); return result.affectedRows > 0; }
  async registrationFee(id) { const [rows] = await this.database.execute('SELECT e.participation_fee AS fee FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.id = ?', [id]); return Number(rows[0]?.fee || 0); }
  async managerEvents(managerId) { const [rows] = await this.database.execute('SELECT id, manager_id AS managerId, title, description, custom_formatted_address AS location, starts_at AS startsAt, ends_at AS endsAt, capacity, status, created_at AS createdAt FROM events WHERE manager_id = ? ORDER BY created_at DESC', [managerId]); return rows; }
  async softDeleteEvent(id, userId, role) { const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?'; const params = ['manager', 'admin'].includes(role) ? [id] : [id, userId]; const [result] = await this.database.execute(`UPDATE events SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL${scope}`, params); return result.affectedRows > 0; }
  async createGroup({ organizerId, name, slug, description, visibility }) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute('INSERT INTO event_groups (organizer_id, name, slug, description, visibility) VALUES (?, ?, ?, ?, ?)', [organizerId, name, slug, description, visibility]);
      await connection.execute("INSERT INTO group_memberships (group_id, user_id, role) VALUES (?, ?, 'owner')", [result.insertId, organizerId]);
      await connection.commit();
      return result.insertId;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async groupsForViewer(userId = null, role = null, { managedOnly = false, membershipOnly = false } = {}) {
    const privileged = ['manager', 'admin'].includes(role);
    const managedFilter = managedOnly ? (privileged ? 'TRUE' : 'g.organizer_id = ?') : (membershipOnly ? 'g.organizer_id = ? OR gm.user_id IS NOT NULL' : (privileged ? 'TRUE' : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL"));
    const params = (privileged && !membershipOnly) ? [userId, userId] : [userId, userId, userId];
    const [rows] = await this.database.execute(`SELECT g.id, g.organizer_id AS organizerId, g.name, g.slug, g.description, g.cover_image AS coverImage, CASE WHEN g.cover_image IS NULL THEN NULL ELSE CONCAT('/uploads/group-covers/', g.cover_image) END AS coverImageUrl, g.visibility, g.status, g.created_at AS createdAt, g.updated_at AS updatedAt,
      owner.name AS organizerName, COUNT(DISTINCT members.user_id) AS memberCount, gm.role AS membershipRole, group_ratings.ratingAverage, COALESCE(group_ratings.ratedEventCount, 0) AS ratedEventCount,
      IF(gm.user_id IS NULL, FALSE, TRUE) AS isMember, IF(g.organizer_id = ?, TRUE, FALSE) AS isOrganizer
      FROM event_groups g JOIN users owner ON owner.id = g.organizer_id
      LEFT JOIN (SELECT e.group_id, ROUND(AVG(event_averages.ratingAverage), 2) AS ratingAverage, COUNT(*) AS ratedEventCount FROM events e JOIN (SELECT event_id, AVG(rating) AS ratingAverage FROM event_ratings GROUP BY event_id) event_averages ON event_averages.event_id = e.id WHERE e.deleted_at IS NULL GROUP BY e.group_id) group_ratings ON group_ratings.group_id = g.id
      LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active'
      LEFT JOIN group_memberships members ON members.group_id = g.id AND members.status = 'active'
      WHERE ${managedFilter}
      GROUP BY g.id, gm.role, gm.user_id, owner.name, group_ratings.ratingAverage, group_ratings.ratedEventCount ORDER BY g.created_at DESC`, params);
    return rows;
  }
  async group(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT g.id, g.organizer_id AS organizerId, g.name, g.slug, g.description, g.cover_image AS coverImage, CASE WHEN g.cover_image IS NULL THEN NULL ELSE CONCAT('/uploads/group-covers/', g.cover_image) END AS coverImageUrl, g.visibility, g.status, g.created_at AS createdAt, g.updated_at AS updatedAt,
      owner.name AS organizerName, COUNT(DISTINCT members.user_id) AS memberCount, gm.role AS membershipRole, group_ratings.ratingAverage, COALESCE(group_ratings.ratedEventCount, 0) AS ratedEventCount,
      IF(gm.user_id IS NULL, FALSE, TRUE) AS isMember, IF(g.organizer_id = ?, TRUE, FALSE) AS isOrganizer
      FROM event_groups g JOIN users owner ON owner.id = g.organizer_id
      LEFT JOIN (SELECT e.group_id, ROUND(AVG(event_averages.ratingAverage), 2) AS ratingAverage, COUNT(*) AS ratedEventCount FROM events e JOIN (SELECT event_id, AVG(rating) AS ratingAverage FROM event_ratings GROUP BY event_id) event_averages ON event_averages.event_id = e.id WHERE e.deleted_at IS NULL GROUP BY e.group_id) group_ratings ON group_ratings.group_id = g.id
      LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active'
      LEFT JOIN group_memberships members ON members.group_id = g.id AND members.status = 'active'
      WHERE g.id = ? AND (${privileged ? 'TRUE' : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL"})
      GROUP BY g.id, gm.role, gm.user_id, owner.name, group_ratings.ratingAverage, group_ratings.ratedEventCount`, [userId, userId, id, ...(privileged ? [] : [userId])]);
    return rows[0] || null;
  }
  async groupEvents(groupId, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const params = privileged ? [groupId] : [groupId, userId];
    const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, e.title, e.short_description AS shortDescription, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.visibility, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, e.created_at AS createdAt, manager.name AS managerName, (SELECT ROUND(AVG(rating), 2) FROM event_ratings WHERE event_id = e.id) AS ratingAverage, (SELECT COUNT(*) FROM event_ratings WHERE event_id = e.id) AS ratingCount
      FROM events e JOIN users manager ON manager.id = e.manager_id
      WHERE e.group_id = ? AND e.deleted_at IS NULL AND (${privileged ? 'TRUE' : "e.manager_id = ? OR e.status = 'Archived' OR (e.status = 'Published' AND e.visibility = 'Public')"}) ORDER BY e.starts_at ASC`, params);
    return rows;
  }
  async updateGroup(id, userId, role, data) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(`UPDATE event_groups SET name = ?, description = ?, visibility = ? WHERE id = ?${globalAccess ? '' : ' AND organizer_id = ?'}`, globalAccess ? [data.name, data.description, data.visibility, id] : [data.name, data.description, data.visibility, id, userId]);
    return result.affectedRows > 0;
  }
  async setGroupCover(id, userId, role, coverImage) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(`UPDATE event_groups SET cover_image = ? WHERE id = ?${globalAccess ? '' : ' AND organizer_id = ?'}`, globalAccess ? [coverImage, id] : [coverImage, id, userId]);
    return result.affectedRows > 0;
  }
  async groupForCover(filename, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT g.id, (g.visibility = 'Public') AS publiclyVisible FROM event_groups g LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active' WHERE g.cover_image = ? AND (${privileged ? 'TRUE' : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL"})`,
      privileged ? [userId, filename] : [userId, filename, userId],
    );
    return rows[0] ? { ...rows[0], publiclyVisible: Boolean(rows[0].publiclyVisible) } : null;
  }
  async deleteGroup(id, userId, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(`DELETE FROM event_groups WHERE id = ?${globalAccess ? '' : ' AND organizer_id = ?'}`, globalAccess ? [id] : [id, userId]);
    return result.affectedRows > 0;
  }
  async joinGroup(id, userId) {
    const [groups] = await this.database.execute('SELECT id, visibility FROM event_groups WHERE id = ?', [id]);
    if (!groups[0]) return { error: 'NOT_FOUND' };
    if (groups[0].visibility !== 'Public') return { error: 'PRIVATE' };
    const [result] = await this.database.execute("INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'", [id, userId]);
    return { joined: result.affectedRows > 0 };
  }
  async leaveGroup(id, userId) { const [result] = await this.database.execute("DELETE FROM group_memberships WHERE group_id = ? AND user_id = ? AND role = 'member'", [id, userId]); return result.affectedRows > 0; }
  async groupMembers(id, userId, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT gm.user_id AS userId, u.name, u.email, u.profile_picture AS profilePicture, gm.role, gm.joined_at AS joinedAt
      FROM group_memberships gm JOIN event_groups g ON g.id = gm.group_id JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?${globalAccess ? '' : ' AND g.organizer_id = ?'} ORDER BY gm.role = 'owner' DESC, gm.joined_at ASC`, globalAccess ? [id] : [id, userId]);
    return rows;
  }
  async groupMember(groupId, userId) { const [rows] = await this.database.execute('SELECT gm.user_id AS userId, u.name, u.email, u.profile_picture AS profilePicture, gm.role, gm.status, gm.joined_at AS joinedAt FROM group_memberships gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.user_id = ?', [groupId, userId]); return rows[0] || null; }
  async addGroupMember(groupId, { userId = null, email = null }) {
    const [groups] = await this.database.execute('SELECT visibility FROM event_groups WHERE id = ?', [groupId]);
    if (!groups[0]) return { error: 'NOT_FOUND' };
    if (groups[0].visibility === 'Private') return { error: 'PRIVATE' };
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const [users] = await this.database.execute(userId ? 'SELECT id, isEmailConfirmed FROM users WHERE id = ?' : 'SELECT id, isEmailConfirmed FROM users WHERE LOWER(email) = ?', [userId || normalizedEmail]);
    const user = users[0];
    if (!user) return { error: 'USER_NOT_FOUND' };
    if (!user.isEmailConfirmed) return { error: 'EMAIL_NOT_VERIFIED' };
    const [result] = await this.database.execute("INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'", [groupId, user.id]);
    return { added: result.affectedRows > 0, member: await this.groupMember(groupId, user.id) };
  }
  async createGroupInvitation(groupId, inviterId, { userId = null, email = null }, tokenHash) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const [groups] = await this.database.execute('SELECT id, name, visibility FROM event_groups WHERE id = ?', [groupId]);
    const group = groups[0];
    if (!group) return { error: 'NOT_FOUND' };
    if (group.visibility !== 'Private') return { error: 'NOT_PRIVATE' };
    const [users] = await this.database.execute(userId ? 'SELECT id, name, email FROM users WHERE id = ?' : 'SELECT id, name, email FROM users WHERE LOWER(email) = ?', [userId || normalizedEmail]);
    const user = users[0] || null;
    const recipientEmail = (user?.email || normalizedEmail).toLowerCase();
    if (!recipientEmail) return { error: 'USER_NOT_FOUND' };
    const [memberships] = await this.database.execute('SELECT role, status FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, user?.id || null]);
    if (memberships[0]?.status === 'active') return { error: 'ALREADY_MEMBER' };
    await this.database.execute(`INSERT INTO group_invitations (group_id, invited_by_user_id, invited_user_id, email, token_hash, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 14 DAY))
      ON DUPLICATE KEY UPDATE invited_by_user_id = VALUES(invited_by_user_id), invited_user_id = VALUES(invited_user_id), token_hash = VALUES(token_hash), status = 'pending', expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP`, [groupId, inviterId, user?.id || null, recipientEmail, tokenHash]);
    const [invitations] = await this.database.execute('SELECT id, email, expires_at AS expiresAt FROM group_invitations WHERE group_id = ? AND email = ?', [groupId, recipientEmail]);
    return { invitation: invitations[0], group, recipient: { id: user?.id || null, name: user?.name || null, email: recipientEmail } };
  }
  async groupInvitations(groupId) { const [rows] = await this.database.execute(`SELECT i.id, i.group_id AS groupId, i.invited_user_id AS invitedUserId, COALESCE(u.name, i.email) AS recipientName, i.email AS recipientEmail,
    i.status, i.created_at AS createdAt, i.updated_at AS updatedAt, i.expires_at AS expiresAt, IF(i.expires_at <= NOW() AND i.status = 'pending', TRUE, FALSE) AS isExpired
    FROM group_invitations i LEFT JOIN users u ON u.id = i.invited_user_id WHERE i.group_id = ? ORDER BY i.created_at DESC`, [groupId]); return rows; }
  async respondToGroupInvitation(token, action) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT i.id, i.group_id AS groupId, i.invited_user_id AS invitedUserId, i.email, i.status, i.expires_at AS expiresAt, g.name AS groupName
        FROM group_invitations i JOIN event_groups g ON g.id = i.group_id WHERE i.token_hash = ? FOR UPDATE`, [tokenHash]);
      const invitation = rows[0];
      if (!invitation || invitation.status !== 'pending' || new Date(invitation.expiresAt).getTime() <= Date.now()) { await connection.rollback(); return { error: 'INVALID' }; }
      if (action === 'decline') {
        await connection.execute("UPDATE group_invitations SET status = 'declined' WHERE id = ?", [invitation.id]);
        await connection.commit();
        return { status: 'declined', groupId: invitation.groupId, groupName: invitation.groupName };
      }
      const [users] = await connection.execute('SELECT id, name, isEmailConfirmed FROM users WHERE LOWER(email) = LOWER(?) FOR UPDATE', [invitation.email]);
      const user = users[0];
      if (!user) { await connection.rollback(); return { error: 'ACCOUNT_REQUIRED', email: invitation.email }; }
      if (!user.isEmailConfirmed) { await connection.rollback(); return { error: 'EMAIL_NOT_VERIFIED' }; }
      await connection.execute("INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'", [invitation.groupId, user.id]);
      await connection.execute("UPDATE group_invitations SET status = 'accepted', invited_user_id = ? WHERE id = ?", [user.id, invitation.id]);
      await connection.commit();
      return { status: 'accepted', groupId: invitation.groupId, groupName: invitation.groupName, userId: user.id, name: user.name };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async removeGroupMember(groupId, userId) {
    const member = await this.groupMember(groupId, userId);
    if (!member) return { error: 'NOT_FOUND' };
    if (member.role === 'owner') return { error: 'OWNER' };
    const [result] = await this.database.execute("DELETE FROM group_memberships WHERE group_id = ? AND user_id = ? AND role = 'member'", [groupId, userId]);
    return result.affectedRows ? { removed: true } : { error: 'NOT_FOUND' };
  }
  async canManageGroup(id, userId, role) {
    if (['manager', 'admin'].includes(role)) { const [rows] = await this.database.execute('SELECT id FROM event_groups WHERE id = ?', [id]); return rows.length > 0; }
    const [rows] = await this.database.execute('SELECT id FROM event_groups WHERE id = ? AND organizer_id = ?', [id, userId]);
    return rows.length > 0;
  }
  async groupExists(id) { const [rows] = await this.database.execute('SELECT id FROM event_groups WHERE id = ?', [id]); return rows.length > 0; }
  async pendingGroupEventNotifications(eventId) {
    const [rows] = await this.database.execute(`SELECT u.id AS userId, u.name, u.email, g.id AS groupId, g.name AS groupName, e.id AS eventId, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone
      FROM events e JOIN event_groups g ON g.id = e.group_id JOIN group_memberships gm ON gm.group_id = g.id AND gm.role = 'member' AND gm.status = 'active' JOIN users u ON u.id = gm.user_id
      LEFT JOIN group_event_notifications n ON n.event_id = e.id AND n.user_id = u.id
      WHERE e.id = ? AND n.user_id IS NULL`, [eventId]);
    return rows;
  }
  async claimGroupEventNotification(eventId, userId) { const [result] = await this.database.execute('INSERT IGNORE INTO group_event_notifications (event_id, user_id) VALUES (?, ?)', [eventId, userId]); return result.affectedRows > 0; }
  async releaseGroupEventNotification(eventId, userId) { await this.database.execute('DELETE FROM group_event_notifications WHERE event_id = ? AND user_id = ?', [eventId, userId]); }
  async groupForEvent(eventId) { const [rows] = await this.database.execute('SELECT e.group_id AS groupId, g.name AS groupName FROM events e LEFT JOIN event_groups g ON g.id = e.group_id WHERE e.id = ?', [eventId]); return rows[0] || null; }
  async eventCategories() { const [rows] = await this.database.execute('SELECT id, name, slug, description, icon, sort_order AS sortOrder FROM event_categories WHERE is_active = TRUE ORDER BY sort_order, name'); return rows; }
  async eventTypes() { const [rows] = await this.database.execute('SELECT id, name, slug, description FROM event_types WHERE is_active = TRUE ORDER BY name'); return rows; }
  async taxonomyExists(categoryId, typeId) { const [categories] = await this.database.execute('SELECT id FROM event_categories WHERE id = ? AND is_active = TRUE', [categoryId]); const [types] = await this.database.execute('SELECT id FROM event_types WHERE id = ? AND is_active = TRUE', [typeId]); return categories.length > 0 && types.length > 0; }
  async eventLocationVenue(id) {
    const [rows] = await this.database.execute("SELECT id, timezone FROM venues WHERE id = ? AND COALESCE(is_active, TRUE) = TRUE AND moderation_status = 'approved'", [id]);
    return rows[0] || null;
  }
  richEventInsertValues(data, occurrenceNumber = 1) {
    const recurrence = data.recurrence || { frequency: 'none', interval: 1, count: 1 };
    const values = [data.managerId, data.title, data.shortDescription, data.description, data.coverImage, data.categoryId, data.typeId,
      data.locationType, data.locationVisibility, data.startsAt, data.endsAt,
      data.timezone, data.capacity, data.minimumAttendees, data.registrationDeadline, data.minimumAge, data.languageCode,
      data.whatToBring, data.meetingInstructions, data.cancellationPolicy, data.pricingType, data.fee, data.currency,
      data.registrationType, data.externalRegistrationUrl, data.visibility, data.groupId, recurrence.frequency, recurrence.interval, recurrence.count, occurrenceNumber,
      data.venueId, data.customAddressLine1, data.customAddressLine2, data.customPostalCode, data.customLocality, data.customMunicipality, data.customRegion,
      data.customCountry, data.customCountryCode, data.customLatitude, data.customLongitude, data.customGooglePlaceId, data.customFormattedAddress,
      data.onlineUrl, data.onlinePlatform];
    return values.map((value) => value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : value);
  }
  async insertRichEvent(connection, data, occurrenceNumber) {
    const values = this.richEventInsertValues(data, occurrenceNumber);
    if (values.length !== 46) throw new Error(`Rich event parameter contract failed: expected 46 values, received ${values.length}.`);
    const placeholders = values.map(() => '?').join(', ');
    const [result] = await connection.query(`INSERT INTO events
      (manager_id, title, short_description, description, cover_image, category_id, type_id, location_type, location_visibility, starts_at, ends_at, timezone, capacity, minimum_attendees, registration_deadline, minimum_age,
       language_code, what_to_bring, meeting_instructions, cancellation_policy, pricing_type, participation_fee, currency,
       registration_type, external_registration_url, visibility, group_id, recurrence_frequency, recurrence_interval, recurrence_count, occurrence_number,
       venue_id, custom_address_line_1, custom_address_line_2, custom_postal_code, custom_locality, custom_municipality, custom_region,
       custom_country, custom_country_code, custom_latitude, custom_longitude, custom_google_place_id, custom_formatted_address, online_url, online_platform, status)
      VALUES (${placeholders}, 'Draft')`, values);
    return result.insertId;
  }
  recurringDate(date, frequency, interval) {
    const next = new Date(date);
    if (frequency === 'daily') next.setUTCDate(next.getUTCDate() + interval);
    else if (frequency === 'weekly') next.setUTCDate(next.getUTCDate() + interval * 7);
    else {
      const day = next.getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + interval);
      const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
      next.setUTCDate(Math.min(day, lastDay));
    }
    return next;
  }
  async createRichEventSeries(data, { bookVenue = false, role, buyerBillingProfileId } = {}) {
    const recurrence = data.recurrence || { frequency: 'none', interval: 1, count: 1 };
    const count = recurrence.frequency === 'none' ? 1 : recurrence.count;
    const connection = await this.database.getConnection();
    const requestBookings = async (eventIds) => {
      if (!bookVenue || !data.venueId || !data.startsAt || !data.endsAt) return;
      for (const eventId of eventIds) {
        const result = await this.requestVenueBookingOnConnection(connection, eventId, data.venueId, data.managerId, role, buyerBillingProfileId);
        if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
      }
    };
    try {
      await connection.beginTransaction();
      if (count === 1) {
        const eventId = await this.insertRichEvent(connection, data, 1);
        await requestBookings([eventId]);
        await connection.commit();
        return { seriesId: null, eventIds: [eventId] };
      }
      if (!data.startsAt) throw new Error('Recurring events require a start date.');
      const startsAt = new Date(`${data.startsAt.replace(' ', 'T')}Z`);
      const endsAt = data.endsAt ? new Date(`${data.endsAt.replace(' ', 'T')}Z`) : null;
      const duration = endsAt ? endsAt.getTime() - startsAt.getTime() : null;
      const localStart = zonedDateTime(startsAt, data.timezone);
      if (!localStart) throw new Error('Recurring event requires a valid IANA timezone.');
      const eventIds = [];
      for (let occurrenceNumber = 1; occurrenceNumber <= count; occurrenceNumber += 1) {
        const occurrenceDate = occurrenceNumber === 1 ? localStart.date : this.recurringDate(new Date(`${localStart.date}T12:00:00Z`), recurrence.frequency, recurrence.interval * (occurrenceNumber - 1)).toISOString().slice(0, 10);
        const occurrenceStart = occurrenceNumber === 1 ? startsAt : localDateTimeToUtc(occurrenceDate, localStart.time, data.timezone, 'start');
        if (!occurrenceStart) throw new Error('A recurring event falls on a non-existent local time due to daylight saving time.');
        const occurrence = { ...data, startsAt: occurrenceStart.toISOString().slice(0, 19).replace('T', ' '), endsAt: duration === null ? null : new Date(occurrenceStart.getTime() + duration).toISOString().slice(0, 19).replace('T', ' ') };
        eventIds.push(await this.insertRichEvent(connection, occurrence, occurrenceNumber));
      }
      const seriesId = count > 1 ? eventIds[0] : null;
      if (seriesId) await connection.query(`UPDATE events SET series_id = ? WHERE id IN (${eventIds.map(() => '?').join(', ')})`, [seriesId, ...eventIds]);
      await requestBookings(eventIds);
      await connection.commit();
      return { seriesId, eventIds };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async createRichEvent(data) { return (await this.createRichEventSeries(data)).eventIds[0]; }
  async updateRichEventAndBooking(id, userId, role, data, buyerBillingProfileId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const privileged = ['manager', 'admin'].includes(role);
      const [events] = await connection.execute(`SELECT manager_id AS managerId FROM events WHERE id=? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id=?'} FOR UPDATE`, privileged ? [id] : [id, userId]);
      if (!events[0]) { await connection.rollback(); return false; }
      const [bookings] = await connection.execute('SELECT venue_id AS venueId, start_at AS startAt, end_at AS endAt, status FROM venue_bookings WHERE event_id=? FOR UPDATE', [id]);
      const booking = bookings[0];
      if (booking && ['requested', 'confirmed'].includes(booking.status)
        && (Number(booking.venueId) !== Number(data.venueId) || utcTimestamp(booking.startAt) !== utcTimestamp(data.startsAt) || utcTimestamp(booking.endAt) !== utcTimestamp(data.endsAt))) {
        throw Object.assign(new Error('Cancel the active booking before changing the venue or booking time.'), { code: 'EVENT_ALREADY_BOOKED' });
      }
      if (!await this.updateRichEvent(id, userId, role, data, connection)) { await connection.rollback(); return false; }
      // Saving a previously untimed draft (or an older draft whose request
      // failed) must create the missing booking. Preserve existing decisions.
      if (!booking && data.venueId && data.startsAt && data.endsAt) {
        const result = await this.requestVenueBookingOnConnection(connection, id, data.venueId, events[0].managerId, role, buyerBillingProfileId);
        if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
      }
      await connection.commit();
      return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async updateRichEvent(id, managerId, role, data, executor = this.database) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?';
    const params = [data.title, data.shortDescription, data.description, data.coverImage, data.categoryId, data.typeId,
      data.locationType, data.locationVisibility, data.startsAt, data.endsAt,
      data.timezone, data.capacity, data.minimumAttendees, data.registrationDeadline, data.minimumAge, data.languageCode,
      data.whatToBring, data.meetingInstructions, data.cancellationPolicy, data.pricingType, data.fee, data.currency,
      data.registrationType, data.externalRegistrationUrl, data.visibility, data.venueId, data.customAddressLine1, data.customAddressLine2,
      data.customPostalCode, data.customLocality, data.customMunicipality, data.customRegion, data.customCountry, data.customCountryCode,
      data.customLatitude, data.customLongitude, data.customGooglePlaceId, data.customFormattedAddress, data.onlineUrl, data.onlinePlatform, id]
      .map((value) => value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : value);
    if (!['manager', 'admin'].includes(role)) params.push(managerId);
    const [result] = await executor.query(`UPDATE events SET title=?, short_description=?, description=?, cover_image=?, category_id=?, type_id=?, location_type=?, location_visibility=?, starts_at=?, ends_at=?, timezone=?, capacity=?, minimum_attendees=?, registration_deadline=?, minimum_age=?, language_code=?, what_to_bring=?, meeting_instructions=?, cancellation_policy=?, pricing_type=?, participation_fee=?, currency=?, registration_type=?, external_registration_url=?, visibility=?, venue_id=?, custom_address_line_1=?, custom_address_line_2=?, custom_postal_code=?, custom_locality=?, custom_municipality=?, custom_region=?, custom_country=?, custom_country_code=?, custom_latitude=?, custom_longitude=?, custom_google_place_id=?, custom_formatted_address=?, online_url=?, online_platform=? WHERE id=? AND deleted_at IS NULL${scope}`, params);
    return result.affectedRows > 0;
  }
  async updateEventSchedule(id, managerId, role, { startsAt, endsAt, venueId, timezone }) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?';
    const params = [startsAt, endsAt, timezone, venueId, id];
    if (!['manager', 'admin'].includes(role)) params.push(managerId);
    const [result] = await this.database.execute(`UPDATE events SET starts_at=?, ends_at=?, timezone=?, venue_id=?, location_type='venue'
      WHERE id=? AND deleted_at IS NULL${scope}`, params);
    return result.affectedRows > 0;
  }
  async setEventCover(id, managerId, role, coverImage) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(`SELECT COALESCE(series_id, id) AS seriesId FROM events WHERE id = ? AND deleted_at IS NULL${globalAccess ? '' : ' AND manager_id = ?'}`, globalAccess ? [id] : [id, managerId]);
    if (!events[0]) return false;
    const [result] = await this.database.execute('UPDATE events SET cover_image = ? WHERE id = ? OR series_id = ?', [coverImage, events[0].seriesId, events[0].seriesId]);
    return result.affectedRows > 0;
  }
  async eventCoverVisible(filename, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const visibility = privileged ? 'TRUE' : "(e.status = 'Published' AND e.visibility = 'Public') OR e.manager_id = ?";
    const [rows] = await this.database.execute(
      `SELECT e.id, (e.status = 'Published' AND e.visibility = 'Public') AS publiclyVisible FROM events e WHERE BINARY e.cover_image = BINARY ? AND e.deleted_at IS NULL AND (${visibility}) LIMIT 1`,
      privileged ? [filename] : [filename, userId],
    );
    return rows[0] ? { ...rows[0], publiclyVisible: Boolean(rows[0].publiclyVisible) } : null;
  }
  normalizeRichEventLocation(event, { publicView = false } = {}) {
    if (!event) return null;
    const normalized = { ...event };
    // All occurrence fields exposed by the API are unambiguous UTC instants.
    // The event timezone remains the canonical local-time context.
    for (const key of ['startsAt', 'endsAt', 'registrationDeadline', 'publishedAt', 'createdAt', 'updatedAt']) normalized[key] = utcTimestamp(normalized[key]);
    for (const key of ['customLatitude', 'customLongitude']) if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    const customLocation = {
      addressLine1: normalized.customAddressLine1 || null,
      addressLine2: normalized.customAddressLine2 || null,
      postalCode: normalized.customPostalCode || null,
      locality: normalized.customLocality || null,
      municipality: normalized.customMunicipality || null,
      region: normalized.customRegion || null,
      country: normalized.customCountry || null,
      countryCode: normalized.customCountryCode || null,
      latitude: normalized.customLatitude ?? null,
      longitude: normalized.customLongitude ?? null,
      googlePlaceId: normalized.customGooglePlaceId || null,
      formattedAddress: normalized.customFormattedAddress || null,
    };
    if (normalized.locationType === 'venue') {
      const venue = this.normalizeVenue({
        id: normalized.venueId, name: normalized.venueName, addressLine1: normalized.venueAddressLine1, addressLine2: normalized.venueAddressLine2,
        postalCode: normalized.venuePostalCode, city: normalized.venueCity, municipality: normalized.venueMunicipality, region: normalized.venueRegion,
        country: normalized.venueCountry, countryCode: normalized.venueCountryCode, latitude: normalized.venueLatitude, longitude: normalized.venueLongitude,
        googlePlaceId: normalized.venueGooglePlaceId, formattedAddress: normalized.venueFormattedAddress, locationVisibility: normalized.venueLocationVisibility, timezone: normalized.venueTimezone,
      }, { publicView });
      normalized.venue = venue?.id ? { id: venue.id, name: venue.name, location: venue.location, timezone: venue.timezone } : null;
      normalized.location = null;
    } else if (normalized.locationType === 'online') {
      normalized.venue = null;
      normalized.location = null;
      normalized.onlineUrl = publicView ? null : normalized.onlineUrl || null;
    } else {
      normalized.venue = null;
      normalized.location = customLocation;
    }
    for (const key of ['customAddressLine1', 'customAddressLine2', 'customPostalCode', 'customLocality', 'customMunicipality', 'customRegion', 'customCountry', 'customCountryCode', 'customLatitude', 'customLongitude', 'customGooglePlaceId', 'customFormattedAddress', 'venueId', 'venueName', 'venueBusinessName', 'venueLocation', 'venueAddressLine1', 'venueAddressLine2', 'venuePostalCode', 'venueCity', 'venueMunicipality', 'venueRegion', 'venueCountry', 'venueCountryCode', 'venueLatitude', 'venueLongitude', 'venueGooglePlaceId', 'venueFormattedAddress', 'venueLocationVisibility', 'venueTimezone']) delete normalized[key];
    return normalized;
  }
  async richEvent(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.query(`SELECT e.id, e.manager_id AS managerId, e.title, e.short_description AS shortDescription, e.description, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl,
      e.category_id AS categoryId, c.name AS categoryName, e.type_id AS typeId, t.name AS typeName,
      e.location_type AS locationType, e.location_visibility AS locationVisibility, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone,
      e.capacity, e.minimum_attendees AS minimumAttendees, e.registration_deadline AS registrationDeadline, e.minimum_age AS minimumAge, e.language_code AS languageCode,
      e.what_to_bring AS whatToBring, e.meeting_instructions AS meetingInstructions, e.cancellation_policy AS cancellationPolicy,
      e.pricing_type AS pricingType, e.participation_fee AS fee, e.currency, e.registration_type AS registrationType, e.external_registration_url AS externalRegistrationUrl,
      e.visibility, e.status, e.published_at AS publishedAt, e.created_at AS createdAt, e.updated_at AS updatedAt, u.name AS managerName,
      e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber,
      e.venue_id AS venueId, v.timezone AS venueTimezone, e.custom_address_line_1 AS customAddressLine1, e.custom_address_line_2 AS customAddressLine2, e.custom_postal_code AS customPostalCode, e.custom_locality AS customLocality, e.custom_municipality AS customMunicipality, e.custom_region AS customRegion, e.custom_country AS customCountry, e.custom_country_code AS customCountryCode, e.custom_latitude AS customLatitude, e.custom_longitude AS customLongitude, e.custom_google_place_id AS customGooglePlaceId, e.custom_formatted_address AS customFormattedAddress, e.online_url AS onlineUrl, e.online_platform AS onlinePlatform,
      vb.id AS venueBookingId, vb.status AS venueBookingStatus, v.name AS venueName, v.business_name AS venueBusinessName, v.formatted_address AS venueLocation, v.address_line_1 AS venueAddressLine1, v.address_line_2 AS venueAddressLine2, v.postal_code AS venuePostalCode, v.city AS venueCity, v.municipality AS venueMunicipality, v.region AS venueRegion, v.country AS venueCountry, v.country_code AS venueCountryCode, v.latitude AS venueLatitude, v.longitude AS venueLongitude, v.google_place_id AS venueGooglePlaceId, v.formatted_address AS venueFormattedAddress, v.location_visibility AS venueLocationVisibility,
      (SELECT ROUND(AVG(rating), 2) FROM event_ratings WHERE event_id = e.id) AS ratingAverage, (SELECT COUNT(*) FROM event_ratings WHERE event_id = e.id) AS ratingCount,
      (SELECT rating FROM event_ratings WHERE event_id = e.id AND user_id = ?) AS myRating
      FROM events e JOIN users u ON u.id=e.manager_id LEFT JOIN event_categories c ON c.id=e.category_id LEFT JOIN event_types t ON t.id=e.type_id LEFT JOIN event_groups g ON g.id=e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id LEFT JOIN venues v ON v.id = e.venue_id
      WHERE e.id=? AND e.deleted_at IS NULL AND (${privileged ? 'TRUE' : "e.visibility = 'Public' AND e.status = 'Published'"}${userId && !privileged ? ' OR e.manager_id = ?' : ''})`, userId && !privileged ? [userId, id, userId] : [userId, id]);
    return this.normalizeRichEventLocation(rows[0], { publicView: !privileged && (!userId || rows[0]?.managerId !== userId) });
  }
  async publishRichEvent(id, managerId, role) { const privileged = ['manager', 'admin'].includes(role); const [events] = await this.database.execute(`SELECT COALESCE(series_id, id) AS seriesId FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? [id] : [id, managerId]); if (!events[0]) return false; const [result] = await this.database.execute('UPDATE events SET status = ?, published_at = COALESCE(published_at, NOW()) WHERE deleted_at IS NULL AND (id = ? OR series_id = ?)', ['Published', events[0].seriesId, events[0].seriesId]); return result.affectedRows > 0; }
  async updateEventStatus(id, userId, status, role) { const globalAccess = ['manager', 'admin'].includes(role); const ownership = globalAccess ? '' : ' AND manager_id = ?'; const params = globalAccess ? [status, id] : [status, id, userId]; const [result] = await this.database.execute(`UPDATE events SET status = ? WHERE id = ?${ownership}`, params); return result.affectedRows > 0; }
  async registrations(eventId, managerId, isAdmin = false) { await this.database.execute("UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.payment_status = CASE WHEN e.participation_fee > 0 THEN 'Payment Required' ELSE 'Not Required' END WHERE r.event_id = ? AND r.status <> 'Withdrawn' AND r.payment_status <> 'Paid'", [eventId]); const ownership = isAdmin ? '' : ' AND e.manager_id = ?'; const params = isAdmin ? [eventId] : [eventId, managerId]; const [rows] = await this.database.execute(`SELECT r.id, r.event_id AS eventId, r.user_id AS userId, r.status, r.payment_status AS paymentStatus, r.created_at AS createdAt, COALESCE(u.name, r.attendee_name) AS name, COALESCE(r.attendee_email, u.email) AS email, COALESCE(r.attendee_phone, u.phone) AS phone FROM event_registrations r JOIN events e ON e.id = r.event_id LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status <> 'Withdrawn'${ownership} ORDER BY r.created_at DESC`, params); return rows; }
  async userRegistrations(userId) { const [rows] = await this.database.execute('SELECT r.id, r.event_id AS eventId, r.status, r.created_at AS createdAt, e.title, e.custom_formatted_address AS location, e.starts_at AS startsAt FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.user_id = ? ORDER BY r.created_at DESC', [userId]); return rows; }
  async registration(id, managerId) { const [rows] = await this.database.execute("SELECT r.id, r.event_id AS eventId, r.user_id AS userId, r.status, COALESCE(r.attendee_email, u.email) AS email, COALESCE(u.name, r.attendee_name) AS name, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone, e.capacity FROM event_registrations r JOIN events e ON e.id = r.event_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status <> 'Withdrawn' AND e.manager_id = ?", [id, managerId]); return rows[0]; }
  async existingEventRegistration(eventId, userId = null, email = null) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
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
  async registerForEvent(eventId, userId, email) { const [event] = await this.database.execute('SELECT e.id, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone, e.capacity, e.status, manager.email AS managerEmail, manager.name AS managerName, (SELECT COUNT(*) FROM event_registrations WHERE event_id = ? AND status IN (\'Pending\', \'Confirmed\')) AS registered FROM events e JOIN users manager ON manager.id = e.manager_id WHERE e.id = ?', [eventId, eventId]); if (!event[0] || event[0].status !== 'Published') return { error: 'EVENT_UNAVAILABLE' }; const existing = await this.existingEventRegistration(eventId, userId, email); if (existing && !(existing.source === 'registration' && existing.status === 'Withdrawn')) return { error: 'ALREADY_REGISTERED' }; if (event[0].capacity !== null && event[0].registered >= event[0].capacity) return { error: 'EVENT_FULL' }; const normalizedEmail = String(email || '').trim().toLowerCase() || null; const id = existing ? existing.id : (await this.database.execute('INSERT INTO event_registrations (event_id, user_id, attendee_email, status) VALUES (?, ?, ?, \'Pending\')', [eventId, userId, normalizedEmail]))[0].insertId; if (existing) await this.database.execute("UPDATE event_registrations SET user_id = COALESCE(user_id, ?), attendee_email = ?, status = 'Pending', payment_status = CASE WHEN payment_status = 'Paid' THEN 'Paid' ELSE 'Payment Required' END WHERE id = ?", [userId, normalizedEmail, id]); await this.database.execute('DELETE i FROM event_invitations i JOIN users u ON LOWER(u.email) = LOWER(i.email) WHERE i.event_id = ? AND u.id = ? AND i.status = \'Pending\'', [eventId, userId]); return { id, ...event[0] }; }
  async updateRegistrationStatus(id, managerId, status, isAdmin = false) { const ownership = isAdmin ? '' : ' AND e.manager_id = ?'; const params = isAdmin ? [status, id] : [status, id, managerId]; const [result] = await this.database.execute(`UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.status = ? WHERE r.id = ? AND r.status <> 'Withdrawn'${ownership}`, params); if (result.affectedRows && status === 'Confirmed') { const [registration] = await this.database.execute('SELECT r.event_id AS eventId, r.user_id AS userId, COALESCE(u.name, r.attendee_name) AS name, COALESCE(r.attendee_email, u.email) AS email, COALESCE(r.attendee_phone, u.phone) AS phone, r.payment_status AS paymentStatus FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?', [id]); if (registration[0] && registration[0].name) { await this.database.execute('INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, payment_status) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE participant_name = VALUES(participant_name), participant_email = VALUES(participant_email), participant_phone = VALUES(participant_phone), payment_status = VALUES(payment_status)', [registration[0].eventId, registration[0].userId, registration[0].name, registration[0].email, registration[0].phone, registration[0].paymentStatus]); await this.database.execute('DELETE FROM event_registrations WHERE id = ?', [id]); } } if (result.affectedRows && ['Cancelled', 'Declined', 'Withdrawn'].includes(status)) { const [registration] = await this.database.execute('SELECT event_id AS eventId, user_id AS userId, attendee_email AS email FROM event_registrations WHERE id = ?', [id]); if (registration[0]) await this.database.execute('DELETE FROM event_participants WHERE event_id = ? AND (user_id = ? OR (user_id IS NULL AND participant_email = ?))', [registration[0].eventId, registration[0].userId, registration[0].email]); } return result.affectedRows > 0; }
  async withdrawRegistration(id, userId) { const [result] = await this.database.execute('UPDATE event_registrations SET status = \'Withdrawn\' WHERE id = ? AND user_id = ? AND status NOT IN (\'Attended\', \'Withdrawn\')', [id, userId]); return result.affectedRows > 0; }
  async findActiveRegistrationForUser(eventId, userId) { const [rows] = await this.database.execute(`SELECT id, source FROM (SELECT r.id, 'registration' AS source FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status IN ('Pending', 'Confirmed') AND (r.user_id = ? OR (r.user_id IS NULL AND LOWER(r.attendee_email) = LOWER((SELECT email FROM users WHERE id = ?)))) UNION ALL SELECT p.id, 'participant' AS source FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? AND p.status = 'Pending' AND (p.user_id = ? OR (p.user_id IS NULL AND LOWER(p.participant_email) = LOWER((SELECT email FROM users WHERE id = ?))))) active_records LIMIT 1`, [eventId, userId, userId, eventId, userId, userId]); return rows[0] || null; }
  async markRegistrationWithdrawn(registration) { if (registration.source === 'participant') { const [result] = await this.database.execute('DELETE FROM event_participants WHERE id = ?', [registration.id]); return result.affectedRows > 0; } const [result] = await this.database.execute("UPDATE event_registrations SET status = 'Withdrawn' WHERE id = ? AND status IN ('Pending', 'Confirmed')", [registration.id]); return result.affectedRows > 0; }
  async customerRegistration(id, userId) { const [rows] = await this.database.execute('SELECT r.id, u.email, u.name, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone, e.capacity FROM event_registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id WHERE r.id = ? AND r.user_id = ?', [id, userId]); return rows[0]; }
  async createInvitation(eventId, managerId, name, email) { const [event] = await this.database.execute('SELECT id, title, description, custom_formatted_address AS location, starts_at AS startsAt, ends_at AS endsAt, timezone FROM events WHERE id = ? AND manager_id = ?', [eventId, managerId]); if (!event[0]) return { error: 'EVENT_NOT_FOUND' }; const token = crypto.randomBytes(32).toString('hex'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); try { await this.database.execute('INSERT INTO event_invitations (event_id, manager_id, name, email, token_hash, token_expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [eventId, managerId, name, email, tokenHash]); return { ...event[0], invitationToken: token }; } catch (error) { if (error.code === 'ER_DUP_ENTRY') return { error: 'ALREADY_INVITED' }; throw error; } }
  async resendInvitation(eventId, invitationId, managerId) { const [rows] = await this.database.execute('SELECT i.id AS invitationId, i.name, i.email, e.id, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone FROM event_invitations i JOIN events e ON e.id = i.event_id WHERE i.id = ? AND i.event_id = ? AND i.manager_id = ? AND i.status = \'Pending\'', [invitationId, eventId, managerId]); const invitation = rows[0]; if (!invitation) return null; const token = crypto.randomBytes(32).toString('hex'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); await this.database.execute('UPDATE event_invitations SET token_hash = ?, token_expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?', [tokenHash, invitation.invitationId]); return { ...invitation, invitationToken: token }; }
  async invitations(eventId, managerId) { const [rows] = await this.database.execute('SELECT i.id, i.event_id AS eventId, i.name, i.email, i.status, i.created_at AS createdAt FROM event_invitations i WHERE i.event_id = ? AND i.manager_id = ? ORDER BY i.created_at DESC', [eventId, managerId]); return rows; }
  async updateInvitationStatus(id, eventId, managerId, status) { const [result] = await this.database.execute('UPDATE event_invitations SET status = ? WHERE id = ? AND event_id = ? AND manager_id = ?', [status, id, eventId, managerId]); return result.affectedRows > 0; }
  async respondToInvitation(token, status) { if (status === 'Accepted') return this.acceptInvitationAsParticipant(token); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const [result] = await this.database.execute('UPDATE event_invitations SET status = ? WHERE token_hash = ? AND token_expires_at > NOW() AND status = \'Pending\'', [status, tokenHash]); if (!result.affectedRows) return null; const [rows] = await this.database.execute('SELECT id, event_id AS eventId, name, email, status FROM event_invitations WHERE token_hash = ?', [tokenHash]); return rows[0] || null; }
  async acceptInvitationAsParticipant(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [rows] = await this.database.execute('SELECT id, event_id AS eventId, name, email FROM event_invitations WHERE token_hash = ? AND token_expires_at > NOW() AND status = \'Pending\'', [tokenHash]);
    const invitation = rows[0];
    if (!invitation) return null;
    const [users] = await this.database.execute('SELECT id, phone FROM users WHERE LOWER(email) = LOWER(?)', [invitation.email]);
    const userId = users[0]?.id || null;
    const duplicate = await this.existingEventRegistration(invitation.eventId, userId, invitation.email);
    if (duplicate && !(duplicate.source === 'registration' && duplicate.status === 'Withdrawn')) return { eventId: invitation.eventId, participantId: duplicate.source === 'participant' ? duplicate.id : null, requiresRegistration: false, status: duplicate.status, alreadyRegistered: true };
    const paymentStatus = await this.eventFee(invitation.eventId) > 0 ? 'Payment Required' : 'Not Required';
    if (duplicate) await this.database.execute('DELETE FROM event_registrations WHERE id = ?', [duplicate.id]);
    const [participant] = await this.database.execute('INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, payment_status) VALUES (?, ?, ?, ?, ?, ?)', [invitation.eventId, userId, invitation.name, invitation.email, users[0]?.phone || null, paymentStatus]);
    await this.database.execute('UPDATE event_invitations SET status = \'Accepted\' WHERE id = ?', [invitation.id]);
    await this.database.execute('DELETE FROM event_invitations WHERE id = ?', [invitation.id]);
    return { eventId: invitation.eventId, participantId: participant.insertId, name: invitation.name, email: invitation.email, requiresRegistration: false, status: 'Pending', paymentStatus };
  }
  /* Retired Communities data-access methods.
  async communityPostTypes() { const [rows] = await this.database.execute('SELECT id, type_key AS typeKey, name, description, sort_order AS sortOrder FROM community_post_types WHERE is_active = TRUE ORDER BY sort_order, name'); return rows; }
  async communityCategories() { const [rows] = await this.database.execute('SELECT id, parent_id AS parentId, name, slug, description, sort_order AS sortOrder FROM community_categories WHERE is_active = TRUE ORDER BY parent_id IS NOT NULL, sort_order, name'); return rows; }
  async validCommunityTaxonomy(postTypeId, categoryId, subcategoryId = null) { const [types] = await this.database.execute('SELECT id FROM community_post_types WHERE id = ? AND is_active = TRUE', [postTypeId]); if (!types[0]) return false; const [categories] = await this.database.execute('SELECT id FROM community_categories WHERE id = ? AND parent_id IS NULL AND is_active = TRUE', [categoryId]); if (!categories[0]) return false; if (subcategoryId === null) return true; const [subcategories] = await this.database.execute('SELECT id FROM community_categories WHERE id = ? AND parent_id = ? AND is_active = TRUE', [subcategoryId, categoryId]); return Boolean(subcategories[0]); }
  communityPostColumns() { return `p.id, p.slug, p.city, p.city_slug AS citySlug, p.title, p.short_description AS shortDescription, p.body, p.location_name AS locationName, p.latitude, p.longitude, p.location_radius_km AS locationRadiusKm, p.attributes, p.external_event_name AS externalEventName, p.external_event_url AS externalEventUrl, p.external_event_at AS externalEventAt, p.visibility, IF(p.status = 'active' AND p.expires_at IS NOT NULL AND p.expires_at <= NOW(), 'expired', p.status) AS status, p.is_indexable AS isIndexable, p.expires_at AS expiresAt, p.created_at AS createdAt, p.updated_at AS updatedAt, p.author_user_id AS authorUserId, u.name AS authorName, u.profile_picture AS authorProfilePicture, pt.id AS postTypeId, pt.type_key AS postTypeKey, pt.name AS postTypeName, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, sc.id AS subcategoryId, sc.name AS subcategoryName, sc.slug AS subcategorySlug, g.id AS groupId, g.name AS groupName, g.slug AS groupSlug, COUNT(DISTINCT r.id) AS responseCount`; }
  async communityPosts({ citySlug = null, categorySlug = null, subcategorySlug = null, typeKey = null, page = 1, limit = 20 } = {}) {
    const conditions = ["p.visibility = 'public'", "p.status IN ('active', 'fulfilled')", "(p.status = 'fulfilled' OR p.expires_at IS NULL OR p.expires_at > NOW())"];
    const params = [];
    if (citySlug) { conditions.push('p.city_slug = ?'); params.push(citySlug); }
    if (categorySlug) { conditions.push('c.slug = ?'); params.push(categorySlug); }
    if (subcategorySlug) { conditions.push('sc.slug = ?'); params.push(subcategorySlug); }
    if (typeKey) { conditions.push('pt.type_key = ?'); params.push(typeKey); }
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * safeLimit;
    const [rows] = await this.database.execute(`SELECT ${this.communityPostColumns()} FROM community_posts p JOIN users u ON u.id = p.author_user_id JOIN community_post_types pt ON pt.id = p.post_type_id JOIN community_categories c ON c.id = p.category_id LEFT JOIN community_categories sc ON sc.id = p.subcategory_id LEFT JOIN event_groups g ON g.id = p.group_id LEFT JOIN community_post_responses r ON r.post_id = p.id AND r.status = 'active' WHERE ${conditions.join(' AND ')} GROUP BY p.id, u.name, u.profile_picture, pt.id, pt.type_key, pt.name, c.id, c.name, c.slug, sc.id, sc.name, sc.slug, g.id, g.name, g.slug ORDER BY p.status = 'active' DESC, p.created_at DESC LIMIT ? OFFSET ?`, [...params, safeLimit, offset]);
    return this.withCommunityPostEventLinks(rows);
  }
  async communityPostBySlug(slug, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT ${this.communityPostColumns()} FROM community_posts p JOIN users u ON u.id = p.author_user_id JOIN community_post_types pt ON pt.id = p.post_type_id JOIN community_categories c ON c.id = p.category_id LEFT JOIN community_categories sc ON sc.id = p.subcategory_id LEFT JOIN event_groups g ON g.id = p.group_id LEFT JOIN community_post_responses r ON r.post_id = p.id AND r.status = 'active' WHERE p.slug = ? AND (${privileged ? 'TRUE' : "(p.visibility = 'public' AND p.status IN ('active', 'fulfilled', 'expired')) OR p.author_user_id = ?"}) GROUP BY p.id, u.name, u.profile_picture, pt.id, pt.type_key, pt.name, c.id, c.name, c.slug, sc.id, sc.name, sc.slug, g.id, g.name, g.slug`, privileged ? [slug] : [slug, userId]);
    return (await this.withCommunityPostEventLinks(rows))[0] || null;
  }
  async communityPostForOwner(id, userId, role = null) { const privileged = ['manager', 'admin'].includes(role); const [rows] = await this.database.execute(`SELECT p.id, p.slug, p.author_user_id AS authorUserId, p.status, p.visibility, p.expires_at AS expiresAt, p.group_id AS groupId FROM community_posts p WHERE p.id = ?${privileged ? '' : ' AND p.author_user_id = ?'}`, privileged ? [id] : [id, userId]); return rows[0] || null; }
  async withCommunityPostEventLinks(posts) {
    if (!posts.length) return posts;
    const postIds = posts.map((post) => post.id);
    const placeholders = postIds.map(() => '?').join(',');
    const [links] = await this.database.execute(`SELECT post_id AS postId, event_id AS eventId FROM community_post_events WHERE post_id IN (${placeholders}) ORDER BY post_id, position`, postIds);
    const byPostId = new Map(postIds.map((id) => [id, []]));
    for (const link of links) byPostId.get(link.postId).push(link.eventId);
    return posts.map((post) => {
      const eventIds = byPostId.get(post.id) || [];
      return { ...post, eventIds };
    });
  }
  async replaceCommunityPostEvents(postId, userId, role, eventIds) {
    const privileged = ['manager', 'admin'].includes(role);
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [posts] = await connection.execute(`SELECT id FROM community_posts WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'} FOR UPDATE`, privileged ? [postId] : [postId, userId]);
      if (!posts[0]) { await connection.rollback(); return { error: 'POST_NOT_FOUND' }; }
      if (eventIds.length) {
        const placeholders = eventIds.map(() => '?').join(',');
        const [events] = await connection.execute(`SELECT id FROM events WHERE id IN (${placeholders}) AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? eventIds : [...eventIds, userId]);
        if (events.length !== eventIds.length) { await connection.rollback(); return { error: 'EVENT_NOT_FOUND' }; }
      }
      await connection.execute('DELETE FROM community_post_events WHERE post_id = ?', [postId]);
      for (const [position, eventId] of eventIds.entries()) await connection.execute('INSERT INTO community_post_events (post_id, event_id, position) VALUES (?, ?, ?)', [postId, eventId, position]);
      await connection.commit();
      return { eventIds };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async activeCommunityPost(id) { const [rows] = await this.database.execute("SELECT id, author_user_id AS authorUserId, status, visibility, expires_at AS expiresAt FROM community_posts WHERE id = ? AND visibility = 'public' AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())", [id]); return rows[0] || null; }
  async communityPostForumPost(id) { const [rows] = await this.database.execute('SELECT id, status, visibility, expires_at AS expiresAt FROM community_posts WHERE id = ?', [id]); return rows[0] || null; }
  async myCommunityPosts(userId) { const [rows] = await this.database.execute(`SELECT ${this.communityPostColumns()} FROM community_posts p JOIN users u ON u.id = p.author_user_id JOIN community_post_types pt ON pt.id = p.post_type_id JOIN community_categories c ON c.id = p.category_id LEFT JOIN community_categories sc ON sc.id = p.subcategory_id LEFT JOIN event_groups g ON g.id = p.group_id LEFT JOIN community_post_responses r ON r.post_id = p.id AND r.status = 'active' WHERE p.author_user_id = ? GROUP BY p.id, u.name, u.profile_picture, pt.id, pt.type_key, pt.name, c.id, c.name, c.slug, sc.id, sc.name, sc.slug, g.id, g.name, g.slug ORDER BY p.updated_at DESC`, [userId]); return this.withCommunityPostEventLinks(rows); }
  async createCommunityPost(data) { const [result] = await this.database.execute(`INSERT INTO community_posts (slug, author_user_id, city, city_slug, post_type_id, category_id, subcategory_id, title, short_description, body, location_name, latitude, longitude, location_radius_km, attributes, external_event_name, external_event_url, external_event_at, visibility, status, is_indexable, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [data.slug, data.authorUserId, data.city, data.citySlug, data.postTypeId, data.categoryId, data.subcategoryId, data.title, data.shortDescription, data.body, data.locationName, data.latitude, data.longitude, data.locationRadiusKm, data.attributes ? JSON.stringify(data.attributes) : null, data.externalEventName, data.externalEventUrl, data.externalEventAt, data.visibility, data.status, data.isIndexable, data.expiresAt]); return result.insertId; }
  async updateCommunityPost(id, userId, role, data) { const privileged = ['manager', 'admin'].includes(role); const [result] = await this.database.execute(`UPDATE community_posts SET city=?, city_slug=?, post_type_id=?, category_id=?, subcategory_id=?, title=?, short_description=?, body=?, location_name=?, latitude=?, longitude=?, location_radius_km=?, attributes=?, external_event_name=?, external_event_url=?, external_event_at=?, visibility=?, status=?, is_indexable=?, expires_at=? WHERE id=?${privileged ? '' : ' AND author_user_id=?'}`, [...data, id, ...(privileged ? [] : [userId])]); return result.affectedRows > 0; }
  async setCommunityPostStatus(id, userId, role, status, isIndexable = null) { const privileged = ['manager', 'admin'].includes(role); const values = [status]; let sql = 'UPDATE community_posts SET status = ?'; if (isIndexable !== null) { sql += ', is_indexable = ?'; values.push(isIndexable); } sql += ` WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'}`; values.push(id, ...(privileged ? [] : [userId])); const [result] = await this.database.execute(sql, values); return result.affectedRows > 0; }
  async addCommunityPostResponse(postId, userId, message) { const [result] = await this.database.execute("INSERT INTO community_post_responses (post_id, user_id, message, status) VALUES (?, ?, ?, 'active') ON DUPLICATE KEY UPDATE message = VALUES(message), status = 'active', updated_at = CURRENT_TIMESTAMP", [postId, userId, message]); await this.database.execute('INSERT IGNORE INTO community_post_conversations (post_id, owner_user_id, member_user_id) SELECT id, author_user_id, ? FROM community_posts WHERE id = ?', [userId, postId]); return result.insertId; }
  async communityPostResponse(postId, userId) { const [rows] = await this.database.execute('SELECT id, post_id AS postId, user_id AS userId, message, status, created_at AS createdAt, updated_at AS updatedAt FROM community_post_responses WHERE post_id = ? AND user_id = ?', [postId, userId]); return rows[0] || null; }
  async communityPostResponses(postId) { const [rows] = await this.database.execute('SELECT r.id, r.post_id AS postId, r.user_id AS userId, r.message, r.status, r.created_at AS createdAt, r.updated_at AS updatedAt, u.name, u.profile_picture AS profilePicture FROM community_post_responses r JOIN users u ON u.id = r.user_id WHERE r.post_id = ? AND r.status <> \'removed\' ORDER BY r.created_at DESC', [postId]); return rows; }
  async updateCommunityPostResponse(id, postId, status) { const [result] = await this.database.execute('UPDATE community_post_responses SET status = ? WHERE id = ? AND post_id = ?', [status, id, postId]); return result.affectedRows > 0; }
  async communityConversations(postId, ownerId) { const [rows] = await this.database.execute(`SELECT c.id, c.post_id AS postId, c.member_user_id AS memberUserId, u.name AS memberName, u.profile_picture AS memberProfilePicture, c.updated_at AS updatedAt, m.body AS lastMessage, m.created_at AS lastMessageAt,
    (SELECT COUNT(*) FROM community_post_conversation_messages unread WHERE unread.conversation_id = c.id AND unread.sender_user_id <> ? AND unread.id > COALESCE(read_state.last_read_message_id, 0)) AS unreadCount
    FROM community_post_conversations c JOIN users u ON u.id = c.member_user_id LEFT JOIN community_post_conversation_reads read_state ON read_state.conversation_id = c.id AND read_state.user_id = ? LEFT JOIN community_post_conversation_messages m ON m.id = (SELECT m2.id FROM community_post_conversation_messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.id DESC LIMIT 1)
    WHERE c.post_id = ? AND c.owner_user_id = ? ORDER BY COALESCE(m.created_at, c.updated_at) DESC`, [ownerId, ownerId, postId, ownerId]); return rows; }
  async communityConversationsForMember(memberId) { const [rows] = await this.database.execute(`SELECT c.id, c.post_id AS postId, c.owner_user_id AS ownerUserId, p.title AS postTitle, p.slug AS postSlug, u.name AS ownerName, u.profile_picture AS ownerProfilePicture, c.updated_at AS updatedAt, m.body AS lastMessage, m.created_at AS lastMessageAt,
    (SELECT COUNT(*) FROM community_post_conversation_messages unread WHERE unread.conversation_id = c.id AND unread.sender_user_id <> ? AND unread.id > COALESCE(read_state.last_read_message_id, 0)) AS unreadCount
    FROM community_post_conversations c JOIN community_posts p ON p.id = c.post_id JOIN users u ON u.id = c.owner_user_id LEFT JOIN community_post_conversation_reads read_state ON read_state.conversation_id = c.id AND read_state.user_id = ? LEFT JOIN community_post_conversation_messages m ON m.id = (SELECT m2.id FROM community_post_conversation_messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.id DESC LIMIT 1)
    WHERE c.member_user_id = ? ORDER BY COALESCE(m.created_at, c.updated_at) DESC`, [memberId, memberId, memberId]); return rows; }
  async communityConversation(postId, memberId) { const [rows] = await this.database.execute('SELECT id, post_id AS postId, owner_user_id AS ownerUserId, member_user_id AS memberUserId FROM community_post_conversations WHERE post_id = ? AND member_user_id = ?', [postId, memberId]); return rows[0] || null; }
  async communityConversationMessages(conversationId) { const [rows] = await this.database.execute('SELECT m.id, m.conversation_id AS conversationId, m.sender_user_id AS senderUserId, m.body, m.created_at AS createdAt, u.name AS senderName, u.profile_picture AS senderProfilePicture FROM community_post_conversation_messages m JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? ORDER BY m.id ASC', [conversationId]); return rows; }
  async addCommunityConversationMessage(conversationId, senderUserId, body) { const [result] = await this.database.execute('INSERT INTO community_post_conversation_messages (conversation_id, sender_user_id, body) VALUES (?, ?, ?)', [conversationId, senderUserId, body]); await this.database.execute('UPDATE community_post_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversationId]); return result.insertId; }
  async markCommunityConversationRead(conversationId, userId, lastMessageId) { if (!lastMessageId) return; await this.database.execute('INSERT INTO community_post_conversation_reads (conversation_id, user_id, last_read_message_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id)), read_at = CURRENT_TIMESTAMP', [conversationId, userId, lastMessageId]); }
  */
  forumTables(scope) { const tables = { group: { threads: 'group_forum_threads', messages: 'group_forum_messages', owner: 'group_id' }, event: { threads: 'event_forum_threads', messages: 'event_forum_messages', owner: 'event_id' } }; if (!tables[scope]) throw new Error('Invalid forum scope.'); return tables[scope]; }
  async forumThreads(scope, ownerId, userId = null) { const table = this.forumTables(scope); const [rows] = await this.database.execute(`SELECT t.id, t.${table.owner} AS ownerId, t.author_user_id AS authorUserId, t.title, t.status, t.created_at AS createdAt, t.updated_at AS updatedAt, u.name AS authorName, u.profile_picture AS authorProfilePicture, COUNT(m.id) AS messageCount,
    SUM(CASE WHEN m.author_user_id <> ? AND m.id > COALESCE(read_state.last_read_message_id, 0) THEN 1 ELSE 0 END) AS unreadCount
    FROM ${table.threads} t JOIN users u ON u.id = t.author_user_id LEFT JOIN forum_thread_reads read_state ON read_state.scope = ? AND read_state.thread_id = t.id AND read_state.user_id = ? LEFT JOIN ${table.messages} m ON m.thread_id = t.id WHERE t.${table.owner} = ? AND t.status <> 'removed' GROUP BY t.id, u.name, u.profile_picture, read_state.last_read_message_id ORDER BY t.updated_at DESC`, [userId, scope, userId, ownerId]); return rows; }
  async forumThread(scope, ownerId, threadId) { const table = this.forumTables(scope); const [rows] = await this.database.execute(`SELECT id, ${table.owner} AS ownerId, author_user_id AS authorUserId, title, status FROM ${table.threads} WHERE id = ? AND ${table.owner} = ?`, [threadId, ownerId]); return rows[0] || null; }
  async createForumThread(scope, ownerId, authorUserId, title, body) { const table = this.forumTables(scope); const [result] = await this.database.execute(`INSERT INTO ${table.threads} (${table.owner}, author_user_id, title) VALUES (?, ?, ?)`, [ownerId, authorUserId, title]); await this.database.execute(`INSERT INTO ${table.messages} (thread_id, author_user_id, body) VALUES (?, ?, ?)`, [result.insertId, authorUserId, body]); return result.insertId; }
  async forumMessages(scope, threadId) { const table = this.forumTables(scope); const [rows] = await this.database.execute(`SELECT m.id, m.thread_id AS threadId, m.author_user_id AS authorUserId, m.body, m.created_at AS createdAt, u.name AS authorName, u.profile_picture AS authorProfilePicture FROM ${table.messages} m JOIN users u ON u.id = m.author_user_id WHERE m.thread_id = ? ORDER BY m.id ASC`, [threadId]); return rows; }
  async addForumMessage(scope, threadId, authorUserId, body) { const table = this.forumTables(scope); const [result] = await this.database.execute(`INSERT INTO ${table.messages} (thread_id, author_user_id, body) VALUES (?, ?, ?)`, [threadId, authorUserId, body]); await this.database.execute(`UPDATE ${table.threads} SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [threadId]); return result.insertId; }
  async markForumThreadRead(scope, threadId, userId, lastMessageId) { this.forumTables(scope); if (!lastMessageId) return; await this.database.execute('INSERT INTO forum_thread_reads (scope, thread_id, user_id, last_read_message_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id)), read_at = CURRENT_TIMESTAMP', [scope, threadId, userId, lastMessageId]); }
  async setForumThreadStatus(scope, threadId, status) { const table = this.forumTables(scope); const [result] = await this.database.execute(`UPDATE ${table.threads} SET status = ? WHERE id = ?`, [status, threadId]); return result.affectedRows > 0; }
  async groupForumAccess(groupId, userId, role) { const privileged = ['manager', 'admin'].includes(role); const [rows] = await this.database.execute(`SELECT g.id, g.organizer_id AS organizerId, gm.user_id AS memberUserId FROM event_groups g LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active' WHERE g.id = ?`, [userId, groupId]); const group = rows[0]; return Boolean(group && (privileged || group.organizerId === userId || group.memberUserId)); }
  async eventForumAccess(eventId, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.status, e.visibility,
      EXISTS(SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = ? AND r.status IN ('Pending', 'Confirmed')) AS isRegistered,
      EXISTS(SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.user_id = ?) AS isParticipant
      FROM events e WHERE e.id = ? AND e.deleted_at IS NULL`, [userId, userId, eventId]);
    const event = rows[0];
    if (!event) return false;
    return privileged || event.managerId === userId || (event.status === 'Published' && event.visibility === 'Public') || (Boolean(userId) && (Number(event.isRegistered) === 1 || Number(event.isParticipant) === 1));
  }
  async canManageEventForum(eventId, userId, role) { const privileged = ['manager', 'admin'].includes(role); const [rows] = await this.database.execute(`SELECT id FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? [eventId] : [eventId, userId]); return rows.length > 0; }
  /* Retired Communities data-access methods.
  async acceptCommunityPostResponse(postId, responseId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [posts] = await connection.execute(`SELECT id, group_id AS groupId FROM community_posts WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'} FOR UPDATE`, privileged ? [postId] : [postId, userId]);
      const post = posts[0];
      if (!post) { await connection.rollback(); return { error: 'POST_NOT_FOUND' }; }
      if (!post.groupId) { await connection.rollback(); return { error: 'GROUP_REQUIRED' }; }
      const [responses] = await connection.execute('SELECT id, user_id AS userId FROM community_post_responses WHERE id = ? AND post_id = ? FOR UPDATE', [responseId, postId]);
      const response = responses[0];
      if (!response) { await connection.rollback(); return { error: 'RESPONSE_NOT_FOUND' }; }
      await connection.execute("UPDATE community_post_responses SET status = 'accepted' WHERE id = ?", [responseId]);
      await connection.execute("INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'", [post.groupId, response.userId]);
      await connection.commit();
      return { groupId: post.groupId, userId: response.userId };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async reportCommunityPost(postId, userId, reason, details) { await this.database.execute("INSERT INTO community_post_reports (post_id, reporter_user_id, reason, details, status) VALUES (?, ?, ?, ?, 'open') ON DUPLICATE KEY UPDATE reason = VALUES(reason), details = VALUES(details), status = 'open'", [postId, userId, reason, details]); }
  async communityPostReports(status = null) { const [rows] = await this.database.execute(`SELECT r.id, r.post_id AS postId, r.reporter_user_id AS reporterUserId, r.reason, r.details, r.status, r.created_at AS createdAt, p.slug AS postSlug, p.title AS postTitle, reporter.name AS reporterName FROM community_post_reports r JOIN community_posts p ON p.id = r.post_id JOIN users reporter ON reporter.id = r.reporter_user_id${status ? ' WHERE r.status = ?' : ''} ORDER BY r.created_at DESC`, status ? [status] : []); return rows; }
  async updateCommunityPostReport(id, status) { const [result] = await this.database.execute('UPDATE community_post_reports SET status = ? WHERE id = ?', [status, id]); return result.affectedRows > 0; }
  async createGroupFromCommunityPost(postId, userId, group) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [posts] = await connection.execute("SELECT id, author_user_id AS authorUserId, city, category_id AS categoryId, group_id AS groupId FROM community_posts WHERE id = ? AND status IN ('active', 'fulfilled') FOR UPDATE", [postId]);
      const post = posts[0];
      if (!post) return { error: 'POST_NOT_FOUND' };
      if (post.authorUserId !== userId) return { error: 'FORBIDDEN' };
      if (post.groupId) return { error: 'GROUP_EXISTS', groupId: post.groupId };
      const [result] = await connection.execute("INSERT INTO event_groups (organizer_id, name, slug, description, visibility, city, category_id, source_post_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')", [userId, group.name, group.slug, group.description, group.visibility, post.city, post.categoryId, postId]);
      await connection.execute("INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')", [result.insertId, userId]);
      await connection.execute("INSERT INTO group_memberships (group_id, user_id, role, status) SELECT ?, user_id, 'member', 'active' FROM community_post_responses WHERE post_id = ? AND status = 'accepted' ON DUPLICATE KEY UPDATE status = 'active'", [result.insertId, postId]);
      await connection.execute('UPDATE community_posts SET group_id = ? WHERE id = ?', [result.insertId, postId]);
      await connection.commit();
      return { groupId: result.insertId };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  */
  async articleCategories() { const [rows] = await this.database.execute('SELECT id, name, slug, description, sort_order AS sortOrder FROM article_categories WHERE is_active = TRUE ORDER BY sort_order, name'); return rows; }
  articleColumns() { return "a.id, a.slug, a.title, a.excerpt, a.body, a.cover_image AS coverImage, a.cover_alt_text AS coverAltText, a.status, a.is_indexable AS isIndexable, a.published_at AS publishedAt, a.created_at AS createdAt, a.updated_at AS updatedAt, a.author_user_id AS authorUserId, u.name AS authorName, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, GROUP_CONCAT(DISTINCT t.slug ORDER BY t.slug SEPARATOR ',') AS tagSlugs"; }
  async articles({ categorySlug = null, tagSlug = null, page = 1, limit = 20, editorId = null, editorRole = null } = {}) { const privileged = ['manager', 'admin'].includes(editorRole); const admin = editorRole === 'admin'; const conditions = [privileged ? `BINARY a.status <> BINARY 'removed'${admin ? '' : ' AND a.author_user_id = ?'}` : "BINARY a.status = BINARY 'published' AND a.is_indexable = TRUE AND a.published_at IS NOT NULL AND a.published_at <= NOW()"] ; const params = privileged && !admin ? [editorId] : []; if (categorySlug) { conditions.push('c.slug = ?'); params.push(categorySlug); } if (tagSlug) { conditions.push('EXISTS (SELECT 1 FROM article_tag_assignments filter_ata JOIN article_tags filter_t ON filter_t.id = filter_ata.tag_id WHERE filter_ata.article_id = a.id AND filter_t.slug = ?)'); params.push(tagSlug); } const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50); const offset = (Math.max(Number(page) || 1, 1) - 1) * safeLimit; const [rows] = await this.database.execute(`SELECT ${this.articleColumns()} FROM articles a JOIN users u ON u.id = a.author_user_id LEFT JOIN article_categories c ON c.id = a.category_id LEFT JOIN article_tag_assignments ata ON ata.article_id = a.id LEFT JOIN article_tags t ON t.id = ata.tag_id WHERE ${conditions.join(' AND ')} GROUP BY a.id, u.name, c.id, c.name, c.slug ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ? OFFSET ?`, [...params, safeLimit, offset]); return rows.map((row) => ({ ...row, tags: row.tagSlugs ? row.tagSlugs.split(',') : [], tagSlugs: undefined })); }
  async articleBySlug(slug, userId = null, role = null) { const isAdmin = role === 'admin'; const [rows] = await this.database.execute(`SELECT ${this.articleColumns()} FROM articles a JOIN users u ON u.id = a.author_user_id LEFT JOIN article_categories c ON c.id = a.category_id LEFT JOIN article_tag_assignments ata ON ata.article_id = a.id LEFT JOIN article_tags t ON t.id = ata.tag_id WHERE a.slug = ? AND (${isAdmin ? "BINARY a.status <> BINARY 'removed'" : "(BINARY a.status = BINARY 'published' AND a.is_indexable = TRUE AND a.published_at IS NOT NULL AND a.published_at <= NOW()) OR a.author_user_id = ?"}) GROUP BY a.id, u.name, c.id, c.name, c.slug`, isAdmin ? [slug] : [slug, userId]); if (!rows[0]) return null; return { ...rows[0], tags: rows[0].tagSlugs ? rows[0].tagSlugs.split(',') : [], tagSlugs: undefined }; }
  async articleForEditor(id, userId, role) { const privileged = role === 'admin'; const [rows] = await this.database.execute(`SELECT id, slug, author_user_id AS authorUserId, cover_image AS coverImage FROM articles WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'}`, privileged ? [id] : [id, userId]); return rows[0] || null; }
  async createArticle(data) { const [result] = await this.database.execute('INSERT INTO articles (slug, author_user_id, category_id, title, excerpt, body, status, is_indexable, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)', [data.slug, data.authorUserId, data.categoryId, data.title, data.excerpt, data.body, data.status, data.isIndexable]); if (data.status === 'published') await this.database.execute('UPDATE articles SET published_at = NOW() WHERE id = ?', [result.insertId]); return result.insertId; }
  async updateArticle(id, userId, role, data) { const privileged = role === 'admin'; const [result] = await this.database.execute(`UPDATE articles SET category_id=?, title=?, excerpt=?, body=?, is_indexable=? WHERE id=?${privileged ? '' : ' AND author_user_id=?'}`, [...data, id, ...(privileged ? [] : [userId])]); return result.affectedRows > 0; }
  async setArticleStatus(id, userId, role, status, isIndexable = null) { const privileged = role === 'admin'; const params = [status]; let sql = 'UPDATE articles SET status = ?'; if (status === 'published') sql += ', published_at = COALESCE(published_at, NOW())'; if (isIndexable !== null) { sql += ', is_indexable = ?'; params.push(isIndexable); } sql += ` WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'}`; params.push(id, ...(privileged ? [] : [userId])); const [result] = await this.database.execute(sql, params); return result.affectedRows > 0; }
  async setArticleCover(id, userId, role, filename, altText) { const privileged = role === 'admin'; const [result] = await this.database.execute(`UPDATE articles SET cover_image=?, cover_alt_text=? WHERE id=?${privileged ? '' : ' AND author_user_id=?'}`, [filename, altText, id, ...(privileged ? [] : [userId])]); return result.affectedRows > 0; }
  async addArticleMedia(articleId, filename, altText, caption) { const [rows] = await this.database.execute('SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM article_media WHERE article_id = ?', [articleId]); const [result] = await this.database.execute('INSERT INTO article_media (article_id, filename, alt_text, caption, sort_order) VALUES (?, ?, ?, ?, ?)', [articleId, filename, altText, caption, rows[0].nextOrder]); return result.insertId; }
  async articleMedia(articleId) { const [rows] = await this.database.execute('SELECT id, filename, alt_text AS altText, caption, sort_order AS sortOrder, created_at AS createdAt FROM article_media WHERE article_id = ? ORDER BY sort_order, id', [articleId]); return rows; }
  async articleMediaItem(id, articleId) { const [rows] = await this.database.execute('SELECT id, filename FROM article_media WHERE id = ? AND article_id = ?', [id, articleId]); return rows[0] || null; }
  async articleImageVisible(filename, userId = null, role = null) { const isAdmin = role === 'admin'; const [rows] = await this.database.execute(`SELECT a.id FROM articles a LEFT JOIN article_media m ON m.article_id = a.id WHERE (a.cover_image = ? OR m.filename = ?) AND (${isAdmin ? 'TRUE' : "(BINARY a.status = BINARY 'published' AND a.is_indexable = TRUE AND a.published_at IS NOT NULL AND a.published_at <= NOW()) OR a.author_user_id = ?"}) LIMIT 1`, isAdmin ? [filename, filename] : [filename, filename, userId]); return rows[0] || null; }
  async deleteArticleMedia(id, articleId) { const [result] = await this.database.execute('DELETE FROM article_media WHERE id = ? AND article_id = ?', [id, articleId]); return result.affectedRows > 0; }
  async syncArticleTags(articleId, tags) { const connection = await this.database.getConnection(); try { await connection.beginTransaction(); await connection.execute('DELETE FROM article_tag_assignments WHERE article_id = ?', [articleId]); for (const tag of tags) { await connection.execute('INSERT INTO article_tags (name, slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [tag.name, tag.slug]); const [rows] = await connection.execute('SELECT id FROM article_tags WHERE slug = ?', [tag.slug]); await connection.execute('INSERT INTO article_tag_assignments (article_id, tag_id) VALUES (?, ?)', [articleId, rows[0].id]); } await connection.commit(); } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); } }
  async venueOwnerApplication(userId) {
    const [rows] = await this.database.execute(`SELECT a.id, a.user_id AS userId, a.business_name AS businessName, a.message, a.status, a.created_at AS createdAt, a.updated_at AS updatedAt, a.reviewed_at AS reviewedAt, reviewer.name AS reviewerName
      FROM venue_owner_applications a LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by_user_id WHERE a.user_id = ?`, [userId]);
    return rows[0] || null;
  }
  async createVenueOwnerApplication(userId, { businessName, message = null }) {
    await this.database.execute(`INSERT INTO venue_owner_applications (user_id, business_name, message, status, reviewed_by_user_id, reviewed_at)
      VALUES (?, ?, ?, 'pending', NULL, NULL)
      ON DUPLICATE KEY UPDATE business_name = VALUES(business_name), message = VALUES(message), status = 'pending', reviewed_by_user_id = NULL, reviewed_at = NULL`, [userId, businessName, message]);
    return this.venueOwnerApplication(userId);
  }
  async venueOwnerApplications(status = null) {
    const [rows] = await this.database.execute(`SELECT a.id, a.user_id AS userId, a.business_name AS businessName, a.message, a.status, a.created_at AS createdAt, a.updated_at AS updatedAt, a.reviewed_at AS reviewedAt,
      u.name AS userName, u.email AS userEmail, u.role AS userRole, reviewer.name AS reviewerName
      FROM venue_owner_applications a JOIN users u ON u.id = a.user_id LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by_user_id${status ? ' WHERE a.status = ?' : ''} ORDER BY a.created_at DESC`, status ? [status] : []);
    return rows;
  }
  async reviewVenueOwnerApplication(id, status, reviewerId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [applications] = await connection.execute('SELECT user_id AS userId FROM venue_owner_applications WHERE id = ? FOR UPDATE', [id]);
      const application = applications[0];
      if (!application) { await connection.rollback(); return { error: 'NOT_FOUND' }; }
      if (status === 'approved') {
        const [users] = await connection.execute('SELECT role FROM users WHERE id = ? FOR UPDATE', [application.userId]);
        if (!users[0]) { await connection.rollback(); return { error: 'USER_NOT_FOUND' }; }
        if (!['customer', 'organizer', 'venue_owner'].includes(users[0].role)) { await connection.rollback(); return { error: 'ROLE_NOT_ELIGIBLE' }; }
        await connection.execute("UPDATE users SET role = 'venue_owner' WHERE id = ?", [application.userId]);
      }
      await connection.execute('UPDATE venue_owner_applications SET status = ?, reviewed_by_user_id = ?, reviewed_at = NOW() WHERE id = ?', [status, reviewerId, id]);
      await connection.commit();
      return { userId: application.userId, status, role: status === 'approved' ? 'venue_owner' : null };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  venueColumns(prefix = 'v') {
    return `${prefix}.id, ${prefix}.organization_id AS organizationId, ${prefix}.billing_profile_id AS billingProfileId, ${prefix}.owner_user_id AS ownerUserId, ${prefix}.name, ${prefix}.slug, ${prefix}.business_name AS businessName, ${prefix}.short_description AS shortDescription, ${prefix}.description, ${prefix}.address_line_1 AS addressLine1, ${prefix}.address_line_2 AS addressLine2, ${prefix}.postal_code AS postalCode, ${prefix}.country, ${prefix}.country_code AS countryCode, ${prefix}.city, ${prefix}.municipality, ${prefix}.region, ${prefix}.latitude, ${prefix}.longitude, ${prefix}.google_place_id AS googlePlaceId, ${prefix}.formatted_address AS formattedAddress, ${prefix}.location_visibility AS locationVisibility, ${prefix}.timezone, ${prefix}.venue_type_id AS venueTypeId, ${prefix}.capacity_min AS capacityMin, ${prefix}.capacity_max AS capacityMax, ${prefix}.standing_capacity AS standingCapacity, ${prefix}.seated_capacity AS seatedCapacity, ${prefix}.dining_capacity AS diningCapacity, ${prefix}.classroom_capacity AS classroomCapacity, ${prefix}.size_sqm AS sizeSqm, ${prefix}.price_from AS priceFrom, ${prefix}.price_unit AS priceUnit, ${prefix}.currency, ${prefix}.pricing_description AS pricingDescription, ${prefix}.minimum_booking_hours AS minimumBookingHours, ${prefix}.website_url AS websiteUrl, ${prefix}.phone, ${prefix}.contact_email AS contactEmail, ${prefix}.availability_type AS availabilityType, ${prefix}.house_rules_text AS houseRulesText, ${prefix}.is_active AS isActive, ${prefix}.is_verified AS isVerified, ${prefix}.is_featured AS isFeatured, ${prefix}.verification_status AS verificationStatus, ${prefix}.moderation_status AS moderationStatus, ${prefix}.published_at AS publishedAt, ${prefix}.created_at AS createdAt, ${prefix}.updated_at AS updatedAt, (SELECT vm.filename FROM venue_media vm WHERE vm.venue_id = ${prefix}.id AND vm.is_cover = TRUE ORDER BY vm.sort_order, vm.id LIMIT 1) AS coverImage`;
  }
  normalizeVenue(venue, { publicView = false } = {}) {
    if (!venue) return null;
    const normalized = { ...venue, isActive: Boolean(venue.isActive), isVerified: Boolean(venue.isVerified), isFeatured: Boolean(venue.isFeatured), sponsored: Boolean(venue.sponsored) };
    for (const key of ['latitude', 'longitude', 'sizeSqm', 'priceFrom', 'minimumBookingHours']) if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    for (const key of ['capacityMin', 'capacityMax', 'standingCapacity', 'seatedCapacity', 'diningCapacity', 'classroomCapacity']) if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    normalized.location = {
      visibility: normalized.locationVisibility,
      addressLine1: normalized.addressLine1 || null, addressLine2: normalized.addressLine2 || null, postalCode: normalized.postalCode || null,
      locality: normalized.city || null, municipality: normalized.municipality || null, region: normalized.region || null,
      country: normalized.country || null, countryCode: normalized.countryCode || null, latitude: normalized.latitude ?? null, longitude: normalized.longitude ?? null,
      googlePlaceId: normalized.googlePlaceId || null, formattedAddress: normalized.formattedAddress || null,
    };
    normalized.capacity = { min: normalized.capacityMin ?? null, max: normalized.capacityMax ?? null, standing: normalized.standingCapacity ?? null, seated: normalized.seatedCapacity ?? null, dining: normalized.diningCapacity ?? null, classroom: normalized.classroomCapacity ?? null };
    normalized.pricing = { from: normalized.priceFrom ?? null, unit: normalized.priceUnit, currency: normalized.currency, description: normalized.pricingDescription || null };
    if (publicView && normalized.locationVisibility !== 'exact') {
      normalized.addressLine1 = null; normalized.addressLine2 = null; normalized.postalCode = null; normalized.formattedAddress = null; normalized.googlePlaceId = null;
      normalized.location.addressLine1 = null; normalized.location.addressLine2 = null; normalized.location.postalCode = null; normalized.location.formattedAddress = null; normalized.location.googlePlaceId = null;
      if (normalized.locationVisibility === 'private') { normalized.latitude = null; normalized.longitude = null; normalized.location.latitude = null; normalized.location.longitude = null; }
    }
    if (publicView) delete normalized.billingProfileId;
    return normalized;
  }
  async venueRelations(venueId) {
    const [amenities] = await this.database.execute('SELECT a.id, a.slug, a.name, a.category FROM venue_amenity_assignments va JOIN venue_amenities a ON a.id = va.amenity_id WHERE va.venue_id = ? AND a.is_active = TRUE ORDER BY a.category, a.sort_order, a.name', [venueId]);
    const [eventTypes] = await this.database.execute('SELECT t.id, t.slug, t.name FROM venue_event_type_assignments va JOIN venue_event_types t ON t.id = va.event_type_id WHERE va.venue_id = ? AND t.is_active = TRUE ORDER BY t.sort_order, t.name', [venueId]);
    return { amenities, suitableEventTypes: eventTypes };
  }
  async decorateVenue(venue, options) { return { ...this.normalizeVenue(venue, options), ...await this.venueRelations(venue.id) }; }
  async venueTypes() { const [rows] = await this.database.execute('SELECT id, slug, name FROM venue_types WHERE is_active = TRUE ORDER BY sort_order, name'); return rows; }
  async venueEventTypes() { const [rows] = await this.database.execute('SELECT id, slug, name FROM venue_event_types WHERE is_active = TRUE ORDER BY sort_order, name'); return rows; }
  async venueAmenities() { const [rows] = await this.database.execute('SELECT id, slug, name, category FROM venue_amenities WHERE is_active = TRUE ORDER BY category, sort_order, name'); return rows; }
  async organization(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT o.id, o.name, o.slug, o.description, o.website_url AS websiteUrl, o.phone, o.contact_email AS contactEmail, o.is_active AS isActive, om.role AS membershipRole FROM organizations o LEFT JOIN organization_members om ON om.organization_id = o.id AND om.user_id = ? WHERE o.id = ? AND (${privileged ? 'TRUE' : 'o.is_active = TRUE OR om.user_id IS NOT NULL'})`, [userId, id]);
    return rows[0] ? { ...rows[0], isActive: Boolean(rows[0].isActive) } : null;
  }
  async createOrganization(ownerUserId, data) {
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction(); const [result] = await connection.execute('INSERT INTO organizations (name, slug, description, website_url, phone, contact_email) VALUES (?, ?, ?, ?, ?, ?)', [data.name, data.slug, data.description, data.websiteUrl, data.phone, data.contactEmail]); await connection.execute("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')", [result.insertId, ownerUserId]); await connection.commit(); return result.insertId; }
    catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async organizationMember(organizationId, userId) { const [rows] = await this.database.execute('SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?', [organizationId, userId]); return rows[0] || null; }
  async updateOrganization(organizationId, userId, role, data) {
    if (!await this.canManageOrganization(organizationId, userId, role)) return false;
    await this.database.execute('UPDATE organizations SET name = ?, slug = ?, description = ?, website_url = ?, phone = ?, contact_email = ? WHERE id = ?',
      [data.name, data.slug, data.description, data.websiteUrl, data.phone, data.contactEmail, organizationId]);
    // An unchanged update is still successful; return the saved representation.
    return await this.organization(organizationId, userId, role) || false;
  }
  async setOrganizationMember(organizationId, actorUserId, actorRole, userId, membershipRole) {
    if (!['manager', 'admin'].includes(actorRole)) {
      const actor = await this.organizationMember(organizationId, actorUserId);
      if (!actor || !['owner', 'admin'].includes(actor.role)) return false;
    }
    const [result] = await this.database.execute('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [organizationId, userId, membershipRole]);
    return result.affectedRows > 0;
  }
  async canManageOrganization(organizationId, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const member = await this.organizationMember(organizationId, userId);
    return Boolean(member && ['owner', 'admin', 'manager'].includes(member.role));
  }
  async managedOrganizations(userId, role) {
    const [rows] = await this.database.execute(`SELECT o.id, o.name, o.slug, o.description, o.website_url AS websiteUrl,
      o.phone, o.contact_email AS contactEmail, member.role AS membershipRole
      FROM organizations o LEFT JOIN organization_members member ON member.organization_id=o.id AND member.user_id=?
      WHERE ${['manager', 'admin'].includes(role) ? 'TRUE' : "member.role IN ('owner','admin','manager')"}
      ORDER BY o.name`, [userId]);
    return rows;
  }
  billingProfileColumns(prefix = 'p') {
    return `${prefix}.id, ${prefix}.owner_user_id AS ownerUserId, ${prefix}.owner_organization_id AS ownerOrganizationId,
      ${prefix}.profile_type AS profileType, ${prefix}.legal_name AS legalName, ${prefix}.organization_number AS organizationNumber,
      ${prefix}.vat_number AS vatNumber, ${prefix}.address_line_1 AS addressLine1, ${prefix}.address_line_2 AS addressLine2,
      ${prefix}.postal_code AS postalCode, ${prefix}.city, ${prefix}.country, ${prefix}.billing_email AS billingEmail,
      ${prefix}.phone, ${prefix}.default_currency AS defaultCurrency, ${prefix}.invoice_prefix AS invoicePrefix,
      ${prefix}.invoice_due_days AS invoiceDueDays, ${prefix}.payment_instructions AS paymentInstructions,
      ${prefix}.is_default AS isDefault, ${prefix}.is_active AS isActive, ${prefix}.created_at AS createdAt, ${prefix}.updated_at AS updatedAt`;
  }
  async billingProfiles(userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT ${this.billingProfileColumns('p')}
      FROM billing_profiles p LEFT JOIN organization_members member ON member.organization_id=p.owner_organization_id AND member.user_id=?
      WHERE p.is_active=TRUE AND (p.owner_user_id=? OR member.role IN ('owner','admin') OR ${privileged ? 'TRUE' : 'FALSE'})
      ORDER BY p.is_default DESC, p.updated_at DESC`, [userId, userId]);
    return rows.map((row) => ({ ...row, isDefault: Boolean(row.isDefault), isActive: Boolean(row.isActive) }));
  }
  async billingProfile(profileId, userId, role, connection = this.database) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await connection.execute(`SELECT ${this.billingProfileColumns('p')} FROM billing_profiles p
      LEFT JOIN organization_members member ON member.organization_id=p.owner_organization_id AND member.user_id=?
      WHERE p.id=? AND p.is_active=TRUE AND (p.owner_user_id=? OR member.role IN ('owner','admin') OR ${privileged ? 'TRUE' : 'FALSE'})`, [userId, profileId, userId]);
    return rows[0] ? { ...rows[0], isDefault: Boolean(rows[0].isDefault), isActive: Boolean(rows[0].isActive) } : null;
  }
  async saveBillingProfile(userId, role, profileId, profile) {
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction();
      const organizationId = profile.ownerOrganizationId ? Number(profile.ownerOrganizationId) : null;
      // Organization billing details are financial records.  A regular
      // organization manager can operate the organization, but cannot change
      // its legal billing identity; that remains with an owner/admin (or a
      // platform manager/admin).
      if (organizationId && !['manager', 'admin'].includes(role)) {
        const member = await this.organizationMember(organizationId, userId);
        if (!member || !['owner', 'admin'].includes(member.role)) { await connection.rollback(); return null; }
      }
      const existing = profileId ? await this.billingProfile(profileId, userId, role, connection) : null;
      if (profileId && (!existing || Number(existing.ownerOrganizationId || 0) !== Number(organizationId || 0) || (!organizationId && Number(existing.ownerUserId) !== Number(userId)))) { await connection.rollback(); return null; }
      const ownerUserId = organizationId ? null : userId;
      if (profile.isDefault) await connection.execute(`UPDATE billing_profiles SET is_default=FALSE WHERE ${organizationId ? 'owner_organization_id=?' : 'owner_user_id=?'}`, [organizationId || userId]);
      const fields = [profile.profileType, profile.legalName, profile.organizationNumber, profile.vatNumber, profile.addressLine1, profile.addressLine2,
        profile.postalCode, profile.city, profile.country, profile.billingEmail, profile.phone, profile.defaultCurrency, profile.invoicePrefix, profile.invoiceDueDays,
        profile.paymentInstructions, profile.isDefault];
      let id = profileId;
      if (id) await connection.execute(`UPDATE billing_profiles SET profile_type=?, legal_name=?, organization_number=?, vat_number=?, address_line_1=?, address_line_2=?, postal_code=?, city=?, country=?, billing_email=?, phone=?, default_currency=?, invoice_prefix=?, invoice_due_days=?, payment_instructions=?, is_default=? WHERE id=?`, [...fields, id]);
      else { const [result] = await connection.execute(`INSERT INTO billing_profiles (owner_user_id, owner_organization_id, profile_type, legal_name, organization_number, vat_number, address_line_1, address_line_2, postal_code, city, country, billing_email, phone, default_currency, invoice_prefix, invoice_due_days, payment_instructions, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ownerUserId, organizationId, ...fields]); id = result.insertId; }
      if (organizationId && profile.isDefault) await connection.execute('UPDATE organizations SET default_billing_profile_id=? WHERE id=?', [id, organizationId]);
      await connection.commit(); return this.billingProfile(id, userId, role);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async archiveBillingProfile(profileId, userId, role) {
    const profile = await this.billingProfile(profileId, userId, role); if (!profile) return false;
    // Archiving is intentionally allowed even for a profile referenced by an
    // issued invoice or order. Those records retain their immutable snapshots;
    // `is_active` only prevents new financial use of the profile.
    await this.database.execute('UPDATE billing_profiles SET is_active=FALSE, is_default=FALSE WHERE id=?', [profileId]);
    await this.database.execute('UPDATE organizations SET default_billing_profile_id=NULL WHERE default_billing_profile_id=?', [profileId]); return true;
  }
  async paymentAccounts(billingProfileId, userId, role) {
    if (!await this.billingProfile(billingProfileId, userId, role)) return null;
    const [rows] = await this.database.execute(`SELECT id, billing_profile_id AS billingProfileId, provider, provider_account_id AS providerAccountId,
      onboarding_status AS onboardingStatus, charges_enabled AS chargesEnabled, payouts_enabled AS payoutsEnabled, details_submitted AS detailsSubmitted, country,
      default_currency AS defaultCurrency, created_at AS createdAt, updated_at AS updatedAt FROM payment_accounts WHERE billing_profile_id=?`, [billingProfileId]);
    return rows.map((row) => ({ ...row, chargesEnabled: Boolean(row.chargesEnabled), payoutsEnabled: Boolean(row.payoutsEnabled), detailsSubmitted: row.detailsSubmitted == null ? null : Boolean(row.detailsSubmitted) }));
  }
  async createPaymentAccount(billingProfileId, userId, role, account) {
    const profile = await this.billingProfile(billingProfileId, userId, role);
    if (!profile) return null;
    const [result] = await this.database.execute(`INSERT INTO payment_accounts
      (billing_profile_id, provider, provider_account_id, onboarding_status, charges_enabled, payouts_enabled, details_submitted, country, default_currency)
      VALUES (?, ?, ?, 'pending', FALSE, FALSE, FALSE, ?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`, [billingProfileId, account.provider, account.providerAccountId, profile.country, profile.defaultCurrency]);
    await this.audit(userId, 'payment_account_connected', 'payment_account', result.insertId, { billingProfileId, provider: account.provider });
    return { id: result.insertId, billingProfileId, provider: account.provider, providerAccountId: account.providerAccountId, onboardingStatus: 'pending', chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, country: profile.country, defaultCurrency: profile.defaultCurrency };
  }
  async updatePaymentAccountCapabilities(provider, providerAccountId, capabilities) {
    const [result] = await this.database.execute(`UPDATE payment_accounts SET onboarding_status=?, charges_enabled=?, payouts_enabled=?, details_submitted=?
      WHERE provider=? AND provider_account_id=?`, [capabilities.onboardingStatus, Boolean(capabilities.chargesEnabled), Boolean(capabilities.payoutsEnabled), capabilities.detailsSubmitted == null ? null : Boolean(capabilities.detailsSubmitted), provider, providerAccountId]);
    return result.affectedRows > 0;
  }
  async paymentAccount(accountId, userId, role) {
    const [rows] = await this.database.execute(`SELECT account.id, account.billing_profile_id AS billingProfileId, account.provider,
      account.provider_account_id AS providerAccountId, account.onboarding_status AS onboardingStatus, account.charges_enabled AS chargesEnabled,
      account.payouts_enabled AS payoutsEnabled, account.details_submitted AS detailsSubmitted, account.country, account.default_currency AS defaultCurrency
      FROM payment_accounts account JOIN billing_profiles profile ON profile.id=account.billing_profile_id
      LEFT JOIN organization_members member ON member.organization_id=profile.owner_organization_id AND member.user_id=?
      WHERE account.id=? AND (profile.owner_user_id=? OR member.role IN ('owner','admin') OR ${['manager', 'admin'].includes(role) ? 'TRUE' : 'FALSE'})`, [userId, accountId, userId]);
    return rows[0] ? { ...rows[0], chargesEnabled: Boolean(rows[0].chargesEnabled), payoutsEnabled: Boolean(rows[0].payoutsEnabled), detailsSubmitted: rows[0].detailsSubmitted == null ? null : Boolean(rows[0].detailsSubmitted) } : null;
  }
  async eventPaymentSettings(eventId, userId, role) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND e.manager_id=?';
    const [rows] = await this.database.execute(`SELECT s.event_id AS eventId, s.seller_billing_profile_id AS sellerBillingProfileId,
      s.payment_account_id AS paymentAccountId, s.seller_capacity AS sellerCapacity, s.currency, s.payments_enabled AS paymentsEnabled, s.ticket_sales_enabled AS ticketSalesEnabled,
      s.refund_policy_snapshot AS refundPolicy, account.charges_enabled AS chargesEnabled, account.onboarding_status AS onboardingStatus FROM event_payment_settings s JOIN events e ON e.id=s.event_id
      LEFT JOIN payment_accounts account ON account.id=s.payment_account_id WHERE s.event_id=?${scope}`, ['manager', 'admin'].includes(role) ? [eventId] : [eventId, userId]);
    return rows[0] ? { ...rows[0], refundPolicy: jsonValue(rows[0].refundPolicy), paymentsEnabled: Boolean(rows[0].paymentsEnabled), ticketSalesEnabled: Boolean(rows[0].ticketSalesEnabled), chargesEnabled: Boolean(rows[0].chargesEnabled) } : null;
  }
  async saveEventPaymentSettings(eventId, userId, role, settings) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id=?';
    const [events] = await this.database.execute(`SELECT id FROM events WHERE id=?${scope}`, ['manager', 'admin'].includes(role) ? [eventId] : [eventId, userId]);
    if (!events[0]) return { error: 'EVENT_NOT_FOUND' };
    if (settings.sellerBillingProfileId && !await this.billingProfile(settings.sellerBillingProfileId, userId, role)) return { error: 'SELLER_PROFILE_UNAVAILABLE' };
    if (settings.paymentAccountId) {
      const [accounts] = await this.database.execute(`SELECT billing_profile_id AS billingProfileId, charges_enabled AS chargesEnabled,
        onboarding_status AS onboardingStatus FROM payment_accounts WHERE id=?`, [settings.paymentAccountId]);
      if (!accounts[0] || Number(accounts[0].billingProfileId) !== Number(settings.sellerBillingProfileId)) return { error: 'PAYMENT_ACCOUNT_MISMATCH' };
      if (settings.ticketSalesEnabled && (!accounts[0].chargesEnabled || accounts[0].onboardingStatus !== 'ready')) return { error: 'PAYMENT_ACCOUNT_NOT_READY' };
    }
    if (settings.ticketSalesEnabled && (!settings.sellerBillingProfileId || !settings.paymentAccountId)) return { error: 'PAYMENT_SETUP_REQUIRED' };
    if (settings.ticketSalesEnabled && !settings.sellerCapacity) return { error: 'SELLER_CAPACITY_REQUIRED' };
    await this.database.execute(`INSERT INTO event_payment_settings (event_id, seller_billing_profile_id, payment_account_id, seller_capacity, currency, payments_enabled, ticket_sales_enabled, refund_policy_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE seller_billing_profile_id=VALUES(seller_billing_profile_id), payment_account_id=VALUES(payment_account_id), seller_capacity=VALUES(seller_capacity), currency=VALUES(currency), payments_enabled=VALUES(payments_enabled), ticket_sales_enabled=VALUES(ticket_sales_enabled), refund_policy_snapshot=VALUES(refund_policy_snapshot)`, [eventId, settings.sellerBillingProfileId || null, settings.paymentAccountId || null, settings.sellerCapacity || null, settings.currency || null, Boolean(settings.paymentsEnabled), Boolean(settings.ticketSalesEnabled), settings.refundPolicy || null]);
    return this.eventPaymentSettings(eventId, userId, role);
  }
  async canAcceptPaidRegistrations(eventId) {
    const [rows] = await this.database.execute('SELECT participation_fee AS fee, pricing_type AS pricingType FROM events WHERE id=?', [eventId]);
    const row = rows[0]; if (!row || row.pricingType !== 'paid' && Number(row.fee || 0) <= 0) return true;
    // Paid attendance is created only by verified Checkout fulfillment.
    return false;
  }
  async managedTicketTypes(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(`SELECT id FROM events WHERE id=? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id=?'}`, privileged ? [eventId] : [eventId, userId]);
    if (!events[0]) return null;
    return this.ticketTypes(eventId);
  }
  async ticketTypes(eventId, { publicOnly = false } = {}) {
    const [rows] = await this.database.execute(`SELECT id, event_id AS eventId, name, description, price, currency,
      quantity_available AS quantityAvailable, quantity_sold AS quantitySold, sales_start_at AS salesStartAt, sales_end_at AS salesEndAt,
      (SELECT COALESCE(SUM(item.quantity),0) FROM ticket_order_items item JOIN ticket_orders o ON o.id=item.ticket_order_id
        WHERE item.ticket_type_id=event_ticket_types.id AND o.payment_status='pending') AS quantityReserved,
      is_active AS isActive FROM event_ticket_types WHERE event_id=?${publicOnly ? " AND is_active=TRUE AND (sales_start_at IS NULL OR sales_start_at<=NOW()) AND (sales_end_at IS NULL OR sales_end_at>=NOW())" : ''} ORDER BY id`, [eventId]);
    return rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
  }
  async saveTicketType(eventId, userId, role, ticketTypeId, ticketType) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id=?';
    const [events] = await this.database.execute(`SELECT id FROM events WHERE id=?${scope}`, ['manager', 'admin'].includes(role) ? [eventId] : [eventId, userId]);
    if (!events[0]) return null;
    if (ticketTypeId) {
      const [result] = await this.database.execute(`UPDATE event_ticket_types SET name=?, description=?, price=?, currency=?, quantity_available=?, sales_start_at=?, sales_end_at=?, is_active=? WHERE id=? AND event_id=?`, [ticketType.name, ticketType.description, ticketType.price, ticketType.currency, ticketType.quantityAvailable, ticketType.salesStartAt, ticketType.salesEndAt, Boolean(ticketType.isActive), ticketTypeId, eventId]);
      if (!result.affectedRows) return null;
      return { id: ticketTypeId };
    }
    const [result] = await this.database.execute(`INSERT INTO event_ticket_types (event_id, name, description, price, currency, quantity_available, sales_start_at, sales_end_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [eventId, ticketType.name, ticketType.description, ticketType.price, ticketType.currency, ticketType.quantityAvailable, ticketType.salesStartAt, ticketType.salesEndAt, Boolean(ticketType.isActive)]);
    return { id: result.insertId };
  }
  async ticketCheckoutContext(eventId, connection = this.database) {
    const [rows] = await connection.execute(`SELECT e.id AS eventId, e.title, e.currency, e.status, e.visibility,
      s.seller_billing_profile_id AS sellerBillingProfileId, s.payment_account_id AS paymentAccountId, s.seller_capacity AS sellerCapacity,
      s.currency AS paymentCurrency, s.refund_policy_snapshot AS refundPolicy, account.provider, account.provider_account_id AS providerAccountId,
      account.charges_enabled AS chargesEnabled, account.onboarding_status AS onboardingStatus,
      profile.legal_name AS sellerLegalName, profile.organization_number AS sellerOrganizationNumber, profile.vat_number AS sellerVatNumber,
      profile.address_line_1 AS sellerAddressLine1, profile.address_line_2 AS sellerAddressLine2, profile.postal_code AS sellerPostalCode,
      profile.city AS sellerCity, profile.country AS sellerCountry, profile.billing_email AS sellerBillingEmail
      FROM events e JOIN event_payment_settings s ON s.event_id=e.id JOIN payment_accounts account ON account.id=s.payment_account_id
      JOIN billing_profiles profile ON profile.id=s.seller_billing_profile_id WHERE e.id=? AND e.status='Published' AND e.visibility='Public'
      AND e.deleted_at IS NULL AND e.starts_at>NOW() AND e.pricing_type='paid' AND e.registration_type='yaroko'
      AND (e.registration_deadline IS NULL OR e.registration_deadline>NOW())
      AND account.billing_profile_id=profile.id AND profile.is_active=TRUE AND s.payments_enabled=TRUE
      AND s.ticket_sales_enabled=TRUE AND account.charges_enabled=TRUE AND account.onboarding_status='ready'`, [eventId]);
    if (!rows[0]) return null;
    const row = rows[0];
    return { ...row, chargesEnabled: Boolean(row.chargesEnabled), refundPolicy: jsonValue(row.refundPolicy), seller: { legalName: row.sellerLegalName, organizationNumber: row.sellerOrganizationNumber, vatNumber: row.sellerVatNumber, addressLine1: row.sellerAddressLine1, addressLine2: row.sellerAddressLine2, postalCode: row.sellerPostalCode, city: row.sellerCity, country: row.sellerCountry, billingEmail: row.sellerBillingEmail, capacity: row.sellerCapacity } };
  }
  async createTicketOrder(eventId, attendee, selections, checkoutKey = null) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      // Serialize reservations for this event, including purchases of different ticket types.
      const [eventRows] = await connection.execute('SELECT id, capacity, starts_at AS startsAt FROM events WHERE id=? FOR UPDATE', [eventId]);
      if (!eventRows[0] || new Date(utcTimestamp(eventRows[0].startsAt)) <= new Date()) { await connection.rollback(); return { error: 'EVENT_UNAVAILABLE' }; }
      if (checkoutKey) {
        const [existing] = await connection.execute('SELECT id FROM ticket_orders WHERE event_id=? AND attendee_user_id=? AND checkout_key=?', [eventId, attendee.userId, checkoutKey]);
        if (existing[0]) { await connection.commit(); return this.ticketOrder(existing[0].id, attendee.userId, 'customer'); }
      }
      const context = await this.ticketCheckoutContext(eventId, connection);
      if (!context) { await connection.rollback(); return { error: 'PAYMENT_SETUP_REQUIRED' }; }
      const ids = selections.map((selection) => Number(selection.ticketTypeId));
      if (!ids.length || ids.some((id) => !Number.isInteger(id))) { await connection.rollback(); return { error: 'INVALID_TICKETS' }; }
      const placeholders = ids.map(() => '?').join(',');
      const [types] = await connection.execute(`SELECT id, name, description, price, currency, quantity_available AS quantityAvailable,
        quantity_sold AS quantitySold FROM event_ticket_types WHERE event_id=? AND id IN (${placeholders}) AND is_active=TRUE
        AND (sales_start_at IS NULL OR sales_start_at<=NOW()) AND (sales_end_at IS NULL OR sales_end_at>=NOW()) FOR UPDATE`, [eventId, ...ids]);
      if (types.length !== ids.length || new Set(ids).size !== ids.length) { await connection.rollback(); return { error: 'INVALID_TICKETS' }; }
      let subtotal = 0; const items = [];
      // Pending Checkouts hold stock until Stripe confirms expiry/failure. A browser
      // cancellation alone cannot release stock: that Checkout might still be paid.
      const [reserved] = await connection.execute(`SELECT item.ticket_type_id AS ticketTypeId, SUM(item.quantity) AS quantity
        FROM ticket_order_items item JOIN ticket_orders o ON o.id=item.ticket_order_id
        WHERE o.event_id=? AND o.payment_status='pending' GROUP BY item.ticket_type_id`, [eventId]);
      const [capacityRows] = await connection.execute(`SELECT COALESCE(SUM(item.quantity),0) AS quantity FROM ticket_order_items item
        JOIN ticket_orders o ON o.id=item.ticket_order_id WHERE o.event_id=? AND o.payment_status IN ('pending','paid','partially_refunded','disputed')`, [eventId]);
      const requestedQuantity = selections.reduce((sum, item) => sum + Number(item.quantity), 0);
      if (eventRows[0].capacity != null && Number(capacityRows[0].quantity) + requestedQuantity > Number(eventRows[0].capacity)) { await connection.rollback(); return { error: 'TICKETS_UNAVAILABLE' }; }
      for (const selection of selections) {
        const type = types.find((candidate) => Number(candidate.id) === Number(selection.ticketTypeId)); const quantity = Number(selection.quantity);
        const held = Number(reserved.find((row) => Number(row.ticketTypeId) === Number(type.id))?.quantity || 0);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20 || (type.quantityAvailable !== null && Number(type.quantitySold) + held + quantity > Number(type.quantityAvailable))) { await connection.rollback(); return { error: 'TICKETS_UNAVAILABLE' }; }
        if (type.currency !== (context.paymentCurrency || context.currency)) { await connection.rollback(); return { error: 'CURRENCY_MISMATCH' }; }
        const amount = Math.round(Number(type.price) * 100) * quantity / 100; subtotal = Math.round((subtotal + amount) * 100) / 100;
        items.push({ type, quantity, amount });
      }
      const orderNumber = `TKT-${new Date().getUTCFullYear()}-${crypto.randomBytes(7).toString('hex').toUpperCase()}`;
      if (subtotal <= 0) { await connection.rollback(); return { error: 'INVALID_TICKETS' }; }
      const [order] = await connection.execute(`INSERT INTO ticket_orders (order_number, event_id, attendee_user_id, attendee_email, seller_billing_profile_id, payment_account_id, currency, subtotal, tax_amount, total_amount, provider, seller_snapshot_json, refund_policy_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`, [orderNumber, eventId, attendee.userId || null, attendee.email, context.sellerBillingProfileId, context.paymentAccountId, context.paymentCurrency || context.currency, subtotal, subtotal, context.provider, JSON.stringify(context.seller), context.refundPolicy ? JSON.stringify(context.refundPolicy) : null]);
      await connection.execute('UPDATE ticket_orders SET checkout_key=? WHERE id=?', [checkoutKey, order.insertId]);
      for (const item of items) await connection.execute(`INSERT INTO ticket_order_items (ticket_order_id, ticket_type_id, ticket_type_snapshot_json, quantity, unit_price, subtotal, tax_amount, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`, [order.insertId, item.type.id, JSON.stringify({ id: item.type.id, name: item.type.name, description: item.type.description, currency: item.type.currency }), item.quantity, item.type.price, item.amount, item.amount]);
      await connection.commit();
      // Do not await the pool read here: finally must release the transaction's
      // connection first, including when all pool slots are serving checkouts.
      return this.ticketOrder(order.insertId, attendee.userId, 'customer');
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async attachTicketProviderPayment(orderId, provider, providerPaymentId) {
    await this.database.execute(`UPDATE ticket_orders SET provider=?, provider_payment_id=? WHERE id=? AND payment_status='pending'`, [provider, providerPaymentId, orderId]);
  }
  async ticketOrder(orderId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT o.id, o.order_number AS orderNumber, o.event_id AS eventId, e.title AS eventTitle,
      o.attendee_user_id AS attendeeUserId, o.attendee_email AS attendeeEmail, o.currency, o.subtotal, o.tax_amount AS taxAmount,
      o.total_amount AS totalAmount, o.payment_status AS paymentStatus, o.provider, o.created_at AS createdAt, o.paid_at AS paidAt,
      o.seller_snapshot_json AS sellerSnapshot, o.refund_policy_snapshot AS refundPolicy, o.test_mode AS testMode
      FROM ticket_orders o LEFT JOIN events e ON e.id=o.event_id LEFT JOIN event_payment_settings settings ON settings.event_id=o.event_id
      LEFT JOIN billing_profiles seller ON seller.id=settings.seller_billing_profile_id
      LEFT JOIN organization_members seller_member ON seller_member.organization_id=seller.owner_organization_id AND seller_member.user_id=?
      WHERE o.id=? AND (${privileged ? 'TRUE' : "o.attendee_user_id=? OR e.manager_id=? OR seller.owner_user_id=? OR seller_member.role IN ('owner','admin','manager')"})`, privileged ? [userId, orderId] : [userId, orderId, userId, userId, userId]);
    if (!rows[0]) return null;
    const [items] = await this.database.execute(`SELECT id, ticket_type_id AS ticketTypeId, ticket_type_snapshot_json AS ticketType,
      quantity, unit_price AS unitPrice, subtotal, tax_amount AS taxAmount, total_amount AS totalAmount FROM ticket_order_items WHERE ticket_order_id=?`, [orderId]);
    return { ...rows[0], seller: jsonValue(rows[0].sellerSnapshot), refundPolicy: jsonValue(rows[0].refundPolicy), items: items.map((item) => ({ ...item, ticketType: jsonValue(item.ticketType) })) };
  }
  async ticketOrdersForAttendee(userId) {
    const [rows] = await this.database.execute(`SELECT id, order_number AS orderNumber, event_id AS eventId, attendee_email AS attendeeEmail,
      currency, total_amount AS totalAmount, payment_status AS paymentStatus, created_at AS createdAt, paid_at AS paidAt FROM ticket_orders
      WHERE attendee_user_id=? ORDER BY created_at DESC`, [userId]);
    return rows;
  }
  async processTicketProviderEvent({ provider, providerEventId, eventType, payload }) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      try {
        await connection.execute(`INSERT INTO payment_provider_events (provider, provider_event_id, event_type, payload_json) VALUES (?, ?, ?, ?)`, [provider, providerEventId, eventType, JSON.stringify(payload)]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') { await connection.rollback(); return { duplicate: true }; }
        throw error;
      }
      const object = payload?.data?.object || {}; const metadata = object.metadata || {};
      if (eventType === 'account.updated' && object.id) {
        await connection.execute(`UPDATE payment_accounts SET onboarding_status=?, charges_enabled=?, payouts_enabled=?, details_submitted=?
          WHERE provider=? AND provider_account_id=?`, [object.charges_enabled ? 'ready' : object.details_submitted ? 'restricted' : 'pending', Boolean(object.charges_enabled), Boolean(object.payouts_enabled), object.details_submitted == null ? null : Boolean(object.details_submitted), provider, object.id]);
        await connection.execute(`UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`, [provider, providerEventId]);
        await connection.commit(); return { paymentAccount: object.id, processed: true };
      }
      if (eventType.startsWith('customer.subscription.') && object.id) {
        const status = object.status === 'canceled' ? 'cancelled' : object.status === 'incomplete_expired' ? 'expired' : ['active', 'past_due', 'cancelled', 'expired'].includes(object.status) ? object.status : object.cancel_at_period_end ? 'active' : 'pending';
        await connection.execute(`UPDATE platform_subscriptions SET status=?, current_period_start=FROM_UNIXTIME(?), current_period_end=FROM_UNIXTIME(?),
          cancel_at_period_end=? WHERE provider=? AND provider_subscription_id=?`, [status, object.current_period_start || null, object.current_period_end || null, Boolean(object.cancel_at_period_end), provider, object.id]);
        if (status === 'past_due' || status === 'cancelled' || status === 'expired') await connection.execute(`UPDATE platform_entitlements entitlement JOIN platform_subscriptions subscription ON subscription.id=entitlement.source_id
          SET entitlement.revoked_at=COALESCE(entitlement.revoked_at, NOW()) WHERE entitlement.source_type='platform_subscription' AND subscription.provider=? AND subscription.provider_subscription_id=?`, [provider, object.id]);
        await connection.execute(`UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`, [provider, providerEventId]);
        await connection.commit(); return { subscription: object.id, processed: true };
      }
      const orderId = Number(metadata.ticketOrderId || metadata.ticket_order_id || 0);
      const platformOrderId = Number(metadata.platformOrderId || metadata.platform_order_id || 0);
      if (platformOrderId) {
        const result = await this.processPlatformProviderEventInTransaction(connection, { provider, eventType, object, platformOrderId });
        await connection.execute(`UPDATE payment_provider_events SET processed_at=NOW(), processing_error=? WHERE provider=? AND provider_event_id=?`, [result.error || null, provider, providerEventId]);
        await connection.commit(); return result;
      }
      if (!orderId) { await connection.execute(`UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`, [provider, providerEventId]); await connection.commit(); return { ignored: true }; }
      const [orders] = await connection.execute(`SELECT ticket.id, ticket.payment_status AS paymentStatus, ticket.payment_account_id AS paymentAccountId,
        account.provider_account_id AS providerAccountId FROM ticket_orders ticket JOIN payment_accounts account ON account.id=ticket.payment_account_id
        WHERE ticket.id=? FOR UPDATE`, [orderId]);
      const order = orders[0];
      if (!order || payload.account !== order.providerAccountId) { await connection.execute(`UPDATE payment_provider_events SET processing_error=? WHERE provider=? AND provider_event_id=?`, ['Ticket order/payment account mismatch', provider, providerEventId]); await connection.commit(); return { ignored: true }; }
      // TicketSales verifies Checkout and commits tickets + delivery together.
      // PaymentIntent notifications alone must never bypass that fulfillment path.
      if (['charge.refunded', 'refund.created', 'refund.updated'].includes(eventType) && ['paid', 'partially_refunded'].includes(order.paymentStatus)) {
        const fullyRefunded = object.refunded === true || object.status === 'succeeded' && Number(object.amount_refunded || 0) >= Number(object.amount || 0);
        await connection.execute(`UPDATE ticket_orders SET payment_status=? WHERE id=?`, [fullyRefunded ? 'refunded' : 'partially_refunded', orderId]);
      } else if (eventType.startsWith('charge.dispute.')) {
        await connection.execute(`UPDATE ticket_orders SET payment_status='disputed' WHERE id=?`, [orderId]);
      }
      await connection.execute(`UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`, [provider, providerEventId]);
      await connection.commit(); return { orderId, processed: true };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async processPlatformProviderEventInTransaction(connection, { provider, eventType, object, platformOrderId }) {
    const [orders] = await connection.execute(`SELECT id, buyer_user_id AS buyerUserId, buyer_organization_id AS buyerOrganizationId,
      buyer_billing_profile_id AS buyerBillingProfileId, product_id AS productId, event_id AS eventId, buyer_capacity AS buyerCapacity,
      currency, subtotal, tax_amount AS taxAmount, total_amount AS totalAmount, payment_status AS paymentStatus, invoice_id AS invoiceId,
      product_snapshot_json AS productSnapshot FROM platform_orders WHERE id=? FOR UPDATE`, [platformOrderId]);
    const order = orders[0]; if (!order) return { ignored: true, error: 'Platform order not found' };
    const product = jsonValue(order.productSnapshot) || {}; const paymentId = object.payment_intent || object.id || null;
    const paid = ['checkout.session.completed', 'invoice.paid', 'payment_intent.succeeded'].includes(eventType) && (eventType !== 'checkout.session.completed' || object.payment_status === 'paid' || product.productType === 'subscription');
    if (paid && order.paymentStatus === 'pending') {
      await connection.execute(`UPDATE platform_orders SET payment_status='paid', provider=?, provider_payment_id=? WHERE id=?`, [provider, paymentId, order.id]);
      const [updatedPayment] = await connection.execute(`UPDATE platform_payments SET provider_payment_id=?, provider_invoice_id=COALESCE(?, provider_invoice_id),
        status='succeeded', paid_at=COALESCE(paid_at, NOW()) WHERE order_id=? AND provider=?`, [paymentId, object.invoice || null, order.id, provider]);
      if (!updatedPayment.affectedRows) await connection.execute(`INSERT INTO platform_payments (order_id, provider, provider_payment_id, provider_invoice_id, amount, currency, status, paid_at)
        VALUES (?, ?, ?, ?, ?, ?, 'succeeded', NOW())`, [order.id, provider, paymentId, object.invoice || null, order.totalAmount, order.currency]);
      const invoiceId = await this.issuePlatformOrderInvoice(connection, order);
      let sourceType = 'platform_order'; let sourceId = order.id;
      if (product.productType === 'subscription') {
        const providerSubscriptionId = object.subscription || null;
        const [subscription] = await connection.execute(`INSERT INTO platform_subscriptions (subscriber_user_id, subscriber_organization_id, buyer_billing_profile_id, product_id, buyer_capacity, status, provider, provider_customer_id, provider_subscription_id)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), status='active', buyer_billing_profile_id=VALUES(buyer_billing_profile_id)`, [order.buyerUserId, order.buyerOrganizationId, order.buyerBillingProfileId, order.productId, order.buyerCapacity, provider, object.customer || null, providerSubscriptionId]);
        sourceType = 'platform_subscription'; sourceId = subscription.insertId;
      }
      if (product.entitlementFeature) await connection.execute(`INSERT INTO platform_entitlements (user_id, organization_id, event_id, feature, source_type, source_id)
        SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM platform_entitlements WHERE source_type=? AND source_id=? AND feature=? AND revoked_at IS NULL)`, [order.buyerUserId, order.buyerOrganizationId, order.eventId, product.entitlementFeature, sourceType, sourceId, sourceType, sourceId, product.entitlementFeature]);
      return { platformOrderId: order.id, invoiceId, processed: true };
    }
    if (['checkout.session.expired', 'payment_intent.payment_failed', 'invoice.payment_failed'].includes(eventType) && order.paymentStatus === 'pending') {
      await connection.execute(`UPDATE platform_orders SET payment_status='failed' WHERE id=?`, [order.id]);
      await connection.execute(`INSERT INTO platform_payments (order_id, provider, provider_payment_id, amount, currency, status)
        VALUES (?, ?, ?, ?, ?, 'failed') ON DUPLICATE KEY UPDATE status='failed'`, [order.id, provider, paymentId, order.totalAmount, order.currency]);
    } else if (['charge.refunded', 'refund.created', 'refund.updated'].includes(eventType) && order.paymentStatus === 'paid') {
      await connection.execute(`UPDATE platform_orders SET payment_status='refunded' WHERE id=?`, [order.id]);
      await connection.execute(`UPDATE platform_payments SET status='refunded', refunded_at=NOW() WHERE order_id=?`, [order.id]);
      await connection.execute(`UPDATE platform_entitlements SET revoked_at=NOW() WHERE source_type='platform_order' AND source_id=? AND revoked_at IS NULL`, [order.id]);
    }
    return { platformOrderId: order.id, processed: true };
  }
  async ticketRefundContext(orderId, userId, role) {
    const [rows] = await this.database.execute(`SELECT ticket.id, ticket.payment_status AS paymentStatus, ticket.provider, ticket.provider_payment_id AS providerPaymentId,
      ticket.total_amount AS totalAmount, ticket.currency, account.provider_account_id AS providerAccountId
      FROM ticket_orders ticket JOIN events event_row ON event_row.id=ticket.event_id JOIN payment_accounts account ON account.id=ticket.payment_account_id
      LEFT JOIN billing_profiles seller ON seller.id=ticket.seller_billing_profile_id
      LEFT JOIN organization_members member ON member.organization_id=seller.owner_organization_id AND member.user_id=?
      WHERE ticket.id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "event_row.manager_id=? OR seller.owner_user_id=? OR member.role IN ('owner','admin','manager')"})`, ['manager', 'admin'].includes(role) ? [userId, orderId] : [userId, orderId, userId, userId]);
    return rows[0] || null;
  }
  async platformProducts({ activeOnly = true } = {}) {
    const [rows] = await this.database.execute(`SELECT product.id, product.product_type AS productType, product.code, product.name, product.description,
      product.entitlement_feature AS entitlementFeature, product.is_active AS isActive, price.id AS priceId, price.currency, price.amount,
      price.billing_interval AS billingInterval, price.provider_price_id AS providerPriceId FROM platform_products product
      LEFT JOIN platform_prices price ON price.product_id=product.id AND price.is_active=TRUE
      ${activeOnly ? 'WHERE product.is_active=TRUE' : ''} ORDER BY product.id, price.id`, []);
    return rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
  }
  async savePlatformProduct(productId, product, actorUserId) {
    if (productId) {
      const [result] = await this.database.execute(`UPDATE platform_products SET product_type=?, code=?, name=?, description=?, entitlement_feature=?, is_active=? WHERE id=?`, [product.productType, product.code, product.name, product.description, product.entitlementFeature, Boolean(product.isActive), productId]);
      if (!result.affectedRows) return null; await this.audit(actorUserId, 'platform_product_updated', 'platform_product', productId); return { id: productId };
    }
    const [result] = await this.database.execute(`INSERT INTO platform_products (product_type, code, name, description, entitlement_feature, is_active) VALUES (?, ?, ?, ?, ?, ?)`, [product.productType, product.code, product.name, product.description, product.entitlementFeature, Boolean(product.isActive)]);
    await this.audit(actorUserId, 'platform_product_created', 'platform_product', result.insertId); return { id: result.insertId };
  }
  async savePlatformPrice(productId, price, actorUserId) {
    const [products] = await this.database.execute('SELECT id FROM platform_products WHERE id=?', [productId]); if (!products[0]) return null;
    const [result] = await this.database.execute(`INSERT INTO platform_prices (product_id, currency, amount, billing_interval, provider_price_id, is_active) VALUES (?, ?, ?, ?, ?, ?)`, [productId, price.currency, price.amount, price.billingInterval, price.providerPriceId, Boolean(price.isActive)]);
    await this.audit(actorUserId, 'platform_price_created', 'platform_price', result.insertId, { productId }); return { id: result.insertId };
  }
  async createPlatformOrder(userId, role, request) {
    if (request.idempotencyKey) {
      const [existing] = await this.database.execute(`SELECT id, payment_status AS paymentStatus, currency, total_amount AS totalAmount,
        product_snapshot_json AS productSnapshot FROM platform_orders WHERE buyer_user_id=? AND checkout_idempotency_key=?`, [userId, request.idempotencyKey]);
      if (existing[0]) return { ...existing[0], product: jsonValue(existing[0].productSnapshot), reused: true };
    }
    const profile = await this.billingProfile(request.buyerBillingProfileId, userId, role);
    if (!profile) return { error: 'BUYER_PROFILE_UNAVAILABLE' };
    const [rows] = await this.database.execute(`SELECT product.id, product.product_type AS productType, product.code, product.name,
      product.entitlement_feature AS entitlementFeature, price.id AS priceId, price.currency, price.amount, price.billing_interval AS billingInterval
      FROM platform_products product JOIN platform_prices price ON price.product_id=product.id WHERE product.id=? AND price.id=? AND product.is_active=TRUE AND price.is_active=TRUE`, [request.productId, request.priceId]);
    const product = rows[0]; if (!product) return { error: 'PRODUCT_UNAVAILABLE' };
    if (request.eventId && product.productType !== 'event_fee') return { error: 'INVALID_PRODUCT_CONTEXT' };
    if (request.eventId) {
      const [events] = await this.database.execute(`SELECT id FROM events WHERE id=?${['manager', 'admin'].includes(role) ? '' : ' AND manager_id=?'}`, ['manager', 'admin'].includes(role) ? [request.eventId] : [request.eventId, userId]);
      if (!events[0]) return { error: 'EVENT_UNAVAILABLE' };
    }
    const snapshot = { productType: product.productType, code: product.code, name: product.name, entitlementFeature: product.entitlementFeature, priceId: product.priceId, amount: product.amount, currency: product.currency, billingInterval: product.billingInterval };
    const [result] = await this.database.execute(`INSERT INTO platform_orders (buyer_user_id, buyer_organization_id, buyer_billing_profile_id, product_id, event_id, buyer_capacity, currency, subtotal, tax_amount, total_amount, checkout_idempotency_key, terms_version, accepted_at, product_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NOW(), ?)`, [userId, profile.ownerOrganizationId || null, profile.id, product.id, request.eventId || null, request.buyerCapacity, product.currency, product.amount, product.amount, request.idempotencyKey || null, request.termsVersion || null, JSON.stringify(snapshot)]);
    await this.audit(userId, 'platform_order_created', 'platform_order', result.insertId, { productId: product.id, eventId: request.eventId || null });
    return { id: result.insertId, paymentStatus: 'pending', currency: product.currency, totalAmount: Number(product.amount), product: snapshot };
  }
  async platformOrderForBuyer(orderId, userId, role) {
    const [rows] = await this.database.execute(`SELECT order_row.id, order_row.buyer_user_id AS buyerUserId, order_row.buyer_organization_id AS buyerOrganizationId,
      order_row.buyer_billing_profile_id AS buyerBillingProfileId, order_row.product_id AS productId, order_row.event_id AS eventId,
      order_row.buyer_capacity AS buyerCapacity, order_row.currency, order_row.subtotal, order_row.tax_amount AS taxAmount,
      order_row.total_amount AS totalAmount, order_row.payment_status AS paymentStatus, order_row.provider, order_row.provider_payment_id AS providerPaymentId,
      order_row.invoice_id AS invoiceId, order_row.product_snapshot_json AS productSnapshot, price.provider_price_id AS providerPriceId
      FROM platform_orders order_row JOIN platform_prices price ON price.id=JSON_UNQUOTE(JSON_EXTRACT(order_row.product_snapshot_json, '$.priceId'))
      WHERE order_row.id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : 'order_row.buyer_user_id=?'})`, ['manager', 'admin'].includes(role) ? [orderId] : [orderId, userId]);
    return rows[0] ? { ...rows[0], product: jsonValue(rows[0].productSnapshot) } : null;
  }
  async attachPlatformProviderPayment(orderId, provider, providerPaymentId) {
    const [orders] = await this.database.execute(`SELECT id, currency, total_amount AS totalAmount FROM platform_orders WHERE id=? AND payment_status='pending'`, [orderId]);
    if (!orders[0]) return false;
    await this.database.execute(`UPDATE platform_orders SET provider=?, provider_payment_id=? WHERE id=? AND payment_status='pending'`, [provider, providerPaymentId, orderId]);
    await this.database.execute(`INSERT INTO platform_payments (order_id, provider, provider_payment_id, amount, currency, status)
      VALUES (?, ?, ?, ?, ?, 'pending') ON DUPLICATE KEY UPDATE order_id=VALUES(order_id)`, [orderId, provider, providerPaymentId, orders[0].totalAmount, orders[0].currency]);
    return true;
  }
  async issuePlatformOrderInvoice(connection, order) {
    if (order.invoiceId) return order.invoiceId;
    const [sellers] = await connection.execute(`SELECT profile.id, profile.owner_organization_id AS ownerOrganizationId, profile.legal_name AS legalName,
      profile.organization_number AS organizationNumber, profile.vat_number AS vatNumber, profile.address_line_1 AS addressLine1,
      profile.address_line_2 AS addressLine2, profile.postal_code AS postalCode, profile.city, profile.country, profile.billing_email AS billingEmail,
      profile.invoice_prefix AS invoicePrefix, profile.invoice_due_days AS invoiceDueDays, profile.payment_instructions AS paymentInstructions
      FROM platform_billing_settings settings JOIN billing_profiles profile ON profile.id=settings.billing_profile_id
      WHERE settings.settings_key='platform' AND profile.is_active=TRUE FOR UPDATE`);
    const seller = sellers[0]; if (!seller) throw new Error('Platform billing profile is not configured.');
    const [buyers] = await connection.execute(`SELECT id, owner_organization_id AS ownerOrganizationId, profile_type AS profileType, legal_name AS legalName,
      organization_number AS organizationNumber, vat_number AS vatNumber, address_line_1 AS addressLine1, address_line_2 AS addressLine2,
      postal_code AS postalCode, city, country, billing_email AS billingEmail, phone FROM billing_profiles WHERE id=? FOR UPDATE`, [order.buyerBillingProfileId]);
    const buyer = buyers[0]; if (!buyer) throw new Error('Platform order buyer snapshot is unavailable.');
    const allocation = await this.allocateInvoiceNumber(connection, seller.id, seller.invoicePrefix);
    const product = jsonValue(order.productSnapshot) || {}; const contextType = product.productType === 'subscription' ? 'platform_subscription' : product.productType === 'event_fee' ? 'platform_event_fee' : 'platform_service';
    const sellerSnapshot = { legalName: seller.legalName, organizationNumber: seller.organizationNumber, vatNumber: seller.vatNumber, addressLine1: seller.addressLine1, addressLine2: seller.addressLine2, postalCode: seller.postalCode, city: seller.city, country: seller.country, billingEmail: seller.billingEmail };
    const transactionSnapshot = { product, eventId: order.eventId, buyerCapacity: order.buyerCapacity };
    const [invoice] = await connection.execute(`INSERT INTO invoices (seller_organization_id, seller_billing_profile_id, buyer_user_id, buyer_organization_id, buyer_billing_profile_id, context_type, context_id, invoice_series_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total_amount, seller_snapshot_json, buyer_snapshot_json, booking_snapshot_json, tax_snapshot_json, payment_instructions_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [seller.ownerOrganizationId, seller.id, order.buyerUserId, order.buyerOrganizationId || buyer.ownerOrganizationId || null, buyer.id, contextType, String(order.id), allocation.seriesId, allocation.invoiceNumber, seller.invoiceDueDays, order.currency, order.subtotal, order.taxAmount, order.totalAmount, JSON.stringify(sellerSnapshot), JSON.stringify(buyer), JSON.stringify(transactionSnapshot), JSON.stringify({ treatment: 'not_calculated', amount: order.taxAmount }), JSON.stringify({ text: seller.paymentInstructions })]);
    await connection.execute(`INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, tax_rate, subtotal, tax_amount, total) VALUES (?, ?, 1, 'service', ?, 0, ?, ?, ?)`, [invoice.insertId, product.name || 'YKCircle service', order.subtotal, order.subtotal, order.taxAmount, order.totalAmount]);
    await connection.execute(`INSERT INTO invoice_history (invoice_id, action, new_status, metadata_json) VALUES (?, 'issued', 'issued', ?)`, [invoice.insertId, JSON.stringify({ contextType, platformOrderId: order.id })]);
    await connection.execute('UPDATE platform_orders SET invoice_id=? WHERE id=?', [invoice.insertId, order.id]);
    return invoice.insertId;
  }
  async setPlatformBillingProfile(billingProfileId, actorUserId) {
    const [profiles] = await this.database.execute('SELECT id FROM billing_profiles WHERE id=? AND is_active=TRUE', [billingProfileId]);
    if (!profiles[0]) return false;
    await this.database.execute(`INSERT INTO platform_billing_settings (settings_key, billing_profile_id, updated_by_user_id) VALUES ('platform', ?, ?)
      ON DUPLICATE KEY UPDATE billing_profile_id=VALUES(billing_profile_id), updated_by_user_id=VALUES(updated_by_user_id)`, [billingProfileId, actorUserId]);
    await this.audit(actorUserId, 'platform_billing_profile_changed', 'billing_profile', billingProfileId); return true;
  }
  async platformBillingProfileReady() {
    const [rows] = await this.database.execute(`SELECT profile.id FROM platform_billing_settings settings JOIN billing_profiles profile ON profile.id=settings.billing_profile_id
      WHERE settings.settings_key='platform' AND profile.is_active=TRUE`);
    return Boolean(rows[0]);
  }
  async hasPlatformEntitlement({ userId, organizationId = null, feature, eventId = null }) {
    const [rows] = await this.database.execute(`SELECT id FROM platform_entitlements WHERE feature=? AND revoked_at IS NULL AND starts_at<=NOW()
      AND (ends_at IS NULL OR ends_at>NOW()) AND (user_id=? OR (? IS NOT NULL AND organization_id=?) OR (? IS NOT NULL AND event_id=?)) LIMIT 1`, [feature, userId, organizationId, organizationId, eventId, eventId]);
    return Boolean(rows[0]);
  }
  billingProfileCompleteness(profile, context) {
    const missing = [];
    for (const key of ['legalName', 'addressLine1', 'postalCode', 'city', 'country', 'billingEmail']) if (!profile?.[key]) missing.push(key);
    if (context === 'venue_seller' && profile?.profileType === 'organization' && !profile.organizationNumber) missing.push('organizationNumber');
    return { complete: missing.length === 0, missing };
  }
  async eventFinancialReadiness(eventId, userId, role) {
    const settings = await this.eventPaymentSettings(eventId, userId, role); if (!settings) return { requiresSellerProfile: false, sellerProfileComplete: false, requiresPaymentAccount: false, paymentAccountReady: false, ticketSalesReady: false };
    const profile = settings.sellerBillingProfileId ? await this.billingProfile(settings.sellerBillingProfileId, userId, role) : null;
    const completeness = this.billingProfileCompleteness(profile, 'ticket_seller');
    return { requiresSellerProfile: Boolean(settings.paymentsEnabled || settings.ticketSalesEnabled), sellerProfileComplete: completeness.complete,
      sellerProfileMissing: completeness.missing, requiresPaymentAccount: Boolean(settings.paymentsEnabled || settings.ticketSalesEnabled),
      paymentAccountReady: Boolean(settings.paymentAccountId && settings.chargesEnabled && settings.onboardingStatus === 'ready'),
      ticketSalesReady: Boolean(settings.ticketSalesEnabled && completeness.complete && settings.paymentAccountId && settings.chargesEnabled && settings.onboardingStatus === 'ready' && settings.sellerCapacity) };
  }
  async platformSubscriptions(userId, role) {
    const [rows] = await this.database.execute(`SELECT id, subscriber_user_id AS subscriberUserId, subscriber_organization_id AS subscriberOrganizationId,
      buyer_billing_profile_id AS buyerBillingProfileId, product_id AS productId, buyer_capacity AS buyerCapacity, status,
      current_period_start AS currentPeriodStart, current_period_end AS currentPeriodEnd, cancel_at_period_end AS cancelAtPeriodEnd,
      provider, provider_subscription_id AS providerSubscriptionId, created_at AS createdAt FROM platform_subscriptions
      WHERE ${['manager', 'admin'].includes(role) ? 'TRUE' : 'subscriber_user_id=?'} ORDER BY created_at DESC`, ['manager', 'admin'].includes(role) ? [] : [userId]);
    return rows.map((row) => ({ ...row, cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd) }));
  }
  async subscriptionForViewer(subscriptionId, userId, role) {
    const [rows] = await this.database.execute(`SELECT id, subscriber_user_id AS subscriberUserId, provider, provider_subscription_id AS providerSubscriptionId, status
      FROM platform_subscriptions WHERE id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : 'subscriber_user_id=?'})`, ['manager', 'admin'].includes(role) ? [subscriptionId] : [subscriptionId, userId]);
    return rows[0] || null;
  }
  async markSubscriptionCancellation(subscriptionId) {
    await this.database.execute(`UPDATE platform_subscriptions SET cancel_at_period_end=TRUE WHERE id=? AND status IN ('pending','active','past_due')`, [subscriptionId]);
  }
  async allocateInvoiceNumber(connection, sellerBillingProfileId, prefix, issueYear = new Date().getUTCFullYear()) {
    // The row lock makes a per-seller/year sequence safe under concurrent
    // issuance. Draft invoices never call this method.
    const [seriesRows] = await connection.execute(`SELECT id, prefix, next_number AS nextNumber FROM invoice_series
      WHERE seller_billing_profile_id=? AND year=? FOR UPDATE`, [sellerBillingProfileId, issueYear]);
    let series = seriesRows[0];
    if (!series) {
      const normalizedPrefix = String(prefix || 'INV').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20) || 'INV';
      const [insert] = await connection.execute(`INSERT INTO invoice_series (seller_billing_profile_id, prefix, year, next_number)
        VALUES (?, ?, ?, 2)`, [sellerBillingProfileId, normalizedPrefix, issueYear]);
      series = { id: insert.insertId, prefix: normalizedPrefix, nextNumber: 1 };
    } else {
      await connection.execute('UPDATE invoice_series SET next_number=? WHERE id=?', [Number(series.nextNumber) + 1, series.id]);
    }
    return { seriesId: series.id, invoiceNumber: `${series.prefix}-${issueYear}-${String(series.nextNumber).padStart(4, '0')}` };
  }
  async canAccessInvoice(userId, role, invoiceId) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(`SELECT i.id FROM invoices i
      LEFT JOIN billing_profiles seller_profile ON seller_profile.id=i.seller_billing_profile_id
      LEFT JOIN billing_profiles buyer_profile ON buyer_profile.id=i.buyer_billing_profile_id
      LEFT JOIN organization_members seller_member ON seller_member.organization_id=COALESCE(i.seller_organization_id, seller_profile.owner_organization_id) AND seller_member.user_id=?
      LEFT JOIN organization_members buyer_member ON buyer_member.organization_id=COALESCE(i.buyer_organization_id, buyer_profile.owner_organization_id) AND buyer_member.user_id=? WHERE i.id=? AND
      (i.buyer_user_id=? OR buyer_profile.owner_user_id=? OR seller_profile.owner_user_id=? OR seller_member.role IN ('owner','admin','manager') OR buyer_member.role IN ('owner','admin'))`, [userId, userId, invoiceId, userId, userId, userId]);
    return Boolean(rows[0]);
  }
  async canManageInvoicePayment(userId, role, invoiceId) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(`SELECT invoice.id FROM invoices invoice
      LEFT JOIN billing_profiles seller ON seller.id=invoice.seller_billing_profile_id
      LEFT JOIN organization_members member ON member.organization_id=COALESCE(invoice.seller_organization_id, seller.owner_organization_id) AND member.user_id=?
      WHERE invoice.id=? AND (seller.owner_user_id=? OR member.role IN ('owner','admin'))`, [userId, invoiceId, userId]);
    return Boolean(rows[0]);
  }
  async invoicesForViewer(userId, role, { venueId = null } = {}) {
    const privileged = ['manager', 'admin'].includes(role);
    const access = privileged ? 'TRUE' : `(i.buyer_user_id=? OR buyer_profile.owner_user_id=? OR seller_profile.owner_user_id=? OR EXISTS (SELECT 1 FROM organization_members seller_member
      WHERE seller_member.organization_id=COALESCE(i.seller_organization_id, seller_profile.owner_organization_id) AND seller_member.user_id=? AND seller_member.role IN ('owner','admin','manager')) OR EXISTS (SELECT 1 FROM organization_members buyer_member
      WHERE buyer_member.organization_id=COALESCE(i.buyer_organization_id, buyer_profile.owner_organization_id) AND buyer_member.user_id=? AND buyer_member.role IN ('owner','admin')))`;
    const [rows] = await this.database.execute(`SELECT i.id, i.seller_organization_id AS sellerOrganizationId, i.seller_billing_profile_id AS sellerBillingProfileId,
      COALESCE(seller.name, seller_profile.legal_name) AS sellerOrganizationName, i.buyer_user_id AS buyerUserId, buyer.name AS buyerName,
      i.buyer_organization_id AS buyerOrganizationId, i.booking_id AS bookingId, booking.venue_id AS venueId, i.invoice_number AS invoiceNumber,
      i.context_type AS contextType, i.context_id AS contextId, i.status, i.delivery_status AS deliveryStatus, i.issue_date AS issueDate, i.due_date AS dueDate, i.currency,
      i.subtotal, i.tax_amount AS taxAmount, i.total_amount AS totalAmount, i.paid_at AS paidAt,
      e.id AS eventId, e.title AS eventTitle, i.created_at AS createdAt
      FROM invoices i LEFT JOIN organizations seller ON seller.id=i.seller_organization_id
      LEFT JOIN billing_profiles seller_profile ON seller_profile.id=i.seller_billing_profile_id
      LEFT JOIN billing_profiles buyer_profile ON buyer_profile.id=i.buyer_billing_profile_id
      LEFT JOIN users buyer ON buyer.id=i.buyer_user_id
      LEFT JOIN venue_bookings booking ON booking.id=i.booking_id
      LEFT JOIN events e ON e.id=booking.event_id
      WHERE ${access}${venueId === null ? '' : ' AND booking.venue_id=?'} ORDER BY i.created_at DESC, i.id DESC`, privileged ? (venueId === null ? [] : [venueId]) : [...[userId, userId, userId, userId, userId], ...(venueId === null ? [] : [venueId])]);
    return rows;
  }
  async invoice(invoiceId, userId, role) {
    if (!await this.canAccessInvoice(userId, role, invoiceId)) return null;
    const [rows] = await this.database.execute(`SELECT id, seller_organization_id AS sellerOrganizationId, seller_billing_profile_id AS sellerBillingProfileId, buyer_user_id AS buyerUserId,
      buyer_organization_id AS buyerOrganizationId, buyer_billing_profile_id AS buyerBillingProfileId, booking_id AS bookingId, context_type AS contextType, context_id AS contextId, invoice_series_id AS invoiceSeriesId, invoice_number AS invoiceNumber, status, delivery_status AS deliveryStatus,
      issue_date AS issueDate, due_date AS dueDate, currency, subtotal, tax_amount AS taxAmount, total_amount AS totalAmount,
      pdf_generated_at AS pdfGeneratedAt, pdf_hash AS pdfHash, paid_at AS paidAt, paid_date AS paidDate, manual_payment_reference AS manualPaymentReference,
      manual_payment_method AS manualPaymentMethod, manual_payment_note AS manualPaymentNote, voided_at AS voidedAt, void_reason AS voidReason, seller_snapshot_json AS sellerSnapshot,
      buyer_snapshot_json AS buyerSnapshot, booking_snapshot_json AS bookingSnapshot, tax_snapshot_json AS taxSnapshot,
      payment_instructions_snapshot AS paymentInstructions, created_at AS createdAt FROM invoices WHERE id=?`, [invoiceId]);
    if (!rows[0]) return null;
    const [items] = await this.database.execute(`SELECT id, description, quantity, unit, unit_price AS unitPrice, tax_rate AS taxRate,
      subtotal, tax_amount AS taxAmount, total FROM invoice_items WHERE invoice_id=? ORDER BY id`, [invoiceId]);
    const invoice = rows[0];
    return {
      ...invoice,
      seller: jsonValue(invoice.sellerSnapshot),
      buyer: jsonValue(invoice.buyerSnapshot),
      booking: jsonValue(invoice.bookingSnapshot),
      tax: jsonValue(invoice.taxSnapshot),
      paymentInstructions: jsonValue(invoice.paymentInstructions) || invoice.paymentInstructions,
      items,
      canManage: await this.canManageInvoicePayment(userId, role, invoiceId),
    };
  }
  async markInvoicePaid(invoiceId, userId, role, { paymentReference = null, paymentMethod, paidDate = null, internalNote = null }) {
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction();
      // Lock before authorization/state transition so simultaneous manual
      // reconciliation produces one audit event.
      const [rows] = await connection.execute(`SELECT i.id, i.status, i.seller_organization_id AS sellerOrganizationId, seller_profile.owner_user_id AS sellerProfileOwnerUserId, i.booking_id AS bookingId, i.currency, i.total_amount AS totalAmount FROM invoices i
        LEFT JOIN billing_profiles seller_profile ON seller_profile.id=i.seller_billing_profile_id
        WHERE i.id=? FOR UPDATE`, [invoiceId]);
      const invoice = rows[0]; if (!invoice) { await connection.rollback(); return false; }
      if (!['manager', 'admin'].includes(role) && Number(invoice.sellerProfileOwnerUserId) !== Number(userId)) { const [members] = await connection.execute(`SELECT role FROM organization_members
        WHERE organization_id=? AND user_id=? AND role IN ('owner','admin')`, [invoice.sellerOrganizationId, userId]); if (!members[0]) { await connection.rollback(); return false; } }
      if (!['issued', 'sent', 'overdue'].includes(invoice.status)) { await connection.rollback(); return { error: 'INVALID_STATE' }; }
      await connection.execute(`UPDATE invoices SET status='paid', paid_at=NOW(), paid_date=COALESCE(?, CURDATE()), paid_by_user_id=?, manual_payment_reference=?, manual_payment_method=?, manual_payment_note=? WHERE id=?`, [paidDate, userId, paymentReference, paymentMethod, internalNote, invoiceId]);
      await connection.execute(`INSERT INTO payments (invoice_id, booking_id, provider, status, currency, amount, payment_method_type, metadata_json, paid_at)
        VALUES (?, ?, 'manual', 'succeeded', ?, ?, ?, ?, NOW())`, [invoiceId, invoice.bookingId, invoice.currency, invoice.totalAmount, paymentMethod, JSON.stringify({ ...(paymentReference ? { reference: paymentReference } : {}), ...(paidDate ? { paidDate } : {}), ...(internalNote ? { internalNote } : {}) })]);
      if (invoice.bookingId) await connection.execute("UPDATE venue_bookings SET payment_status='paid' WHERE id=?", [invoice.bookingId]);
      await connection.execute(`INSERT INTO invoice_history (invoice_id, action, previous_status, new_status, performed_by_user_id) VALUES (?, 'marked_paid', ?, 'paid', ?)`, [invoiceId, invoice.status, userId]);
      await connection.commit(); return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async simulatePayment(invoiceId, userId, role, succeeded) {
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT id, booking_id AS bookingId, seller_organization_id AS sellerOrganizationId, status, currency, total_amount AS totalAmount FROM invoices WHERE id=? FOR UPDATE`, [invoiceId]);
      const invoice = rows[0]; if (!invoice || !await this.canAccessInvoice(userId, role, invoiceId)) { await connection.rollback(); return false; }
      if (!['issued', 'sent', 'overdue'].includes(invoice.status)) { await connection.rollback(); return { error: 'INVALID_STATE' }; }
      const status = succeeded ? 'succeeded' : 'failed';
      const [payment] = await connection.execute(`INSERT INTO payments (invoice_id, booking_id, provider, status, currency, amount, payment_method_type, payment_method_brand, payment_method_last4, ${succeeded ? 'paid_at' : 'failed_at'})
        VALUES (?, ?, 'test_stub', ?, ?, ?, 'card', 'Test Card', '4242', NOW())`, [invoiceId, invoice.bookingId, status, invoice.currency, invoice.totalAmount]);
      if (succeeded) { await connection.execute("UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=?", [invoiceId]); await connection.execute("UPDATE venue_bookings SET payment_status='paid' WHERE id=?", [invoice.bookingId]); }
      await connection.execute(`INSERT INTO invoice_history (invoice_id, action, previous_status, new_status, performed_by_user_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`, [invoiceId, succeeded ? 'test_payment_succeeded' : 'test_payment_failed', invoice.status, succeeded ? 'paid' : invoice.status, userId, JSON.stringify({ paymentId: payment.insertId, provider: 'test_stub' })]);
      await connection.commit(); return { id: payment.insertId, status, invoiceStatus: succeeded ? 'paid' : invoice.status };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async recordInvoicePdf(invoiceId, hash) {
    await this.database.execute('UPDATE invoices SET pdf_hash=COALESCE(pdf_hash, ?), pdf_generated_at=COALESCE(pdf_generated_at, NOW()) WHERE id=?', [hash, invoiceId]);
  }
  async invoiceDocument(invoiceId) {
    const [rows] = await this.database.execute('SELECT pdf_document AS pdfDocument, pdf_hash AS pdfHash, generated_at AS generatedAt FROM invoice_documents WHERE invoice_id=?', [invoiceId]);
    return rows[0] || null;
  }
  async storeInvoiceDocument(invoiceId, pdfDocument, pdfHash) {
    // The invoice snapshots are immutable, but the document renderer can be
    // corrected. Keep the cached PDF in sync with that snapshot so an already
    // issued invoice does not keep a known formatting defect forever.
    await this.database.execute(`INSERT INTO invoice_documents (invoice_id, pdf_document, pdf_hash, generated_at)
      VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE pdf_document=VALUES(pdf_document), pdf_hash=VALUES(pdf_hash), generated_at=VALUES(generated_at)`, [invoiceId, pdfDocument, pdfHash]);
    await this.database.execute('UPDATE invoices SET pdf_storage_key=COALESCE(pdf_storage_key, ?), pdf_hash=?, pdf_generated_at=NOW() WHERE id=?', [`database:invoice_documents/${invoiceId}`, pdfHash, invoiceId]);
    return this.invoiceDocument(invoiceId);
  }
  async markVenueInvoiceGenerationFailed(bookingId, error) {
    await this.database.execute("UPDATE venue_bookings SET invoice_generation_status='failed', invoice_generation_error=? WHERE id=?", [String(error || 'Invoice document generation failed').slice(0, 500), bookingId]);
  }
  async canManageVenue(id, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(`SELECT v.id FROM venues v LEFT JOIN organization_members om ON om.organization_id = v.organization_id AND om.user_id = ? WHERE v.id = ? AND (v.owner_user_id = ? OR om.role IN ('owner','admin','manager'))`, [userId, id, userId]);
    return Boolean(rows[0]);
  }
  async canManageVenueBilling(id, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(`SELECT v.id FROM venues v
      LEFT JOIN organization_members member ON member.organization_id=v.organization_id AND member.user_id=?
      WHERE v.id=? AND (member.role IN ('owner','admin') OR (v.organization_id IS NULL AND v.owner_user_id=?))`, [userId, id, userId]);
    return Boolean(rows[0]);
  }
  async venueAvailability(venueId) {
    const [rows] = await this.database.execute('SELECT id, venue_id AS venueId, day_of_week AS weekday, TIME_FORMAT(start_time, \'%H:%i\') AS startTime, TIME_FORMAT(end_time, \'%H:%i\') AS endTime FROM venue_availability_rules WHERE venue_id = ? AND is_active = TRUE ORDER BY day_of_week, start_time', [venueId]);
    return rows;
  }
  async venueTimezone(venueId) {
    const [rows] = await this.database.execute('SELECT timezone FROM venues WHERE id = ?', [venueId]);
    return rows[0] || null;
  }
  async venueAvailabilityForDate(venueId, date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const [venues] = await this.database.execute("SELECT id, timezone FROM venues WHERE id = ? AND is_active = TRUE AND moderation_status = 'approved'", [venueId]);
    if (!venues[0]) return null;
    const [slots] = await this.database.execute('SELECT TIME_FORMAT(start_time, \'%H:%i\') AS startTime, TIME_FORMAT(end_time, \'%H:%i\') AS endTime FROM venue_availability_rules WHERE venue_id = ? AND day_of_week = ? AND is_active = TRUE ORDER BY start_time', [venueId, weekday]);
    return { venueId, date, timezone: venues[0].timezone, slots };
  }
  async venueBookingSettings(venueId) {
    const [rows] = await this.database.execute(`SELECT venue_id AS venueId, booking_mode AS bookingMode,
      slot_increment_minutes AS slotIncrementMinutes, minimum_booking_minutes AS minimumBookingMinutes,
      maximum_booking_minutes AS maximumBookingMinutes, buffer_before_minutes AS bufferBeforeMinutes,
      buffer_after_minutes AS bufferAfterMinutes, minimum_notice_hours AS minimumNoticeHours,
      maximum_advance_days AS maximumAdvanceDays, currency, hourly_rate AS hourlyRate,
      daily_rate AS dailyRate, invoice_due_days AS invoiceDueDays FROM venue_booking_settings WHERE venue_id = ?`, [venueId]);
    return rows[0] || null;
  }
  async venueFinancialSettings(venueId, userId = null, role = null) {
    if (userId !== null && !await this.canManageVenueBilling(venueId, userId, role)) return null;
    const [rows] = await this.database.execute(`SELECT v.id AS venueId, v.organization_id AS organizationId,
      COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode,
      COALESCE(finance.seller_billing_profile_id, v.billing_profile_id, organization.default_billing_profile_id) AS sellerBillingProfileId,
      COALESCE(finance.payment_terms_days, booking.invoice_due_days, 30) AS paymentTermsDays,
      COALESCE(finance.tax_mode, 'no_tax') AS taxMode, finance.default_tax_rate AS defaultTaxRate,
      COALESCE(finance.prices_include_tax, FALSE) AS pricesIncludeTax,
      COALESCE(finance.confirmation_policy, 'on_owner_approval') AS confirmationPolicy,
      finance.accepted_terms_version AS acceptedTermsVersion, finance.accepted_at AS acceptedAt,
      finance.accepted_by_user_id AS acceptedByUserId,
      payment.methods_json AS methods, payment.bankgiro, payment.plusgiro, payment.iban, payment.bic,
      payment.swish_number AS swishNumber, payment.bank_name AS bankName,
      payment.account_details_text AS accountDetailsText, payment.additional_instructions AS additionalInstructions,
      COALESCE(payment.payment_reference_mode, 'invoice_number') AS paymentReferenceMode
      FROM venues v LEFT JOIN organizations organization ON organization.id=v.organization_id
      LEFT JOIN venue_booking_settings booking ON booking.venue_id=v.id
      LEFT JOIN venue_billing_settings finance ON finance.venue_id=v.id
      LEFT JOIN venue_payment_settings payment ON payment.venue_id=v.id WHERE v.id=?`, [venueId]);
    if (!rows[0]) return null;
    return { ...rows[0], methods: jsonValue(rows[0].methods) || [], pricesIncludeTax: Boolean(rows[0].pricesIncludeTax) };
  }
  async saveVenueFinancialSettings(venueId, userId, role, settings) {
    if (!await this.canManageVenueBilling(venueId, userId, role)) return { error: 'FORBIDDEN' };
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [venues] = await connection.execute(`SELECT venue.organization_id AS organizationId, finance.invoice_mode AS existingInvoiceMode,
        finance.accepted_terms_version AS existingTermsVersion, finance.accepted_at AS existingAcceptedAt,
        finance.accepted_by_user_id AS existingAcceptedByUserId FROM venues venue
        LEFT JOIN venue_billing_settings finance ON finance.venue_id=venue.id WHERE venue.id=? FOR UPDATE`, [venueId]);
      const venue = venues[0];
      if (!venue) { await connection.rollback(); return { error: 'NOT_FOUND' }; }
      if (settings.sellerBillingProfileId) {
        const [profiles] = await connection.execute(`SELECT id, owner_organization_id AS ownerOrganizationId, profile_type AS profileType
          FROM billing_profiles WHERE id=? AND is_active=TRUE FOR UPDATE`, [settings.sellerBillingProfileId]);
        const seller = profiles[0];
        if (!seller || seller.profileType !== 'organization' || Number(seller.ownerOrganizationId) !== Number(venue.organizationId)) {
          await connection.rollback(); return { error: 'SELLER_PROFILE_ORGANIZATION_MISMATCH' };
        }
      }
      const accepted = settings.acceptInvoiceAuthorization === true && settings.invoiceMode === 'ykcircle';
      const preserveAcceptance = !accepted && settings.invoiceMode === 'ykcircle' && venue.existingInvoiceMode === 'ykcircle';
      const acceptedTermsVersion = accepted ? settings.termsVersion : (preserveAcceptance ? venue.existingTermsVersion : null);
      const acceptedAt = accepted ? new Date() : (preserveAcceptance ? venue.existingAcceptedAt : null);
      const acceptedByUserId = accepted ? userId : (preserveAcceptance ? venue.existingAcceptedByUserId : null);
      await connection.execute(`INSERT INTO venue_billing_settings
        (venue_id, invoice_mode, seller_billing_profile_id, payment_terms_days, tax_mode, default_tax_rate, prices_include_tax, confirmation_policy,
         accepted_terms_version, accepted_at, accepted_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE invoice_mode=VALUES(invoice_mode), seller_billing_profile_id=VALUES(seller_billing_profile_id),
        payment_terms_days=VALUES(payment_terms_days), tax_mode=VALUES(tax_mode), default_tax_rate=VALUES(default_tax_rate),
        prices_include_tax=VALUES(prices_include_tax), confirmation_policy=VALUES(confirmation_policy),
        accepted_terms_version=VALUES(accepted_terms_version), accepted_at=VALUES(accepted_at), accepted_by_user_id=VALUES(accepted_by_user_id)`,
      [venueId, settings.invoiceMode, settings.sellerBillingProfileId, settings.paymentTermsDays, settings.taxMode, settings.defaultTaxRate,
        settings.pricesIncludeTax, settings.confirmationPolicy, acceptedTermsVersion, acceptedAt, acceptedByUserId]);
      await connection.execute(`INSERT INTO venue_payment_settings
        (venue_id, methods_json, bankgiro, plusgiro, iban, bic, swish_number, bank_name, account_details_text, additional_instructions, payment_reference_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE methods_json=VALUES(methods_json), bankgiro=VALUES(bankgiro), plusgiro=VALUES(plusgiro), iban=VALUES(iban),
        bic=VALUES(bic), swish_number=VALUES(swish_number), bank_name=VALUES(bank_name), account_details_text=VALUES(account_details_text),
        additional_instructions=VALUES(additional_instructions), payment_reference_mode=VALUES(payment_reference_mode)`,
      [venueId, JSON.stringify(settings.methods), settings.bankgiro, settings.plusgiro, settings.iban, settings.bic, settings.swishNumber,
        settings.bankName, settings.accountDetailsText, settings.additionalInstructions, settings.paymentReferenceMode]);
      await connection.execute('UPDATE venues SET billing_profile_id=? WHERE id=?', [settings.sellerBillingProfileId, venueId]);
      await connection.commit();
      await this.audit(userId, 'venue_financial_settings_changed', 'venue', venueId, { invoiceMode: settings.invoiceMode, sellerBillingProfileId: settings.sellerBillingProfileId, methods: settings.methods });
      return this.venueFinancialSettings(venueId, userId, role);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async getVenueFinancialReadiness(venueId, userId = null, role = null) {
    const settings = await this.venueFinancialSettings(venueId, userId, role);
    if (!settings) return null;
    let seller = null;
    if (settings.sellerBillingProfileId) {
      const [profiles] = await this.database.execute(`SELECT ${this.billingProfileColumns('p')} FROM billing_profiles p WHERE p.id=?`, [settings.sellerBillingProfileId]);
      seller = profiles[0] ? { ...profiles[0], isActive: Boolean(profiles[0].isActive) } : null;
      if (seller && Number(seller.ownerOrganizationId) !== Number(settings.organizationId)) seller = null;
    }
    return { venueId, ...evaluateVenueFinancialReadiness(settings, seller, settings) };
  }
  async updateVenueBookingSettings(venueId, userId, role, settings) {
    if (!await this.canManageVenue(venueId, userId, role)) return false;
    const [result] = await this.database.execute(`INSERT INTO venue_booking_settings (venue_id, booking_mode, slot_increment_minutes, minimum_booking_minutes,
      maximum_booking_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_hours, maximum_advance_days, currency, hourly_rate, daily_rate, invoice_due_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE booking_mode=VALUES(booking_mode),
      slot_increment_minutes=VALUES(slot_increment_minutes), minimum_booking_minutes=VALUES(minimum_booking_minutes), maximum_booking_minutes=VALUES(maximum_booking_minutes),
      buffer_before_minutes=VALUES(buffer_before_minutes), buffer_after_minutes=VALUES(buffer_after_minutes), minimum_notice_hours=VALUES(minimum_notice_hours),
      maximum_advance_days=VALUES(maximum_advance_days), currency=VALUES(currency), hourly_rate=VALUES(hourly_rate), daily_rate=VALUES(daily_rate), invoice_due_days=VALUES(invoice_due_days)`,
    [venueId, settings.bookingMode, settings.slotIncrementMinutes, settings.minimumBookingMinutes, settings.maximumBookingMinutes, settings.bufferBeforeMinutes, settings.bufferAfterMinutes, settings.minimumNoticeHours, settings.maximumAdvanceDays, settings.currency, settings.hourlyRate, settings.dailyRate, settings.invoiceDueDays]);
    return result.affectedRows > 0;
  }
  async venueAvailabilityData(venueId, from, to) {
    const [venues] = await this.database.execute('SELECT id, timezone, is_active AS isActive, moderation_status AS moderationStatus FROM venues WHERE id = ?', [venueId]);
    if (!venues[0]) return null;
    const venue = venues[0];
    // Database DATETIME values are UTC instants. Query with venue-local day
    // bounds converted to UTC, otherwise a booking near midnight is loaded
    // for the wrong calendar day (or not loaded at all).
    const rangeStart = localDateTimeToUtc(from, '00:00', venue.timezone, 'start');
    const rangeEnd = localDateTimeToUtc(addDays(to, 1), '00:00', venue.timezone, 'start');
    if (!rangeStart || !rangeEnd) return null;
    const rangeStartUtc = rangeStart.toISOString().slice(0, 19).replace('T', ' ');
    const rangeEndUtc = rangeEnd.toISOString().slice(0, 19).replace('T', ' ');
    const [rules] = await this.database.execute(`SELECT day_of_week AS weekday, TIME_FORMAT(start_time, '%H:%i') AS startTime,
      TIME_FORMAT(end_time, '%H:%i') AS endTime, is_active AS isActive FROM venue_availability_rules WHERE venue_id = ? ORDER BY day_of_week, start_time`, [venueId]);
    const [overrideRows] = await this.database.execute(`SELECT o.id, o.date, o.override_type AS overrideType,
      TIME_FORMAT(w.start_time, '%H:%i') AS startTime, TIME_FORMAT(w.end_time, '%H:%i') AS endTime
      FROM venue_availability_overrides o LEFT JOIN venue_availability_override_windows w ON w.override_id=o.id
      WHERE o.venue_id=? AND o.date BETWEEN ? AND ? ORDER BY o.date, w.start_time`, [venueId, from, to]);
    const overrides = [...overrideRows.reduce((map, row) => {
      if (!map.has(row.id)) map.set(row.id, { id: row.id, date: row.date, overrideType: row.overrideType, windows: [] });
      if (row.startTime) map.get(row.id).windows.push({ startTime: row.startTime, endTime: row.endTime });
      return map;
    }, new Map()).values()];
    const [blocks] = await this.database.execute(`SELECT start_at AS startAt, end_at AS endAt FROM venue_availability_blocks
      WHERE venue_id=? AND start_at < ? AND end_at > ?`, [venueId, rangeEndUtc, rangeStartUtc]);
    const [externalReservations] = await this.database.execute(`SELECT start_at AS startAt, end_at AS endAt FROM venue_external_reservations
      WHERE venue_id=? AND cancelled_at IS NULL AND start_at < ? AND end_at > ?`, [venueId, rangeEndUtc, rangeStartUtc]);
    const [bookingRows] = await this.database.execute(`SELECT booking_type AS bookingType, booking_date AS bookingDate, venue_timezone AS venueTimezone,
      occupied_start_at AS startAt, occupied_end_at AS endAt, status FROM venue_bookings
      WHERE venue_id=? AND status IN ('requested', 'confirmed') AND ((booking_type='daily' AND booking_date BETWEEN ? AND ?) OR
      (booking_type='hourly' AND occupied_start_at < ? AND occupied_end_at > ?))`, [venueId, from, to, rangeEndUtc, rangeStartUtc]);
    const bookings = bookingRows.flatMap((booking) => {
      if (booking.bookingType !== 'daily') return [booking];
      const date = booking.bookingDate instanceof Date ? booking.bookingDate.toISOString().slice(0, 10) : String(booking.bookingDate).slice(0, 10);
      const bookingTimezone = booking.venueTimezone || venue.timezone;
      const startAt = localDateTimeToUtc(date, '00:00', bookingTimezone, 'start');
      const endAt = localDateTimeToUtc(addDays(date, 1), '00:00', bookingTimezone, 'start');
      return startAt && endAt ? [{ ...booking, startAt, endAt }] : [];
    });
    return { venue, rules: rules.map((rule) => ({ ...rule, isActive: Boolean(rule.isActive) })), overrides, blocks, externalReservations, bookings };
  }
  async calculateVenueAvailability(venueId, from, to, { publicOnly = true } = {}) {
    if (!isDateOnly(from) || !isDateOnly(to) || from > to) return null;
    const data = await this.venueAvailabilityData(venueId, from, to);
    if (!data || (publicOnly && (!data.venue.isActive || data.venue.moderationStatus !== 'approved'))) return null;
    const settings = await this.venueBookingSettings(venueId);
    return { venueId, timezone: data.venue.timezone, bookingMode: settings.bookingMode, slotIncrementMinutes: settings.slotIncrementMinutes,
      minimumBookingMinutes: settings.minimumBookingMinutes, maximumBookingMinutes: settings.maximumBookingMinutes,
      bufferBeforeMinutes: settings.bufferBeforeMinutes, bufferAfterMinutes: settings.bufferAfterMinutes,
      currency: settings.currency, hourlyRate: settings.hourlyRate, dailyRate: settings.dailyRate,
      dates: calculateAvailability({ from, to, timezone: data.venue.timezone, ...data }) };
  }
  async replaceVenueAvailabilityOverrides(venueId, userId, role, overrides) {
    if (!await this.canManageVenue(venueId, userId, role)) return false;
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction(); await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [venueId]);
      await connection.execute('DELETE FROM venue_availability_overrides WHERE venue_id=?', [venueId]);
      for (const override of overrides) { const [result] = await connection.execute('INSERT INTO venue_availability_overrides (venue_id, date, override_type) VALUES (?, ?, ?)', [venueId, override.date, override.overrideType]);
        for (const window of override.windows || []) await connection.execute('INSERT INTO venue_availability_override_windows (override_id, start_time, end_time) VALUES (?, ?, ?)', [result.insertId, window.startTime, window.endTime]); }
      await connection.commit(); return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async venueCalendar(venueId, userId, role, from, to) {
    if (!await this.canManageVenue(venueId, userId, role)) return null;
    const availability = await this.calculateVenueAvailability(venueId, from, to, { publicOnly: false });
    if (!availability) return null;
    const rangeStart = localDateTimeToUtc(from, '00:00', availability.timezone, 'start');
    const rangeEnd = localDateTimeToUtc(addDays(to, 1), '00:00', availability.timezone, 'start');
    if (!rangeStart || !rangeEnd) return null;
    const rangeStartUtc = rangeStart.toISOString().slice(0, 19).replace('T', ' ');
    const rangeEndUtc = rangeEnd.toISOString().slice(0, 19).replace('T', ' ');
    const [overrides] = await this.database.execute('SELECT id, date, override_type AS overrideType FROM venue_availability_overrides WHERE venue_id=? AND date BETWEEN ? AND ? ORDER BY date', [venueId, from, to]);
    const [blocks] = await this.database.execute('SELECT id, start_at AS startAt, end_at AS endAt, reason, created_by_user_id AS createdByUserId FROM venue_availability_blocks WHERE venue_id=? AND start_at < ? AND end_at > ?', [venueId, rangeEndUtc, rangeStartUtc]);
    const [externalReservations] = await this.database.execute('SELECT id, start_at AS startAt, end_at AS endAt, source, title, notes, cancelled_at AS cancelledAt FROM venue_external_reservations WHERE venue_id=? AND start_at < ? AND end_at > ?', [venueId, rangeEndUtc, rangeStartUtc]);
    const [bookings] = await this.database.execute(`SELECT id, organizer_user_id AS organizerUserId, booking_type AS bookingType, booking_date AS bookingDate, venue_timezone AS venueTimezone, start_at AS startAt, end_at AS endAt, status, organizer_message AS organizerMessage FROM venue_bookings WHERE venue_id=? AND ((booking_type='daily' AND booking_date BETWEEN ? AND ?) OR (booking_type='hourly' AND start_at < ? AND end_at > ?))`, [venueId, from, to, rangeEndUtc, rangeStartUtc]);
    return { timezone: availability.timezone, range: { from, to }, availability: availability.dates, overrides, blocks,
      bookingRequests: bookings.filter((booking) => booking.status === 'requested'), confirmedBookings: bookings.filter((booking) => booking.status === 'confirmed'), externalReservations };
  }
  async checkBookingConflict({ venueId, bookingType = 'hourly', bookingDate = null, occupiedStartAt = null, occupiedEndAt = null, excludeBookingId = null, excludeExternalReservationId = null }, executor = this.database) {
    const [venues] = await executor.execute('SELECT timezone FROM venues WHERE id=?', [venueId]);
    if (!venues[0]) return { conflict: true, reason: 'VENUE_NOT_FOUND' };
    const timezone = venues[0].timezone;
    let start = occupiedStartAt ? new Date(occupiedStartAt) : null;
    let end = occupiedEndAt ? new Date(occupiedEndAt) : null;
    if (bookingType === 'daily') {
      const dailyDate = dateOnly(bookingDate);
      if (!dailyDate) return { conflict: true, reason: 'INVALID_INTERVAL' };
      start = localDateTimeToUtc(dailyDate, '00:00', timezone, 'start');
      end = localDateTimeToUtc(addDays(dailyDate, 1), '00:00', timezone, 'start');
    }
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return { conflict: true, reason: 'INVALID_INTERVAL' };
    const [bookings] = await executor.execute(`SELECT id, booking_type AS bookingType, booking_date AS bookingDate, venue_timezone AS venueTimezone,
      occupied_start_at AS startAt, occupied_end_at AS endAt FROM venue_bookings
      WHERE venue_id=? AND status IN ('requested', 'confirmed')${excludeBookingId ? ' AND id <> ?' : ''} FOR UPDATE`, excludeBookingId ? [venueId, excludeBookingId] : [venueId]);
    const [reservations] = await executor.execute(`SELECT id, start_at AS startAt, end_at AS endAt FROM venue_external_reservations
      WHERE venue_id=? AND cancelled_at IS NULL${excludeExternalReservationId ? ' AND id <> ?' : ''} FOR UPDATE`, excludeExternalReservationId ? [venueId, excludeExternalReservationId] : [venueId]);
    const occupied = [...reservations, ...bookings.flatMap((booking) => {
      if (booking.bookingType !== 'daily') return [booking];
      const date = dateOnly(booking.bookingDate);
      if (!date) return [];
      const bookingTimezone = booking.venueTimezone || timezone;
      const startAt = localDateTimeToUtc(date, '00:00', bookingTimezone, 'start');
      const endAt = localDateTimeToUtc(addDays(date, 1), '00:00', bookingTimezone, 'start');
      return startAt && endAt ? [{ ...booking, startAt, endAt }] : [];
    })];
    return { conflict: occupied.some((item) => start < new Date(item.endAt) && end > new Date(item.startAt)) };
  }
  async createVenueAvailabilityBlock(venueId, userId, role, block) {
    if (!await this.canManageVenue(venueId, userId, role)) return null;
    const [result] = await this.database.execute('INSERT INTO venue_availability_blocks (venue_id, start_at, end_at, reason, created_by_user_id) VALUES (?, ?, ?, ?, ?)', [venueId, block.startAt, block.endAt, block.reason, userId]);
    return result.insertId;
  }
  async deleteVenueAvailabilityBlock(venueId, blockId, userId, role) {
    if (!await this.canManageVenue(venueId, userId, role)) return false;
    const [result] = await this.database.execute('DELETE FROM venue_availability_blocks WHERE id=? AND venue_id=?', [blockId, venueId]);
    return result.affectedRows > 0;
  }
  async createExternalReservation(venueId, userId, role, reservation) {
    if (!await this.canManageVenue(venueId, userId, role)) return { error: 'FORBIDDEN' };
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction();
      const [venues] = await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [venueId]);
      if (!venues[0]) { await connection.rollback(); return { error: 'NOT_FOUND' }; }
      const checked = await this.checkBookingConflict({ venueId, occupiedStartAt: reservation.startAt, occupiedEndAt: reservation.endAt }, connection);
      if (checked.conflict) { await connection.rollback(); return { error: checked.reason || 'CONFLICT' }; }
      const [result] = await connection.execute(`INSERT INTO venue_external_reservations (venue_id, start_at, end_at, source, title, notes, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [venueId, reservation.startAt, reservation.endAt, reservation.source, reservation.title, reservation.notes, userId]);
      await connection.commit(); return { id: result.insertId };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async cancelExternalReservation(venueId, reservationId, userId, role) {
    if (!await this.canManageVenue(venueId, userId, role)) return false;
    const [result] = await this.database.execute('UPDATE venue_external_reservations SET cancelled_at=NOW() WHERE id=? AND venue_id=? AND cancelled_at IS NULL AND start_at > NOW()', [reservationId, venueId]);
    return result.affectedRows > 0;
  }
  async venueMedia(venueId) { const [rows] = await this.database.execute('SELECT id, filename, alt_text AS altText, caption, is_cover AS isCover, sort_order AS sortOrder, created_at AS createdAt FROM venue_media WHERE venue_id = ? ORDER BY is_cover DESC, sort_order, id', [venueId]); return rows.map((item) => ({ ...item, isCover: Boolean(item.isCover) })); }
  async addVenueMedia(venueId, filename, altText, caption, isCover) {
    if (isCover) await this.database.execute('UPDATE venue_media SET is_cover = FALSE WHERE venue_id = ?', [venueId]);
    const [order] = await this.database.execute('SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM venue_media WHERE venue_id = ?', [venueId]);
    const [result] = await this.database.execute('INSERT INTO venue_media (venue_id, filename, alt_text, caption, is_cover, sort_order) VALUES (?, ?, ?, ?, ?, ?)', [venueId, filename, altText, caption, isCover, order[0].nextOrder]);
    return result.insertId;
  }
  async venueImageVisible(filename, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const visibility = privileged ? 'TRUE' : "(v.is_active = TRUE AND v.moderation_status = 'approved') OR v.owner_user_id = ? OR om.role IN ('owner','admin','manager')";
    // publiclyVisible drives the proxy's cache header: an image readable only
    // because the viewer manages the venue must never enter a shared cache.
    const [rows] = await this.database.execute(
      `SELECT m.id, (v.is_active = TRUE AND v.moderation_status = 'approved') AS publiclyVisible FROM venue_media m JOIN venues v ON v.id = m.venue_id LEFT JOIN organization_members om ON om.organization_id = v.organization_id AND om.user_id = ? WHERE m.filename = ? AND (${visibility})`,
      privileged ? [userId, filename] : [userId, filename, userId],
    );
    return rows[0] ? { ...rows[0], publiclyVisible: Boolean(rows[0].publiclyVisible) } : null;
  }
  async venue(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT ${this.venueColumns()}, owner.name AS ownerName, organization.name AS organizationName, organization.slug AS organizationSlug, member.role AS membershipRole, type.slug AS venueType, type.name AS venueTypeName FROM venues v JOIN users owner ON owner.id = v.owner_user_id LEFT JOIN organizations organization ON organization.id = v.organization_id LEFT JOIN organization_members member ON member.organization_id = v.organization_id AND member.user_id = ? LEFT JOIN venue_types type ON type.id = v.venue_type_id WHERE v.id = ? AND (${privileged ? 'TRUE' : "COALESCE(v.is_active, TRUE) = TRUE OR v.owner_user_id = ? OR member.user_id IS NOT NULL"})`, privileged ? [userId, id] : [userId, id, userId]);
    if (!rows[0]) return null;
    const managed = privileged || rows[0].ownerUserId === userId || Boolean(rows[0].membershipRole);
    // canManage travels with the payload so the API can decide whether image
    // URLs need a signed token, without repeating the membership lookup.
    return { ...await this.decorateVenue(rows[0], { publicView: !managed }), canManage: managed, availability: await this.venueAvailability(id), images: await this.venueMedia(id) };
  }
  async venueBySlug(slug, userId = null, role = null) { const [rows] = await this.database.execute('SELECT id FROM venues WHERE slug = ?', [slug]); return rows[0] ? this.venue(rows[0].id, userId, role) : null; }
  async venuesForViewer(userId = null, role = null, { managedOnly = false, city = null, venueType = null, eventType = null, amenities = [], minCapacity = null, maxCapacity = null, maxPrice = null, verifiedOnly = false } = {}) {
    const privileged = ['manager', 'admin'].includes(role);
    // Do not add an owner predicate for an anonymous visitor.  Besides making
    // the public intent unambiguous, this avoids relying on a NULL-bound
    // placeholder in the public listing query.  COALESCE keeps venues made
    // before the NOT NULL default was introduced visible until their row is
    // active venues are always represented by the current schema contract.
    let filter = 'TRUE';
    let parameters = [];
    if (managedOnly) {
      if (!privileged) {
        filter = "(v.owner_user_id = ? OR EXISTS (SELECT 1 FROM organization_members managed_member WHERE managed_member.organization_id = v.organization_id AND managed_member.user_id = ? AND managed_member.role IN ('owner','admin','manager')))";
        parameters = [userId, userId];
      }
    } else if (!privileged) {
      filter = 'COALESCE(v.is_active, TRUE) = TRUE';
      if (userId !== null) {
        filter = `(${filter} OR v.owner_user_id = ?)`;
        parameters = [userId];
      }
    }
    if (city) { filter += ' AND (v.city = ? OR v.municipality = ?)'; parameters.push(city, city); }
    if (venueType) { filter += ' AND EXISTS (SELECT 1 FROM venue_types type WHERE type.id = v.venue_type_id AND type.slug = ?)'; parameters.push(venueType); }
    if (eventType) { filter += ' AND EXISTS (SELECT 1 FROM venue_event_type_assignments veta JOIN venue_event_types vet ON vet.id = veta.event_type_id WHERE veta.venue_id = v.id AND vet.slug = ?)'; parameters.push(eventType); }
    for (const amenity of amenities) { filter += ' AND EXISTS (SELECT 1 FROM venue_amenity_assignments va JOIN venue_amenities a ON a.id = va.amenity_id WHERE va.venue_id = v.id AND a.slug = ?)'; parameters.push(amenity); }
    if (minCapacity != null) { filter += ' AND COALESCE(v.capacity_max, v.standing_capacity, v.seated_capacity, 0) >= ?'; parameters.push(minCapacity); }
    if (maxCapacity != null) { filter += ' AND COALESCE(v.capacity_min, 0) <= ?'; parameters.push(maxCapacity); }
    if (maxPrice != null) { filter += " AND (v.price_unit = 'contact' OR v.price_from IS NULL OR v.price_from <= ?)"; parameters.push(maxPrice); }
    if (verifiedOnly) filter += " AND v.verification_status = 'verified'";
    const [rows] = await this.database.execute(`SELECT ${this.venueColumns()}, owner.name AS ownerName, organization.name AS organizationName, organization.slug AS organizationSlug, type.slug AS venueType, type.name AS venueTypeName, EXISTS (SELECT 1 FROM venue_promotions p WHERE p.venue_id = v.id AND p.status = 'active' AND p.starts_at <= NOW() AND p.ends_at > NOW()) AS sponsored FROM venues v JOIN users owner ON owner.id = v.owner_user_id LEFT JOIN organizations organization ON organization.id = v.organization_id LEFT JOIN venue_types type ON type.id = v.venue_type_id WHERE ${filter} ORDER BY sponsored DESC, v.is_featured DESC, v.created_at DESC`, parameters);
    // A managedOnly listing is already filtered to venues the viewer manages.
    // The public listing only surfaces an inactive venue through the owner
    // predicate above, so an owner check is sufficient to flag it there.
    return Promise.all(rows.map(async (venue) => ({
      ...await this.decorateVenue(venue, { publicView: !managedOnly && !privileged }),
      canManage: managedOnly || privileged || (userId !== null && venue.ownerUserId === userId),
    })));
  }
  async createVenue(ownerUserId, data) {
    const [result] = await this.database.execute(`INSERT INTO venues (organization_id, billing_profile_id, owner_user_id, name, slug, business_name, short_description, description, address_line_1, address_line_2, postal_code, country, country_code, city, municipality, region, latitude, longitude, google_place_id, formatted_address, location_visibility, timezone, venue_type_id, capacity_min, capacity_max, standing_capacity, seated_capacity, dining_capacity, classroom_capacity, size_sqm, price_from, price_unit, currency, pricing_description, minimum_booking_hours, website_url, phone, contact_email, availability_type, house_rules_text, is_active, moderation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM venue_types WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`, [data.organizationId, data.billingProfileId, ownerUserId, data.name, data.slug, data.businessName, data.shortDescription, data.description, data.addressLine1, data.addressLine2, data.postalCode, data.country, data.countryCode, data.city, data.municipality, data.region, data.latitude, data.longitude, data.googlePlaceId, data.formattedAddress, data.locationVisibility, data.timezone, data.venueType, data.capacityMin, data.capacityMax, data.standingCapacity, data.seatedCapacity, data.diningCapacity, data.classroomCapacity, data.sizeSqm, data.priceFrom, data.priceUnit, data.currency, data.pricingDescription, data.minimumBookingHours, data.websiteUrl, data.phone, data.contactEmail, data.availabilityType, data.houseRulesText, data.isActive]);
    await this.database.execute('INSERT INTO venue_booking_settings (venue_id, currency, hourly_rate) VALUES (?, ?, ?)', [result.insertId, data.currency, data.priceFrom]);
    await this.replaceVenueRelations(result.insertId, data.amenitySlugs, data.suitableEventTypeSlugs);
    await this.replaceVenueAvailabilitySlots(result.insertId, data.availability || []);
    return result.insertId;
  }
  async replaceVenueRelations(venueId, amenitySlugs = [], eventTypeSlugs = []) {
    await this.database.execute('DELETE FROM venue_amenity_assignments WHERE venue_id = ?', [venueId]);
    await this.database.execute('DELETE FROM venue_event_type_assignments WHERE venue_id = ?', [venueId]);
    for (const slug of amenitySlugs) await this.database.execute('INSERT INTO venue_amenity_assignments (venue_id, amenity_id) SELECT ?, id FROM venue_amenities WHERE slug = ?', [venueId, slug]);
    for (const slug of eventTypeSlugs) await this.database.execute('INSERT INTO venue_event_type_assignments (venue_id, event_type_id) SELECT ?, id FROM venue_event_types WHERE slug = ?', [venueId, slug]);
  }
  async updateVenue(id, userId, role, data) {
    if (!await this.canManageVenue(id, userId, role)) return false;
    const [result] = await this.database.execute('UPDATE venues SET organization_id=?, billing_profile_id=?, name=?, slug=?, business_name=?, short_description=?, description=?, address_line_1=?, address_line_2=?, postal_code=?, country=?, country_code=?, city=?, municipality=?, region=?, latitude=?, longitude=?, google_place_id=?, formatted_address=?, location_visibility=?, timezone=?, venue_type_id=(SELECT id FROM venue_types WHERE slug=?), capacity_min=?, capacity_max=?, standing_capacity=?, seated_capacity=?, dining_capacity=?, classroom_capacity=?, size_sqm=?, price_from=?, price_unit=?, currency=?, pricing_description=?, minimum_booking_hours=?, website_url=?, phone=?, contact_email=?, availability_type=?, house_rules_text=?, is_active=? WHERE id=?', [data.organizationId, data.billingProfileId, data.name, data.slug, data.businessName, data.shortDescription, data.description, data.addressLine1, data.addressLine2, data.postalCode, data.country, data.countryCode, data.city, data.municipality, data.region, data.latitude, data.longitude, data.googlePlaceId, data.formattedAddress, data.locationVisibility, data.timezone, data.venueType, data.capacityMin, data.capacityMax, data.standingCapacity, data.seatedCapacity, data.diningCapacity, data.classroomCapacity, data.sizeSqm, data.priceFrom, data.priceUnit, data.currency, data.pricingDescription, data.minimumBookingHours, data.websiteUrl, data.phone, data.contactEmail, data.availabilityType, data.houseRulesText, data.isActive, id]);
    if (!result.affectedRows) return false;
    await this.replaceVenueRelations(id, data.amenitySlugs, data.suitableEventTypeSlugs);
    await this.replaceVenueAvailabilitySlots(id, data.availability || []);
    return true;
  }
  async deleteVenue(id, userId, role) {
    if (!await this.canManageVenue(id, userId, role)) return false;
    const [result] = await this.database.execute('DELETE FROM venues WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
  async createVenueInquiry(venueId, organizerUserId, data) {
    const [result] = await this.database.execute(`INSERT INTO venue_inquiries (venue_id, organizer_user_id, event_id, event_name, event_type, requested_date, start_time, end_time, expected_guests, budget, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [venueId, organizerUserId, data.eventId, data.eventName, data.eventType, data.requestedDate, data.startTime, data.endTime, data.expectedGuests, data.budget, data.message]);
    return result.insertId;
  }
  async eventForVenueInquiry(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT id, title, starts_at AS startsAt, ends_at AS endsAt, capacity FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? [eventId] : [eventId, userId]);
    return rows[0] || null;
  }
  async venueInquiries(venueId, userId, role) {
    if (!await this.canManageVenue(venueId, userId, role)) return null;
    const [rows] = await this.database.execute(`SELECT i.id, i.venue_id AS venueId, i.organizer_user_id AS organizerUserId, i.event_id AS eventId, i.event_name AS eventName, i.event_type AS eventType, i.requested_date AS requestedDate, TIME_FORMAT(i.start_time, '%H:%i') AS startTime, TIME_FORMAT(i.end_time, '%H:%i') AS endTime, i.expected_guests AS expectedGuests, i.budget, i.message, i.status, i.created_at AS createdAt, i.updated_at AS updatedAt, u.name AS organizerName FROM venue_inquiries i JOIN users u ON u.id = i.organizer_user_id WHERE i.venue_id = ? ORDER BY i.created_at DESC`, [venueId]);
    return rows;
  }
  async updateVenueInquiryStatus(inquiryId, venueId, userId, role, status) {
    if (!await this.canManageVenue(venueId, userId, role)) return false;
    const [result] = await this.database.execute('UPDATE venue_inquiries SET status = ? WHERE id = ? AND venue_id = ?', [status, inquiryId, venueId]);
    return result.affectedRows > 0;
  }
  async moderateVenue(venueId, moderationStatus, verificationStatus = null, isActive = null) {
    // Never compare a bound parameter with a SQL string literal. The driver
    // tags parameters with its own collation, so such a comparison can leave
    // MySQL with two COERCIBLE operands and no precedence rule to pick between
    // them ("Illegal mix of collations"). Status strings are therefore compared
    // in JavaScript and bound as booleans. Column-versus-literal stays in SQL
    // because a column's collation takes precedence over a literal's, and it
    // reads the same value whichever order MySQL evaluates the assignments in:
    // an omitted status leaves the column unchanged.
    const [result] = await this.database.execute(`UPDATE venues SET moderation_status = ?, verification_status = COALESCE(?, verification_status), is_verified = CASE WHEN ? IS NULL THEN verification_status = 'verified' ELSE ? END, is_active = COALESCE(?, is_active), published_at = CASE WHEN ? AND published_at IS NULL THEN NOW() ELSE published_at END WHERE id = ?`, [moderationStatus, verificationStatus, verificationStatus, verificationStatus === 'verified', isActive, moderationStatus === 'approved', venueId]);
    return result.affectedRows > 0;
  }
  async submitVenueForModeration(venueId) {
    // Submission is deliberately a narrow state transition. Owners may ask
    // for review, but only an administrator can approve, reject, or remove a
    // listing. Keeping both status literals in SQL also avoids comparing a
    // bound string parameter with a literal under incompatible collations.
    const [result] = await this.database.execute("UPDATE venues SET moderation_status = 'pending' WHERE id = ? AND moderation_status IN ('draft', 'rejected')", [venueId]);
    return result.affectedRows > 0;
  }
  async saveVenue(venueId, userId) {
    const [result] = await this.database.execute('INSERT IGNORE INTO saved_venues (user_id, venue_id) SELECT ?, id FROM venues WHERE id = ? AND is_active = TRUE', [userId, venueId]);
    return result.affectedRows > 0;
  }
  async unsaveVenue(venueId, userId) { const [result] = await this.database.execute('DELETE FROM saved_venues WHERE venue_id = ? AND user_id = ?', [venueId, userId]); return result.affectedRows > 0; }
  async savedVenues(userId) {
    const [rows] = await this.database.execute(`SELECT ${this.venueColumns()}, owner.name AS ownerName, organization.name AS organizationName, organization.slug AS organizationSlug, type.slug AS venueType, type.name AS venueTypeName, FALSE AS sponsored FROM saved_venues saved JOIN venues v ON v.id = saved.venue_id JOIN users owner ON owner.id = v.owner_user_id LEFT JOIN organizations organization ON organization.id = v.organization_id LEFT JOIN venue_types type ON type.id = v.venue_type_id WHERE saved.user_id = ? AND v.is_active = TRUE ORDER BY saved.created_at DESC`, [userId]);
    return Promise.all(rows.map((venue) => this.decorateVenue(venue, { publicView: true })));
  }
  async similarVenues(venueId, userId = null, role = null) {
    const venue = await this.venue(venueId, userId, role);
    if (!venue) return null;
    return this.venuesForViewer(userId, role, { city: venue.city, venueType: venue.venueType }).then((venues) => venues.filter((item) => item.id !== venueId).slice(0, 6));
  }
  async replaceVenueAvailability(venueId, userId, role, slots) {
    if (!await this.canManageVenue(venueId, userId, role)) return false;
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [venues] = await connection.execute('SELECT id FROM venues WHERE id = ? FOR UPDATE', [venueId]);
      if (!venues[0]) { await connection.rollback(); return false; }
      await this.replaceVenueAvailabilitySlots(venueId, slots, connection);
      await connection.commit();
      return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async replaceVenueAvailabilitySlots(venueId, slots = [], executor = this.database) {
    await executor.execute('DELETE FROM venue_availability_rules WHERE venue_id = ?', [venueId]);
    for (const slot of slots) await executor.execute('INSERT INTO venue_availability_rules (venue_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)', [venueId, slot.weekday, slot.startTime, slot.endTime]);
  }
  async venueBookingContext(eventId, venueId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(`SELECT id, manager_id AS managerId, starts_at AS startsAt, ends_at AS endsAt, timezone FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? [eventId] : [eventId, userId]);
    if (!events[0]) return { error: 'EVENT_NOT_FOUND' };
    const [venues] = await this.database.execute('SELECT id, owner_user_id AS ownerUserId, name, timezone, is_active AS isActive FROM venues WHERE id = ?', [venueId]);
    if (!venues[0] || !venues[0].isActive) return { error: 'VENUE_NOT_FOUND' };
    return { event: events[0], venue: { ...venues[0], availability: await this.venueAvailability(venueId) } };
  }
  async requestVenueBooking(eventId, venueId, organizerUserId, role, buyerBillingProfileId = null) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.requestVenueBookingOnConnection(connection, eventId, venueId, organizerUserId, role, buyerBillingProfileId);
      if (result.error) await connection.rollback();
      else await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async requestVenueBookingOnConnection(connection, eventId, venueId, organizerUserId, role, buyerBillingProfileId = null) {
    const [events] = await connection.execute('SELECT starts_at AS startsAt, ends_at AS endsAt FROM events WHERE id = ? AND manager_id = ? AND deleted_at IS NULL FOR UPDATE', [eventId, organizerUserId]);
    const event = events[0];
    if (!event) { return { error: 'EVENT_NOT_FOUND' }; }
    const [venues] = await connection.execute('SELECT id, timezone, price_from AS priceFrom, currency FROM venues WHERE id = ? AND is_active = TRUE FOR UPDATE', [venueId]);
    if (!venues[0]) { return { error: 'VENUE_NOT_FOUND' }; }
    const [existing] = await connection.execute('SELECT id, status FROM venue_bookings WHERE event_id = ? FOR UPDATE', [eventId]);
    if (existing[0] && ['requested', 'confirmed'].includes(existing[0].status)) { return { error: 'EVENT_ALREADY_BOOKED' }; }
    const [settingsRows] = await connection.execute('SELECT booking_mode AS bookingMode, buffer_before_minutes AS beforeMinutes, buffer_after_minutes AS afterMinutes, currency, hourly_rate AS hourlyRate, daily_rate AS dailyRate FROM venue_booking_settings WHERE venue_id=?', [venueId]);
    const settings = settingsRows[0];
    if (!settings) { throw new Error(`Missing booking settings for venue ${venueId}`); }
    const localStart = zonedDateTime(event.startsAt instanceof Date ? event.startsAt : `${String(event.startsAt).replace(' ', 'T').replace(/Z$/i, '')}Z`, venues[0].timezone);
    if (!localStart) { return { error: 'INVALID_EVENT_TIME' }; }
    const bookingType = settings.bookingMode === 'daily' ? 'daily' : 'hourly';
    const occupiedStart = new Date(new Date(event.startsAt).getTime() - settings.beforeMinutes * 60 * 1000);
    const occupiedEnd = new Date(new Date(event.endsAt).getTime() + settings.afterMinutes * 60 * 1000);
    const conflict = await this.checkBookingConflict({ venueId, bookingType, bookingDate: localStart.date, occupiedStartAt: occupiedStart, occupiedEndAt: occupiedEnd, excludeBookingId: existing[0]?.id || null }, connection);
    if (conflict.conflict) { return { error: 'VENUE_UNAVAILABLE' }; }
    const durationMinutes = (new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000;
    const configuredRate = bookingType === 'daily' ? settings.dailyRate ?? venues[0].priceFrom : settings.hourlyRate ?? venues[0].priceFrom;
    const rate = Number.isFinite(Number(configuredRate)) && Number(configuredRate) >= 0 ? Number(configuredRate) : 0;
    const subtotal = bookingType === 'daily' ? rate : Math.round((rate * durationMinutes / 60) * 100) / 100;
    const paidBooking = subtotal > 0;
    let buyerProfileId = null;
    if (paidBooking) {
      let profileId = Number(buyerBillingProfileId);
      // Existing event editors did not send a billing-profile id with the
      // booking request. Prefer the account's default active profile so a
      // paid venue continues to receive its requested booking; an explicit
      // id remains authoritative when the organizer selected one.
      if (!Number.isInteger(profileId) || profileId < 1) {
        const privileged = ['manager', 'admin'].includes(role);
        const [profiles] = await connection.execute(`SELECT p.id FROM billing_profiles p
          LEFT JOIN organization_members member ON member.organization_id=p.owner_organization_id AND member.user_id=?
          WHERE p.is_active=TRUE AND (p.owner_user_id=? OR member.role IN ('owner','admin') OR ${privileged ? 'TRUE' : 'FALSE'})
          ORDER BY p.is_default DESC, p.updated_at DESC LIMIT 1`, [organizerUserId, organizerUserId]);
        profileId = Number(profiles[0]?.id);
      }
      if (Number.isInteger(profileId) && profileId > 0) {
        const profile = await this.billingProfile(profileId, organizerUserId, role, connection);
        if (!profile) return { error: 'BILLING_PROFILE_UNAVAILABLE' };
        buyerProfileId = profile.id;
      }
    }
    // Missing billing details must not hide a request from the venue owner.
    // Approval still requires a complete buyer profile for a paid booking.
    const billingStatus = paidBooking ? (buyerProfileId ? 'complete' : 'incomplete') : 'not_required';
    let bookingId;
    if (existing[0]) {
      await connection.execute("UPDATE venue_bookings SET venue_id=?, organizer_user_id=?, buyer_billing_profile_id=?, billing_status=?, booking_type=?, status='requested', owner_note=NULL, start_at=?, end_at=?, occupied_start_at=?, occupied_end_at=?, booking_date=?, venue_timezone=?, currency=?, subtotal=?, tax_amount=0, total_amount=? WHERE id=?", [venueId, organizerUserId, buyerProfileId, billingStatus, bookingType, event.startsAt, event.endsAt, occupiedStart, occupiedEnd, localStart.date, venues[0].timezone, settings.currency, subtotal, subtotal, existing[0].id]);
      bookingId = existing[0].id;
    } else {
      const [result] = await connection.execute("INSERT INTO venue_bookings (venue_id, event_id, organizer_user_id, buyer_billing_profile_id, billing_status, booking_type, booking_date, start_at, end_at, occupied_start_at, occupied_end_at, venue_timezone, currency, subtotal, tax_amount, total_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'requested')", [venueId, eventId, organizerUserId, buyerProfileId, billingStatus, bookingType, localStart.date, event.startsAt, event.endsAt, occupiedStart, occupiedEnd, venues[0].timezone, settings.currency, subtotal, subtotal]);
      bookingId = result.insertId;
    }
    return { id: bookingId, status: 'requested' };
  }
  async eventVenueBooking(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId, b.buyer_billing_profile_id AS buyerBillingProfileId, b.billing_status AS billingStatus, b.booking_type AS bookingType, b.start_at AS startAt, b.end_at AS endAt, b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt, b.venue_timezone AS timezone, b.booking_date AS bookingDate, b.status, b.payment_status AS paymentStatus, b.currency, b.subtotal, b.tax_amount AS taxAmount, b.total_amount AS totalAmount, b.invoice_generation_status AS invoiceGenerationStatus, b.invoice_generation_error AS invoiceGenerationError, b.owner_note AS ownerNote, b.created_at AS createdAt, b.updated_at AS updatedAt,
      v.name AS venueName, v.formatted_address AS venueLocation, v.owner_user_id AS venueOwnerUserId,
      invoice.id AS invoiceId, invoice.invoice_number AS invoiceNumber, invoice.status AS invoiceStatus,
      external.id AS externalInvoiceId, external.status AS externalInvoiceStatus, external.external_invoice_number AS externalInvoiceNumber,
      external.external_invoice_url AS externalInvoiceUrl, external.due_date AS externalInvoiceDueDate
      FROM venue_bookings b JOIN venues v ON v.id = b.venue_id JOIN events e ON e.id = b.event_id
      LEFT JOIN invoices invoice ON invoice.booking_id=b.id LEFT JOIN booking_external_invoices external ON external.booking_id=b.id
      WHERE b.event_id = ? AND (${privileged ? 'TRUE' : 'e.manager_id = ? OR v.owner_user_id = ?'})`, privileged ? [eventId] : [eventId, userId, userId]);
    return rows[0] ? { ...rows[0], startAt: utcTimestamp(rows[0].startAt), endAt: utcTimestamp(rows[0].endAt), occupiedStartAt: utcTimestamp(rows[0].occupiedStartAt), occupiedEndAt: utcTimestamp(rows[0].occupiedEndAt), createdAt: utcTimestamp(rows[0].createdAt), updatedAt: utcTimestamp(rows[0].updatedAt) } : null;
  }
  async venueBookings(venueId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId, b.buyer_billing_profile_id AS buyerBillingProfileId, b.booking_type AS bookingType, b.booking_date AS bookingDate, b.venue_timezone AS venueTimezone, b.start_at AS startAt, b.end_at AS endAt, b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt, b.status, b.payment_status AS paymentStatus, b.currency, b.subtotal, b.tax_amount AS taxAmount, b.total_amount AS totalAmount, b.invoice_generation_status AS invoiceGenerationStatus, b.invoice_generation_error AS invoiceGenerationError, b.owner_note AS ownerNote, b.created_at AS createdAt, b.updated_at AS updatedAt,
      e.title AS eventTitle, e.timezone AS eventTimezone, organizer.name AS organizerName, organizer.email AS organizerEmail,
      buyer.legal_name AS buyerLegalName, invoice.id AS invoiceId, invoice.invoice_number AS invoiceNumber, invoice.status AS invoiceStatus,
      external.id AS externalInvoiceId, external.status AS externalInvoiceStatus, external.external_invoice_number AS externalInvoiceNumber,
      external.external_invoice_url AS externalInvoiceUrl, external.due_date AS externalInvoiceDueDate,
      COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode
      FROM venue_bookings b JOIN venues v ON v.id = b.venue_id JOIN events e ON e.id = b.event_id JOIN users organizer ON organizer.id = b.organizer_user_id
      LEFT JOIN billing_profiles buyer ON buyer.id=b.buyer_billing_profile_id LEFT JOIN invoices invoice ON invoice.booking_id=b.id
      LEFT JOIN booking_external_invoices external ON external.booking_id=b.id LEFT JOIN venue_billing_settings finance ON finance.venue_id=v.id
      LEFT JOIN organization_members venue_member ON venue_member.organization_id=v.organization_id AND venue_member.user_id=?
      WHERE b.venue_id = ? AND (${privileged ? 'TRUE' : "v.owner_user_id=? OR venue_member.role IN ('owner','admin','manager')"})
      ORDER BY CASE WHEN b.status = 'requested' THEN 0 ELSE 1 END, b.created_at DESC, b.id DESC`, privileged ? [userId, venueId] : [userId, venueId, userId]);
    return rows;
  }
  async canAccessVenueBooking(bookingId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT b.id FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
      LEFT JOIN organization_members venue_member ON venue_member.organization_id=v.organization_id AND venue_member.user_id=?
      WHERE b.id=? AND (${privileged ? 'TRUE' : "b.organizer_user_id=? OR v.owner_user_id=? OR venue_member.role IN ('owner','admin','manager')"})`, privileged ? [userId, bookingId] : [userId, bookingId, userId, userId]);
    return Boolean(rows[0]);
  }
  async updateVenueBookingBuyerBillingProfile(bookingId, userId, role, buyerBillingProfileId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const privileged = ['manager', 'admin'].includes(role);
      const [bookings] = await connection.execute(`SELECT booking.id, booking.event_id AS eventId FROM venue_bookings booking
        JOIN events event_row ON event_row.id=booking.event_id
        WHERE booking.id=? AND booking.status='requested' AND (${privileged ? 'TRUE' : 'event_row.manager_id=?'}) FOR UPDATE`,
      privileged ? [bookingId] : [bookingId, userId]);
      const booking = bookings[0];
      if (!booking) { await connection.rollback(); return { error: 'BOOKING_NOT_EDITABLE' }; }
      const profile = await this.billingProfile(buyerBillingProfileId, userId, role, connection);
      if (!profile) { await connection.rollback(); return { error: 'BILLING_PROFILE_UNAVAILABLE' }; }
      const completeness = this.billingProfileCompleteness(profile, 'venue_buyer');
      if (!completeness.complete) { await connection.rollback(); return { error: 'BUYER_PROFILE_INCOMPLETE', missing: completeness.missing }; }
      await connection.execute("UPDATE venue_bookings SET buyer_billing_profile_id=?, billing_status='complete' WHERE id=?", [profile.id, bookingId]);
      await connection.commit();
      await this.audit(userId, 'venue_booking_buyer_profile_updated', 'venue_booking', bookingId, { buyerBillingProfileId: profile.id });
      return { id: bookingId, eventId: booking.eventId, buyerBillingProfileId: profile.id };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async venueBookingMessages(bookingId, userId, role) {
    if (!await this.canAccessVenueBooking(bookingId, userId, role)) return null;
    const [rows] = await this.database.execute(`SELECT m.id, m.booking_id AS bookingId, m.sender_user_id AS senderUserId,
      sender.name AS senderName, m.body, m.created_at AS createdAt FROM venue_booking_messages m JOIN users sender ON sender.id=m.sender_user_id
      WHERE m.booking_id=? ORDER BY m.created_at ASC, m.id ASC`, [bookingId]);
    return rows;
  }
  async createVenueBookingMessage(bookingId, userId, role, body) {
    if (!await this.canAccessVenueBooking(bookingId, userId, role)) return null;
    const [result] = await this.database.execute('INSERT INTO venue_booking_messages (booking_id, sender_user_id, body) VALUES (?, ?, ?)', [bookingId, userId, body]);
    return { id: result.insertId, bookingId, senderUserId: userId, body };
  }
  async reviewVenueBookingLegacy(bookingId, userId, role, status, ownerNote = null) {
    const connection = await this.database.getConnection();
    try { await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT b.venue_id AS venueId, b.organizer_user_id AS organizerUserId, b.buyer_billing_profile_id AS buyerBillingProfileId, b.billing_status AS billingStatus, b.currency, b.subtotal, b.tax_amount AS taxAmount, b.total_amount AS totalAmount,
        b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt, v.organization_id AS sellerOrganizationId, v.owner_user_id AS sellerOwnerUserId,
        v.name AS venueName, v.formatted_address AS venueAddress, b.booking_type AS bookingType, b.booking_date AS bookingDate, b.start_at AS startAt, b.end_at AS endAt, e.title AS eventTitle, settings.hourly_rate AS hourlyRate, settings.daily_rate AS dailyRate,
        seller_profile.id AS sellerBillingProfileId, seller_profile.legal_name AS sellerLegalName, seller_profile.organization_number AS sellerRegistrationNumber,
        seller_profile.vat_number AS sellerVatNumber, seller_profile.address_line_1 AS sellerAddressLine1,
        seller_profile.address_line_2 AS sellerAddressLine2, seller_profile.postal_code AS sellerPostalCode,
        seller_profile.city AS sellerCity, seller_profile.country AS sellerCountry,
        seller_profile.billing_email AS sellerBillingEmail, seller_profile.payment_instructions AS sellerPaymentInstructions,
        seller_profile.invoice_prefix AS invoicePrefix, seller_profile.invoice_due_days AS profileInvoiceDueDays,
        settings.invoice_due_days AS invoiceDueDays FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
        LEFT JOIN events e ON e.id=b.event_id
        JOIN venue_booking_settings settings ON settings.venue_id=v.id LEFT JOIN billing_profiles seller_profile ON seller_profile.id=v.billing_profile_id
        LEFT JOIN organization_members om ON om.organization_id=v.organization_id AND om.user_id=?
        WHERE b.id=? AND b.status = 'requested' AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "v.owner_user_id=? OR om.role IN ('owner','admin','manager')"}) FOR UPDATE`, ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId]);
      const booking = rows[0]; if (!booking) { await connection.rollback(); return false; }
      await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [booking.venueId]);
      if (status === 'confirmed') { const conflict = await this.checkBookingConflict({ venueId: booking.venueId, bookingType: booking.bookingType, bookingDate: booking.bookingDate, occupiedStartAt: booking.occupiedStartAt, occupiedEndAt: booking.occupiedEndAt, excludeBookingId: bookingId }, connection); if (conflict.conflict) { await connection.rollback(); return { error: 'CONFLICT' }; } }
      let buyerProfile = null;
      const confirmed = status === 'confirmed';
      const durationHours = Math.max(0, (new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime()) / 3600000);
      const storedSubtotal = Number(booking.subtotal) || 0;
      const rate = Number(booking.bookingType === 'daily' ? booking.dailyRate : booking.hourlyRate);
      const calculatedSubtotal = Number.isFinite(rate) && rate > 0
        ? booking.bookingType === 'daily' ? rate : Math.round(rate * durationHours * 100) / 100 : 0;
      // Requests created before pricing was added stored a zero total. Apply
      // today's configured rate when they are approved, while preserving an
      // explicitly priced booking (including a genuinely free venue).
      const subtotal = storedSubtotal > 0 || calculatedSubtotal === 0 ? storedSubtotal : calculatedSubtotal;
      const taxRate = 0;
      const taxAmount = Math.round(subtotal * taxRate) / 100;
      const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;
      if (status === 'confirmed' && totalAmount > 0) {
        const sellerComplete = booking.sellerBillingProfileId && booking.sellerLegalName && booking.sellerAddressLine1 && booking.sellerPostalCode && booking.sellerCity && booking.sellerCountry && booking.sellerBillingEmail;
        if (!sellerComplete) { await connection.rollback(); return { error: 'SELLER_PROFILE_INCOMPLETE' }; }
        const [buyers] = await connection.execute(`SELECT id, profile_type AS profileType, legal_name AS legalName, organization_number AS organizationNumber,
          vat_number AS vatNumber, address_line_1 AS addressLine1, address_line_2 AS addressLine2, postal_code AS postalCode,
          city, country, billing_email AS billingEmail, phone FROM billing_profiles WHERE id=? AND is_active=TRUE FOR UPDATE`, [booking.buyerBillingProfileId]);
        buyerProfile = buyers[0] || null;
        const buyerComplete = booking.billingStatus === 'complete' && buyerProfile && buyerProfile.legalName && buyerProfile.addressLine1 && buyerProfile.postalCode && buyerProfile.city && buyerProfile.country && buyerProfile.billingEmail;
        if (!buyerComplete) { await connection.rollback(); return { error: 'BUYER_PROFILE_INCOMPLETE' }; }
      }
      if (confirmed && (storedSubtotal === 0 || Number(booking.taxAmount) !== taxAmount)) {
        await connection.execute('UPDATE venue_bookings SET subtotal=?, tax_amount=?, total_amount=? WHERE id=?', [subtotal, taxAmount, totalAmount, bookingId]);
      }
      await connection.execute('UPDATE venue_bookings SET status=?, owner_note=?, venue_internal_note=?, confirmed_at=CASE WHEN ? THEN NOW() ELSE confirmed_at END, confirmed_by=CASE WHEN ? THEN ? ELSE confirmed_by END WHERE id=?', [status, ownerNote, ownerNote, confirmed, confirmed, userId, bookingId]);
      let invoiceId = null;
      if (status === 'confirmed' && totalAmount > 0) {
        const [existingInvoice] = await connection.execute('SELECT id FROM invoices WHERE booking_id=? FOR UPDATE', [bookingId]);
        if (existingInvoice[0]) invoiceId = existingInvoice[0].id;
        else {
          const allocation = await this.allocateInvoiceNumber(connection, booking.sellerBillingProfileId, booking.invoicePrefix);
          const sellerSnapshot = { legalName: booking.sellerLegalName, organizationNumber: booking.sellerRegistrationNumber, vatNumber: booking.sellerVatNumber || null, addressLine1: booking.sellerAddressLine1, addressLine2: booking.sellerAddressLine2, postalCode: booking.sellerPostalCode, city: booking.sellerCity, country: booking.sellerCountry, billingEmail: booking.sellerBillingEmail };
          const bookingSnapshot = { venueName: booking.venueName, venueAddress: booking.venueAddress, eventTitle: booking.eventTitle, startsAt: utcTimestamp(booking.startAt), endsAt: utcTimestamp(booking.endAt) };
          const taxSnapshot = { type: 'not_calculated', rate: taxRate, taxAmount, country: booking.sellerCountry };
          const paymentInstructions = { text: booking.sellerPaymentInstructions };
          const [invoice] = await connection.execute(`INSERT INTO invoices (seller_organization_id, seller_billing_profile_id, buyer_user_id, buyer_billing_profile_id, booking_id, context_type, context_id, invoice_series_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total_amount, seller_snapshot_json, buyer_snapshot_json, booking_snapshot_json, tax_snapshot_json, payment_instructions_snapshot)
          VALUES (?, ?, ?, ?, ?, 'venue_booking', ?, ?, ?, 'issued', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [booking.sellerOrganizationId, booking.sellerBillingProfileId, booking.organizerUserId, buyerProfile.id, bookingId, String(bookingId), allocation.seriesId, allocation.invoiceNumber, booking.profileInvoiceDueDays || booking.invoiceDueDays, booking.currency, subtotal, taxAmount, totalAmount, JSON.stringify(sellerSnapshot), JSON.stringify(buyerProfile), JSON.stringify(bookingSnapshot), JSON.stringify(taxSnapshot), JSON.stringify(paymentInstructions)]);
          invoiceId = invoice.insertId;
          const quantity = booking.bookingType === 'daily' ? 1 : Math.round(durationHours * 1000) / 1000;
          const unitPrice = quantity > 0 ? Math.round((subtotal / quantity) * 100) / 100 : 0;
          await connection.execute(`INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, tax_rate, subtotal, tax_amount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [invoiceId, `Venue rental${booking.venueName ? `: ${booking.venueName}` : ''}`, quantity, booking.bookingType === 'daily' ? 'day' : 'hour', unitPrice, taxRate, subtotal, taxAmount, totalAmount]);
          await connection.execute(`INSERT INTO invoice_history (invoice_id, action, new_status, performed_by_user_id) VALUES (?, 'issued', 'issued', ?)`, [invoiceId, userId]); }
      }
      await connection.commit(); return { invoiceId };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async venueBookingFinancialContext(bookingId, executor = this.database, { lock = false } = {}) {
    const [rows] = await executor.execute(`SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId,
      b.buyer_billing_profile_id AS buyerBillingProfileId, b.booking_type AS bookingType, b.booking_date AS bookingDate,
      b.start_at AS startAt, b.end_at AS endAt, b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt,
      b.venue_timezone AS venueTimezone, b.status, b.currency, b.subtotal AS storedSubtotal,
      v.organization_id AS sellerOrganizationId, v.owner_user_id AS sellerOwnerUserId, v.billing_profile_id AS legacySellerBillingProfileId,
      v.name AS venueName, v.formatted_address AS venueAddress, v.price_from AS fallbackRate,
      organization.default_billing_profile_id AS organizationDefaultBillingProfileId, organization.name AS organizationName,
      event.title AS eventTitle, booking.hourly_rate AS hourlyRate, booking.daily_rate AS dailyRate,
      COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode,
      COALESCE(finance.seller_billing_profile_id, v.billing_profile_id, organization.default_billing_profile_id) AS sellerBillingProfileId,
      COALESCE(finance.payment_terms_days, booking.invoice_due_days, 30) AS paymentTermsDays,
      COALESCE(finance.tax_mode, 'no_tax') AS taxMode, finance.default_tax_rate AS defaultTaxRate,
      COALESCE(finance.prices_include_tax, FALSE) AS pricesIncludeTax,
      COALESCE(finance.confirmation_policy, 'on_owner_approval') AS confirmationPolicy,
      finance.accepted_terms_version AS acceptedTermsVersion, finance.accepted_at AS acceptedAt,
      finance.accepted_by_user_id AS acceptedByUserId,
      payment.methods_json AS methods, payment.bankgiro, payment.plusgiro, payment.iban, payment.bic,
      payment.swish_number AS swishNumber, payment.bank_name AS bankName, payment.account_details_text AS accountDetailsText,
      payment.additional_instructions AS additionalInstructions, COALESCE(payment.payment_reference_mode, 'invoice_number') AS paymentReferenceMode
      FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
      LEFT JOIN organizations organization ON organization.id=v.organization_id
      LEFT JOIN events event ON event.id=b.event_id
      JOIN venue_booking_settings booking ON booking.venue_id=v.id
      LEFT JOIN venue_billing_settings finance ON finance.venue_id=v.id
      LEFT JOIN venue_payment_settings payment ON payment.venue_id=v.id
      WHERE b.id=?${lock ? ' FOR UPDATE' : ''}`, [bookingId]);
    if (!rows[0]) return null;
    const context = { ...rows[0], methods: jsonValue(rows[0].methods) || [], pricesIncludeTax: Boolean(rows[0].pricesIncludeTax) };
    const [sellers] = context.sellerBillingProfileId ? await executor.execute(`SELECT ${this.billingProfileColumns('p')} FROM billing_profiles p WHERE p.id=?`, [context.sellerBillingProfileId]) : [[]];
    const [buyers] = context.buyerBillingProfileId ? await executor.execute(`SELECT ${this.billingProfileColumns('p')} FROM billing_profiles p WHERE p.id=?`, [context.buyerBillingProfileId]) : [[]];
    context.seller = sellers[0] ? { ...sellers[0], isActive: Boolean(sellers[0].isActive) } : null;
    context.buyer = buyers[0] ? { ...buyers[0], isActive: Boolean(buyers[0].isActive) } : null;
    return context;
  }
  async calculateVenueBookingPrice(bookingId, executor = this.database) {
    const context = await this.venueBookingFinancialContext(bookingId, executor);
    if (!context) return null;
    return calculateVenueBookingPrice({
      bookingType: context.bookingType, startAt: context.startAt, endAt: context.endAt,
      hourlyRate: context.hourlyRate, dailyRate: context.dailyRate, fallbackRate: context.fallbackRate,
      currency: context.currency, taxMode: context.taxMode, defaultTaxRate: context.defaultTaxRate,
      pricesIncludeTax: context.pricesIncludeTax, venueName: context.venueName,
    });
  }
  async getVenueBookingBillingReadiness(bookingId) {
    const context = await this.venueBookingFinancialContext(bookingId);
    if (!context) return null;
    const price = calculateVenueBookingPrice({
      bookingType: context.bookingType, startAt: context.startAt, endAt: context.endAt,
      hourlyRate: context.hourlyRate, dailyRate: context.dailyRate, fallbackRate: context.fallbackRate,
      currency: context.currency, taxMode: context.taxMode, defaultTaxRate: context.defaultTaxRate,
      pricesIncludeTax: context.pricesIncludeTax, venueName: context.venueName,
    });
    const isInvoiceRequired = !price?.error && price.total > 0;
    const buyerBillingProfileReady = !isInvoiceRequired || Boolean(context.buyer?.isActive && context.buyer.legalName && context.buyer.addressLine1 && context.buyer.postalCode && context.buyer.city && context.buyer.country && context.buyer.billingEmail);
    const seller = context.seller && Number(context.seller.ownerOrganizationId) === Number(context.sellerOrganizationId) ? context.seller : null;
    const venueReadiness = evaluateVenueFinancialReadiness(context, seller, context);
    const priceReady = !price?.error;
    return {
      bookingId, invoiceMode: context.invoiceMode, isInvoiceRequired, buyerBillingProfileReady, priceReady,
      price: priceReady ? price : null, priceError: price?.error || null, venue: venueReadiness,
      canApprove: !isInvoiceRequired || (buyerBillingProfileReady && priceReady && (context.invoiceMode === 'external' || venueReadiness.canIssueInvoice)),
    };
  }
  async ensureVenueBookingInvoice(bookingId, issuedByUserId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const context = await this.venueBookingFinancialContext(bookingId, connection, { lock: true });
      if (!context || context.status !== 'confirmed') { await connection.rollback(); return { error: 'BOOKING_NOT_CONFIRMED' }; }
      const price = calculateVenueBookingPrice({
        bookingType: context.bookingType, startAt: context.startAt, endAt: context.endAt,
        hourlyRate: context.hourlyRate, dailyRate: context.dailyRate, fallbackRate: context.fallbackRate,
        currency: context.currency, taxMode: context.taxMode, defaultTaxRate: context.defaultTaxRate,
        pricesIncludeTax: context.pricesIncludeTax, venueName: context.venueName,
      });
      if (price?.error) { await connection.rollback(); return { error: price.error }; }
      if (price.total <= 0) {
        await connection.execute("UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='not_required', invoice_generation_error=NULL WHERE id=?", [bookingId]);
        await connection.commit(); return { invoiceId: null, invoiceMode: context.invoiceMode, paymentStatus: 'not_required' };
      }
      if (context.invoiceMode === 'external') {
        const [existing] = await connection.execute('SELECT id FROM booking_external_invoices WHERE booking_id=? FOR UPDATE', [bookingId]);
        let externalInvoiceId = existing[0]?.id;
        if (!externalInvoiceId) {
          const [created] = await connection.execute(`INSERT INTO booking_external_invoices (booking_id, amount, currency, status)
            VALUES (?, ?, ?, 'awaiting_invoice')`, [bookingId, price.total, price.currency]);
          externalInvoiceId = created.insertId;
        }
        await connection.execute("UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL WHERE id=?", [bookingId]);
        await connection.commit();
        return { invoiceId: null, externalInvoiceId, invoiceMode: 'external', paymentStatus: 'unpaid' };
      }
      const seller = context.seller && Number(context.seller.ownerOrganizationId) === Number(context.sellerOrganizationId) ? context.seller : null;
      const readiness = evaluateVenueFinancialReadiness(context, seller, context);
      if (!readiness.canIssueInvoice) { await connection.rollback(); return { error: 'FINANCIAL_SETUP_INCOMPLETE', missing: readiness.missing }; }
      if (!context.buyer?.isActive) { await connection.rollback(); return { error: 'BUYER_PROFILE_INCOMPLETE' }; }
      const [existing] = await connection.execute('SELECT id FROM invoices WHERE booking_id=? FOR UPDATE', [bookingId]);
      if (existing[0]) {
        await connection.execute("UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL WHERE id=?", [bookingId]);
        await connection.commit(); return { invoiceId: existing[0].id, invoiceMode: 'ykcircle', paymentStatus: 'invoice_open' };
      }
      const allocation = await this.allocateInvoiceNumber(connection, seller.id, seller.invoicePrefix);
      const sellerSnapshot = { legalName: seller.legalName, organizationNumber: seller.organizationNumber, vatNumber: seller.vatNumber, addressLine1: seller.addressLine1, addressLine2: seller.addressLine2, postalCode: seller.postalCode, city: seller.city, country: seller.country, billingEmail: seller.billingEmail, phone: seller.phone };
      const buyerSnapshot = { legalName: context.buyer.legalName, profileType: context.buyer.profileType, organizationNumber: context.buyer.organizationNumber, vatNumber: context.buyer.vatNumber, addressLine1: context.buyer.addressLine1, addressLine2: context.buyer.addressLine2, postalCode: context.buyer.postalCode, city: context.buyer.city, country: context.buyer.country, billingEmail: context.buyer.billingEmail, phone: context.buyer.phone };
      const bookingSnapshot = { venueName: context.venueName, venueAddress: context.venueAddress, bookingDate: context.bookingDate, startsAt: utcTimestamp(context.startAt), endsAt: utcTimestamp(context.endAt), venueTimezone: context.venueTimezone, bookingReference: `VB-${bookingId}`, eventId: context.eventId, eventTitle: context.eventTitle, pricingRuleVersion: price.pricingRuleVersion };
      const paymentInstructions = { methods: context.methods, bankgiro: context.bankgiro, plusgiro: context.plusgiro, iban: context.iban, bic: context.bic, swishNumber: context.swishNumber, bankName: context.bankName, accountDetailsText: context.accountDetailsText, additionalInstructions: context.additionalInstructions, referenceMode: context.paymentReferenceMode };
      paymentInstructions.text = [context.bankgiro && `Bankgiro: ${context.bankgiro}`, context.plusgiro && `Plusgiro: ${context.plusgiro}`, context.iban && `IBAN: ${context.iban}`, context.bic && `BIC: ${context.bic}`, context.swishNumber && `Swish: ${context.swishNumber}`, context.bankName, context.accountDetailsText, context.additionalInstructions, `Reference: ${allocation.invoiceNumber}`].filter(Boolean).join('\n');
      const [invoice] = await connection.execute(`INSERT INTO invoices (seller_organization_id, seller_billing_profile_id, buyer_user_id, buyer_organization_id, buyer_billing_profile_id,
        booking_id, context_type, context_id, invoice_series_id, invoice_number, status, delivery_status, issue_date, due_date, currency, subtotal, tax_amount, total_amount,
        seller_snapshot_json, buyer_snapshot_json, booking_snapshot_json, tax_snapshot_json, payment_instructions_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, 'venue_booking', ?, ?, ?, 'issued', 'pending', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [context.sellerOrganizationId, seller.id, context.organizerUserId, context.buyer.ownerOrganizationId, context.buyer.id, bookingId, String(bookingId), allocation.seriesId,
        allocation.invoiceNumber, context.paymentTermsDays, price.currency, price.subtotal, price.taxAmount, price.total, JSON.stringify(sellerSnapshot), JSON.stringify(buyerSnapshot),
        JSON.stringify(bookingSnapshot), JSON.stringify({ mode: context.taxMode, rate: price.lineItems[0].taxRate, pricesIncludeTax: context.pricesIncludeTax }), JSON.stringify(paymentInstructions)]);
      for (const item of price.lineItems) await connection.execute(`INSERT INTO invoice_items
        (invoice_id, description, quantity, unit, unit_price, tax_rate, subtotal, tax_amount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoice.insertId, item.description, item.quantity, item.unit, item.unitPrice, item.taxRate, item.subtotal, item.taxAmount, item.total]);
      await connection.execute(`INSERT INTO invoice_history (invoice_id, action, new_status, performed_by_user_id, metadata_json)
        VALUES (?, 'issued', 'issued', ?, ?)`, [invoice.insertId, issuedByUserId, JSON.stringify({ source: 'venue_booking_approval' })]);
      await connection.execute("UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL, subtotal=?, tax_amount=?, total_amount=?, currency=? WHERE id=?", [price.subtotal, price.taxAmount, price.total, price.currency, bookingId]);
      await connection.commit();
      return { invoiceId: invoice.insertId, invoiceMode: 'ykcircle', invoiceNumber: allocation.invoiceNumber, paymentStatus: 'invoice_open' };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async externalInvoice(bookingId, userId, role) {
    if (!await this.canAccessVenueBooking(bookingId, userId, role)) return null;
    const [rows] = await this.database.execute(`SELECT external.id, external.booking_id AS bookingId,
      external.external_invoice_number AS externalInvoiceNumber, external.external_invoice_date AS externalInvoiceDate,
      external.amount, external.currency, external.due_date AS dueDate, external.external_invoice_url AS externalInvoiceUrl,
      external.status, external.marked_paid_at AS markedPaidAt, external.created_at AS createdAt, external.updated_at AS updatedAt,
      organization.name AS sellerName FROM booking_external_invoices external
      JOIN venue_bookings booking ON booking.id=external.booking_id JOIN venues venue ON venue.id=booking.venue_id
      LEFT JOIN organizations organization ON organization.id=venue.organization_id WHERE external.booking_id=?`, [bookingId]);
    return rows[0] || null;
  }
  async saveExternalInvoice(bookingId, userId, role, data) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [bookings] = await connection.execute(`SELECT booking.id, booking.currency, booking.total_amount AS totalAmount,
        COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode FROM venue_bookings booking
        JOIN venues venue ON venue.id=booking.venue_id LEFT JOIN venue_billing_settings finance ON finance.venue_id=venue.id
        LEFT JOIN organization_members member ON member.organization_id=venue.organization_id AND member.user_id=?
        WHERE booking.id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "member.role IN ('owner','admin') OR (venue.organization_id IS NULL AND venue.owner_user_id=?)"}) FOR UPDATE`,
      ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId]);
      const booking = bookings[0];
      if (!booking) { await connection.rollback(); return { error: 'FORBIDDEN' }; }
      if (booking.invoiceMode !== 'external') { await connection.rollback(); return { error: 'INVALID_MODE' }; }
      await connection.execute(`INSERT INTO booking_external_invoices
        (booking_id, external_invoice_number, external_invoice_date, amount, currency, due_date, external_invoice_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'issued') ON DUPLICATE KEY UPDATE external_invoice_number=VALUES(external_invoice_number),
        external_invoice_date=VALUES(external_invoice_date), amount=VALUES(amount), currency=VALUES(currency), due_date=VALUES(due_date),
        external_invoice_url=VALUES(external_invoice_url), status=IF(status='paid', status, 'issued')`,
      [bookingId, data.externalInvoiceNumber, data.externalInvoiceDate, data.amount ?? booking.totalAmount, data.currency || booking.currency, data.dueDate, data.externalInvoiceUrl]);
      await connection.execute("UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL WHERE id=?", [bookingId]);
      await connection.commit();
      await this.audit(userId, 'external_invoice_recorded', 'venue_booking', bookingId, { externalInvoiceNumber: data.externalInvoiceNumber });
      return this.externalInvoice(bookingId, userId, role);
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async markExternalInvoicePaid(bookingId, userId, role) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT external.id FROM booking_external_invoices external
        JOIN venue_bookings booking ON booking.id=external.booking_id JOIN venues venue ON venue.id=booking.venue_id
        LEFT JOIN organization_members member ON member.organization_id=venue.organization_id AND member.user_id=?
        WHERE external.booking_id=? AND external.status IN ('awaiting_invoice','issued')
        AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "member.role IN ('owner','admin') OR (venue.organization_id IS NULL AND venue.owner_user_id=?)"}) FOR UPDATE`,
      ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId]);
      if (!rows[0]) { await connection.rollback(); return false; }
      await connection.execute("UPDATE booking_external_invoices SET status='paid', marked_paid_at=NOW(), marked_paid_by_user_id=? WHERE id=?", [userId, rows[0].id]);
      await connection.execute("UPDATE venue_bookings SET payment_status='paid' WHERE id=?", [bookingId]);
      await connection.commit();
      await this.audit(userId, 'external_invoice_marked_paid', 'venue_booking', bookingId, { source: 'confirmed_by_venue' });
      return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async reviewVenueBooking(bookingId, userId, role, status, ownerNote = null) {
    let billingReadiness = null;
    if (status === 'confirmed') {
      billingReadiness = await this.getVenueBookingBillingReadiness(bookingId);
      if (!billingReadiness) return false;
      if (billingReadiness.isInvoiceRequired) {
        const context = await this.venueBookingFinancialContext(bookingId);
        if (!context || !await this.canManageVenueBilling(context.venueId, userId, role)) return { error: 'BILLING_PERMISSION_REQUIRED' };
      }
      if (!billingReadiness.priceReady) return { error: billingReadiness.priceError || 'PRICE_NOT_CONFIGURED' };
      if (!billingReadiness.buyerBillingProfileReady) return { error: 'BUYER_PROFILE_INCOMPLETE' };
      if (billingReadiness.isInvoiceRequired && billingReadiness.invoiceMode === 'ykcircle' && !billingReadiness.venue.canIssueInvoice) return { error: 'FINANCIAL_SETUP_INCOMPLETE', missing: billingReadiness.venue.missing };
    }
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT b.id, b.venue_id AS venueId, b.booking_type AS bookingType, b.booking_date AS bookingDate,
        b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
        LEFT JOIN organization_members member ON member.organization_id=v.organization_id AND member.user_id=?
        WHERE b.id=? AND b.status='requested' AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "v.owner_user_id=? OR member.role IN ('owner','admin','manager')"}) FOR UPDATE`,
      ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId]);
      const booking = rows[0];
      if (!booking) { await connection.rollback(); return false; }
      await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [booking.venueId]);
      if (status === 'confirmed') {
        const conflict = await this.checkBookingConflict({ venueId: booking.venueId, bookingType: booking.bookingType, bookingDate: booking.bookingDate, occupiedStartAt: booking.occupiedStartAt, occupiedEndAt: booking.occupiedEndAt, excludeBookingId: bookingId }, connection);
        if (conflict.conflict) { await connection.rollback(); return { error: 'CONFLICT' }; }
      }
      const confirmed = status === 'confirmed';
      await connection.execute(`UPDATE venue_bookings SET status=?, owner_note=?, venue_internal_note=?,
        confirmed_at=CASE WHEN ? THEN NOW() ELSE confirmed_at END, confirmed_by=CASE WHEN ? THEN ? ELSE confirmed_by END,
        invoice_generation_status=CASE WHEN ? THEN 'pending' ELSE invoice_generation_status END WHERE id=?`,
      [status, ownerNote, ownerNote, confirmed, confirmed, userId, confirmed, bookingId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    if (status !== 'confirmed') return { invoiceId: null };
    if (!billingReadiness?.isInvoiceRequired) return { invoiceId: null, invoiceMode: billingReadiness?.invoiceMode || null, paymentStatus: 'not_required' };
    try {
      return await this.ensureVenueBookingInvoice(bookingId, userId);
    } catch (error) {
      await this.database.execute("UPDATE venue_bookings SET invoice_generation_status='failed', invoice_generation_error=? WHERE id=?", [String(error.message || 'Invoice generation failed').slice(0, 500), bookingId]);
      return { invoiceId: null, invoiceGenerationStatus: 'failed', warning: 'INVOICE_GENERATION_FAILED' };
    }
  }
  async cancelVenueBooking(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(`UPDATE venue_bookings b JOIN events e ON e.id = b.event_id SET b.status = 'cancelled'
      WHERE b.event_id = ? AND b.status IN ('requested', 'confirmed')${privileged ? '' : ' AND e.manager_id = ?'}`, privileged ? [eventId] : [eventId, userId]);
    return result.affectedRows > 0;
  }
  async createPrivacyRequest(request) {
    const [result] = await this.database.execute('INSERT INTO privacy_requests (reference, user_id, name, email, category, message) VALUES (?, ?, ?, ?, ?, ?)', [request.reference, request.userId, request.name, request.email, request.category, request.message]);
    return result.insertId;
  }
  async createModerationDecision(decision) {
    const [result] = await this.database.execute(`INSERT INTO moderation_decisions
      (entity_type, entity_id, subject_user_id, action, reason_code, explanation_internal, explanation_user, automated_detection, decided_by_user_id, appeal_available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [decision.entityType, String(decision.entityId), decision.subjectUserId, decision.action, decision.reasonCode, decision.explanationInternal, decision.explanationUser, Boolean(decision.automatedDetection), decision.decidedByUserId, Boolean(decision.appealAvailable)]);
    return result.insertId;
  }
  async moderationDecision(id) { const [rows] = await this.database.execute('SELECT id, entity_type AS entityType, entity_id AS entityId, subject_user_id AS subjectUserId, action, reason_code AS reasonCode, explanation_user AS explanationUser, appeal_available AS appealAvailable, created_at AS createdAt FROM moderation_decisions WHERE id = ?', [id]); return rows[0] || null; }
  async createModerationAppeal(appeal) {
    const [result] = await this.database.execute('INSERT INTO moderation_appeals (moderation_decision_id, appellant_user_id, explanation) VALUES (?, ?, ?)', [appeal.decisionId, appeal.userId, appeal.explanation]);
    return result.insertId;
  }
  async resolveModerationAppeal(id, resolverUserId, status, outcome, outcomeReason) {
    const [result] = await this.database.execute("UPDATE moderation_appeals SET status = ?, resolved_at = NOW(), resolved_by_user_id = ?, outcome = ?, outcome_reason = ? WHERE id = ? AND status IN ('submitted', 'under_review')", [status, resolverUserId, outcome, outcomeReason, id]);
    return result.affectedRows > 0;
  }
  async configureRetentionPolicies(retention) {
    for (const [key, days] of Object.entries(retention)) await this.database.execute('INSERT INTO retention_policies (policy_key, retention_days) VALUES (?, ?) ON DUPLICATE KEY UPDATE retention_days = VALUES(retention_days)', [key, days]);
  }
  async applyRetentionPolicies(retention) {
    const [reset] = await this.database.execute('DELETE FROM password_reset_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [retention.passwordResetDays]);
    const [verification] = await this.database.execute('UPDATE users SET verification_token_hash = NULL, verification_expires_at = NULL WHERE verification_expires_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [retention.verificationTokenDays]);
    const [invitations] = await this.database.execute("DELETE FROM event_invitations WHERE token_expires_at < DATE_SUB(NOW(), INTERVAL ? DAY) AND status IN ('Pending', 'Declined')", [retention.invitationDays]);
    const [groupInvitations] = await this.database.execute("DELETE FROM group_invitations WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? DAY) AND status IN ('pending', 'declined', 'revoked')", [retention.invitationDays]);
    const result = { passwordResetTokens: reset.affectedRows, verificationTokens: verification.affectedRows, eventInvitations: invitations.affectedRows, groupInvitations: groupInvitations.affectedRows };
    await this.audit(null, 'retention_cleanup', 'retention', null, result);
    return result;
  }
  async dataExport(userId) {
    const [user] = await this.database.execute('SELECT id, name, email, phone, role, isEmailConfirmed, created_at AS createdAt FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
    if (!user[0]) return null;
    const [legalAcceptances] = await this.database.execute('SELECT document_type AS documentType, version, accepted_at AS acceptedAt FROM user_legal_acceptances WHERE user_id = ? ORDER BY accepted_at', [userId]);
    const [marketingPreferences] = await this.database.execute('SELECT marketing_opt_in AS marketingOptIn, policy_version AS policyVersion, source, changed_at AS changedAt FROM marketing_email_preferences WHERE LOWER(email) = LOWER(?)', [user[0].email]);
    const [registrations] = await this.database.execute('SELECT event_id AS eventId, status, payment_status AS paymentStatus, created_at AS createdAt FROM event_registrations WHERE user_id = ?', [userId]);
    const [memberships] = await this.database.execute('SELECT group_id AS groupId, role, status, joined_at AS joinedAt FROM group_memberships WHERE user_id = ?', [userId]);
    const [reports] = await this.database.execute('SELECT reference, entity_type AS entityType, entity_id AS entityId, reason_code AS reasonCode, description, status, created_at AS createdAt FROM content_reports WHERE reporter_user_id = ?', [userId]);
    const [groupForumMessages] = await this.database.execute('SELECT id, thread_id AS threadId, body, created_at AS createdAt FROM group_forum_messages WHERE author_user_id = ?', [userId]);
    const [eventForumMessages] = await this.database.execute('SELECT id, thread_id AS threadId, body, created_at AS createdAt FROM event_forum_messages WHERE author_user_id = ?', [userId]);
    return { generatedAt: new Date().toISOString(), user: user[0], legalAcceptances, marketingPreferences, eventRegistrations: registrations, groupMemberships: memberships, reports, forumMessages: { group: groupForumMessages, event: eventForumMessages } };
  }
  async users() { const [rows] = await this.database.execute('SELECT id, name, email, phone, role, isEmailConfirmed, created_at AS createdAt FROM users ORDER BY created_at DESC'); return rows; }
  async updateUserRole(id, role, actorRole = 'admin') { const allowed = actorRole === 'admin' ? "role IN ('customer', 'organizer', 'venue_owner', 'manager', 'admin')" : "role = 'customer'"; const targetRole = actorRole === 'admin' ? role : 'organizer'; const [result] = await this.database.execute(`UPDATE users SET role = ? WHERE id = ? AND ${allowed}`, [targetRole, id]); return result.affectedRows > 0; }
}
