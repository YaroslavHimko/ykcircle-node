import crypto from 'node:crypto';

export class Queries {
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
    await this.database.execute('UPDATE legal_document_versions SET is_current = FALSE WHERE document_type = ? AND version <> ?', [document.slug, document.version]);
    await this.database.execute(`INSERT INTO legal_document_versions (document_type, version, published_at, content_hash, requires_reacceptance, is_current)
      VALUES (?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE published_at = VALUES(published_at), content_hash = VALUES(content_hash), requires_reacceptance = VALUES(requires_reacceptance), is_current = TRUE`,
    [document.slug, document.version, document.lastUpdated ? new Date(document.lastUpdated) : new Date(), document.contentHash, document.slug === 'terms']);
  }
  async audit(actorUserId, eventType, entityType = null, entityId = null, metadata = null) {
    await this.database.execute('INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)', [actorUserId, eventType, entityType, entityId == null ? null : String(entityId), metadata]);
  }
  async publicEventParticipants(eventId) { const [rows] = await this.database.execute('SELECT p.id, p.user_id AS userId, COALESCE(u.name, p.participant_name) AS name, u.profile_picture AS profilePicture, p.joined_at AS joinedAt FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.joined_at DESC', [eventId]); return rows; }
  async eventParticipantStatus(eventId, userId) { const [rows] = await this.database.execute('SELECT status FROM event_participants WHERE event_id = ? AND user_id = ?', [eventId, userId]); return rows[0]?.status || null; }
  async publicEvents(userId = null) { const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.visibility, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, v.id AS venueId, v.name AS venueName, v.location AS venueLocation, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_groups g ON g.id = e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id AND vb.status = 'confirmed' LEFT JOIN venues v ON v.id = vb.venue_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE e.status = 'Published' AND e.visibility = 'Public' ORDER BY e.starts_at ASC, e.created_at DESC`, [userId]); return rows; }
  async eventsForViewer(userId = null, role = null, { categorySlug = null } = {}) { const privileged = ['manager', 'admin'].includes(role); const access = privileged ? 'TRUE' : `e.manager_id = ? OR (e.status = 'Published' AND e.visibility = 'Private' AND (r.id IS NOT NULL OR EXISTS (SELECT 1 FROM event_invitations i JOIN users invited ON LOWER(invited.email) = LOWER(i.email) WHERE i.event_id = e.id AND invited.id = ? AND i.status = 'Pending' AND i.token_expires_at > NOW())))`; const params = privileged ? [userId] : [userId, userId, userId]; const categoryFilter = categorySlug ? ' AND c.slug = ?' : ''; if (categorySlug) params.push(categorySlug); const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.visibility, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, v.id AS venueId, v.name AS venueName, v.location AS venueLocation, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_categories c ON c.id = e.category_id LEFT JOIN event_groups g ON g.id = e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id AND vb.status = 'confirmed' LEFT JOIN venues v ON v.id = vb.venue_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE e.deleted_at IS NULL AND ((e.status = 'Published' AND e.visibility = 'Public') OR (${access}))${categoryFilter} ORDER BY e.starts_at ASC, e.created_at DESC`, params); return rows; }
  async createVisibleEvent(data) { const [result] = await this.database.execute('INSERT INTO events (manager_id, title, description, location, starts_at, ends_at, capacity, participation_fee, visibility, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'Draft\')', [data.managerId, data.title, data.description, data.location, data.startsAt, data.endsAt, data.capacity, data.fee, data.visibility]); return result.insertId; }
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
  async profile(id) { const [rows] = await this.database.execute("SELECT u.id, u.profile_picture AS profilePicture, u.name, u.email, u.phone, u.role, u.isEmailConfirmed, u.created_at AS createdAt, COALESCE((SELECT marketing_opt_in FROM marketing_email_preferences p WHERE LOWER(p.email) = LOWER(u.email)), FALSE) AS marketingConsent FROM users u WHERE u.id = ? AND u.deleted_at IS NULL", [id]); return rows[0]; }
  async setMarketingEmailPreference(email, enabled, policyVersion = null, source = 'settings') {
    await this.database.execute('INSERT INTO marketing_email_preferences (email, marketing_opt_in, policy_version, source) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE marketing_opt_in = VALUES(marketing_opt_in), policy_version = VALUES(policy_version), source = VALUES(source), changed_at = CURRENT_TIMESTAMP', [email.toLowerCase(), enabled, policyVersion, source]);
    return enabled;
  }
  async marketingEmailPreference(email) { const [rows] = await this.database.execute('SELECT marketing_opt_in AS marketingOptIn FROM marketing_email_preferences WHERE LOWER(email) = LOWER(?)', [email]); return Boolean(rows[0]?.marketingOptIn); }
  async updateProfilePicture(id, profilePicture) { const [result] = await this.database.execute('UPDATE users SET profile_picture = ? WHERE id = ?', [profilePicture, id]); return result.affectedRows > 0; }
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

  async events(userId = null, includeUnpublished = false) { const statusFilter = includeUnpublished ? '' : " AND e.status = 'Published'"; const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.created_at AS createdAt, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, u.name AS managerName, r.id AS registrationId, r.status AS registrationStatus, r.payment_status AS registrationPaymentStatus, IF(r.id IS NULL, FALSE, TRUE) AS isRegistered FROM events e JOIN users u ON u.id = e.manager_id LEFT JOIN event_registrations r ON r.id = (SELECT MAX(r2.id) FROM event_registrations r2 WHERE r2.event_id = e.id AND r2.user_id = ?) WHERE 1 = 1${statusFilter} ORDER BY e.created_at DESC`, [userId]); return rows; }
  async event(id) { const [rows] = await this.database.execute('SELECT e.id, e.manager_id AS managerId, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.participation_fee AS fee, e.status, e.created_at AS createdAt, u.name AS managerName FROM events e JOIN users u ON u.id = e.manager_id WHERE e.id = ?', [id]); return rows[0]; }
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
  async managerEvents(managerId) { const [rows] = await this.database.execute('SELECT id, manager_id AS managerId, title, description, location, starts_at AS startsAt, ends_at AS endsAt, capacity, status, created_at AS createdAt FROM events WHERE manager_id = ? ORDER BY created_at DESC', [managerId]); return rows; }
  async softDeleteEvent(id, userId, role) { const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?'; const params = ['manager', 'admin'].includes(role) ? [id] : [id, userId]; const [result] = await this.database.execute(`UPDATE events SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL${scope}`, params); return result.affectedRows > 0; }
  async createEvent(data) { const [result] = await this.database.execute('INSERT INTO events (manager_id, title, description, location, starts_at, ends_at, capacity, status) VALUES (?, ?, ?, ?, ?, ?, ?, \'Draft\')', [data.managerId, data.title, data.description, data.location, data.startsAt, data.endsAt, data.capacity]); return result.insertId; }
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
    const [rows] = await this.database.execute(`SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, e.title, e.short_description AS shortDescription, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, e.visibility, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, e.created_at AS createdAt, manager.name AS managerName, (SELECT ROUND(AVG(rating), 2) FROM event_ratings WHERE event_id = e.id) AS ratingAverage, (SELECT COUNT(*) FROM event_ratings WHERE event_id = e.id) AS ratingCount
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
    const [rows] = await this.database.execute(`SELECT g.id FROM event_groups g LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active' WHERE g.cover_image = ? AND (${privileged ? 'TRUE' : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL"})`, privileged ? [userId, filename] : [userId, filename, userId]);
    return rows[0] || null;
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
    const [rows] = await this.database.execute(`SELECT u.id AS userId, u.name, u.email, g.id AS groupId, g.name AS groupName, e.id AS eventId, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt
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
    const [rows] = await this.database.execute("SELECT id FROM venues WHERE id = ? AND COALESCE(is_active, TRUE) = TRUE AND moderation_status = 'approved'", [id]);
    return Boolean(rows[0]);
  }
  richEventInsertValues(data, occurrenceNumber = 1) {
    const recurrence = data.recurrence || { frequency: 'none', interval: 1, count: 1 };
    const values = [data.managerId, data.title, data.shortDescription, data.description, data.coverImage, data.categoryId, data.typeId, data.country, data.city,
      data.location, data.address, data.latitude, data.longitude, data.locationType, data.locationVisibility, data.startsAt, data.endsAt,
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
    if (values.length !== 52) throw new Error(`Rich event parameter contract failed: expected 52 values, received ${values.length}.`);
    const [result] = await connection.query(`INSERT INTO events
      (manager_id, title, short_description, description, cover_image, category_id, type_id, country, city, location, address, latitude, longitude,
       location_type, location_visibility, starts_at, ends_at, timezone, capacity, minimum_attendees, registration_deadline, minimum_age,
       language_code, what_to_bring, meeting_instructions, cancellation_policy, pricing_type, participation_fee, currency,
       registration_type, external_registration_url, visibility, group_id, recurrence_frequency, recurrence_interval, recurrence_count, occurrence_number,
       venue_id, custom_address_line_1, custom_address_line_2, custom_postal_code, custom_locality, custom_municipality, custom_region,
       custom_country, custom_country_code, custom_latitude, custom_longitude, custom_google_place_id, custom_formatted_address, online_url, online_platform, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft')`, values);
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
  async createRichEventSeries(data) {
    const recurrence = data.recurrence || { frequency: 'none', interval: 1, count: 1 };
    const count = recurrence.frequency === 'none' ? 1 : recurrence.count;
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      if (count === 1) {
        const eventId = await this.insertRichEvent(connection, data, 1);
        await connection.commit();
        return { seriesId: null, eventIds: [eventId] };
      }
      if (!data.startsAt) throw new Error('Recurring events require a start date.');
      const startsAt = new Date(`${data.startsAt.replace(' ', 'T')}Z`);
      const endsAt = data.endsAt ? new Date(`${data.endsAt.replace(' ', 'T')}Z`) : null;
      const duration = endsAt ? endsAt.getTime() - startsAt.getTime() : null;
      const eventIds = [];
      let occurrenceStart = startsAt;
      for (let occurrenceNumber = 1; occurrenceNumber <= count; occurrenceNumber += 1) {
        const occurrence = { ...data, startsAt: occurrenceStart.toISOString().slice(0, 19).replace('T', ' '), endsAt: duration === null ? null : new Date(occurrenceStart.getTime() + duration).toISOString().slice(0, 19).replace('T', ' ') };
        eventIds.push(await this.insertRichEvent(connection, occurrence, occurrenceNumber));
        occurrenceStart = this.recurringDate(startsAt, recurrence.frequency, recurrence.interval * occurrenceNumber);
      }
      const seriesId = count > 1 ? eventIds[0] : null;
      if (seriesId) await connection.query(`UPDATE events SET series_id = ? WHERE id IN (${eventIds.map(() => '?').join(', ')})`, [seriesId, ...eventIds]);
      await connection.commit();
      return { seriesId, eventIds };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async createRichEvent(data) { return (await this.createRichEventSeries(data)).eventIds[0]; }
  async updateRichEvent(id, managerId, role, data) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?';
    const params = [data.title, data.shortDescription, data.description, data.coverImage, data.categoryId, data.typeId, data.country, data.city,
      data.location, data.address, data.latitude, data.longitude, data.locationType, data.locationVisibility, data.startsAt, data.endsAt,
      data.timezone, data.capacity, data.minimumAttendees, data.registrationDeadline, data.minimumAge, data.languageCode,
      data.whatToBring, data.meetingInstructions, data.cancellationPolicy, data.pricingType, data.fee, data.currency,
      data.registrationType, data.externalRegistrationUrl, data.visibility, data.venueId, data.customAddressLine1, data.customAddressLine2,
      data.customPostalCode, data.customLocality, data.customMunicipality, data.customRegion, data.customCountry, data.customCountryCode,
      data.customLatitude, data.customLongitude, data.customGooglePlaceId, data.customFormattedAddress, data.onlineUrl, data.onlinePlatform, id]
      .map((value) => value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : value);
    if (!['manager', 'admin'].includes(role)) params.push(managerId);
    const [result] = await this.database.query(`UPDATE events SET title=?, short_description=?, description=?, cover_image=?, category_id=?, type_id=?, country=?, city=?, location=?, address=?, latitude=?, longitude=?, location_type=?, location_visibility=?, starts_at=?, ends_at=?, timezone=?, capacity=?, minimum_attendees=?, registration_deadline=?, minimum_age=?, language_code=?, what_to_bring=?, meeting_instructions=?, cancellation_policy=?, pricing_type=?, participation_fee=?, currency=?, registration_type=?, external_registration_url=?, visibility=?, venue_id=?, custom_address_line_1=?, custom_address_line_2=?, custom_postal_code=?, custom_locality=?, custom_municipality=?, custom_region=?, custom_country=?, custom_country_code=?, custom_latitude=?, custom_longitude=?, custom_google_place_id=?, custom_formatted_address=?, online_url=?, online_platform=? WHERE id=? AND deleted_at IS NULL${scope}`, params);
    return result.affectedRows > 0;
  }
  async setEventCover(id, managerId, role, coverImage) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(`SELECT COALESCE(series_id, id) AS seriesId FROM events WHERE id = ? AND deleted_at IS NULL${globalAccess ? '' : ' AND manager_id = ?'}`, globalAccess ? [id] : [id, managerId]);
    if (!events[0]) return false;
    const [result] = await this.database.execute('UPDATE events SET cover_image = ? WHERE id = ? OR series_id = ?', [coverImage, events[0].seriesId, events[0].seriesId]);
    return result.affectedRows > 0;
  }
  async eventCover(filename) { const [rows] = await this.database.execute("SELECT id FROM events WHERE (BINARY cover_image = BINARY ? OR BINARY cover_image LIKE CONCAT(BINARY '%/', BINARY ?)) AND deleted_at IS NULL LIMIT 1", [filename, filename]); return rows[0] || null; }
  normalizeRichEventLocation(event, { publicView = false } = {}) {
    if (!event) return null;
    const normalized = { ...event };
    if (normalized.locationType === 'physical' || normalized.locationType === 'tba') normalized.locationType = 'custom';
    for (const key of ['latitude', 'longitude', 'customLatitude', 'customLongitude']) if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    const customLocation = {
      addressLine1: normalized.customAddressLine1 || normalized.address || null,
      addressLine2: normalized.customAddressLine2 || null,
      postalCode: normalized.customPostalCode || null,
      locality: normalized.customLocality || normalized.city || null,
      municipality: normalized.customMunicipality || null,
      region: normalized.customRegion || null,
      country: normalized.customCountry || normalized.country || null,
      countryCode: normalized.customCountryCode || null,
      latitude: normalized.customLatitude ?? normalized.latitude ?? null,
      longitude: normalized.customLongitude ?? normalized.longitude ?? null,
      googlePlaceId: normalized.customGooglePlaceId || null,
      formattedAddress: normalized.customFormattedAddress || normalized.location || normalized.address || null,
    };
    if (normalized.locationType === 'venue') {
      const venue = this.normalizeVenue({
        id: normalized.venueId, name: normalized.venueName, addressLine1: normalized.venueAddressLine1, addressLine2: normalized.venueAddressLine2,
        postalCode: normalized.venuePostalCode, city: normalized.venueCity, municipality: normalized.venueMunicipality, region: normalized.venueRegion,
        country: normalized.venueCountry, countryCode: normalized.venueCountryCode, latitude: normalized.venueLatitude, longitude: normalized.venueLongitude,
        googlePlaceId: normalized.venueGooglePlaceId, formattedAddress: normalized.venueFormattedAddress, locationVisibility: normalized.venueLocationVisibility,
      }, { publicView });
      normalized.venue = venue?.id ? { id: venue.id, name: venue.name, location: venue.location } : null;
      normalized.location = null;
    } else if (normalized.locationType === 'online') {
      normalized.venue = null;
      normalized.location = null;
      normalized.onlineUrl = publicView ? null : normalized.onlineUrl || null;
    } else {
      normalized.venue = null;
      normalized.location = customLocation;
    }
    // The legacy flat event fields are retained in storage only for backwards
    // compatibility. API consumers use one structured location source.
    for (const key of ['country', 'city', 'address', 'latitude', 'longitude']) delete normalized[key];
    for (const key of ['customAddressLine1', 'customAddressLine2', 'customPostalCode', 'customLocality', 'customMunicipality', 'customRegion', 'customCountry', 'customCountryCode', 'customLatitude', 'customLongitude', 'customGooglePlaceId', 'customFormattedAddress', 'venueId', 'venueName', 'venueBusinessName', 'venueLocation', 'venueAddressLine1', 'venueAddressLine2', 'venuePostalCode', 'venueCity', 'venueMunicipality', 'venueRegion', 'venueCountry', 'venueCountryCode', 'venueLatitude', 'venueLongitude', 'venueGooglePlaceId', 'venueFormattedAddress', 'venueLocationVisibility']) delete normalized[key];
    return normalized;
  }
  async richEvent(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.query(`SELECT e.id, e.manager_id AS managerId, e.title, e.short_description AS shortDescription, e.description, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl,
      e.category_id AS categoryId, c.name AS categoryName, e.type_id AS typeId, t.name AS typeName, e.country, e.city, e.location, e.address, e.latitude, e.longitude,
      e.location_type AS locationType, e.location_visibility AS locationVisibility, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone,
      e.capacity, e.minimum_attendees AS minimumAttendees, e.registration_deadline AS registrationDeadline, e.minimum_age AS minimumAge, e.language_code AS languageCode,
      e.what_to_bring AS whatToBring, e.meeting_instructions AS meetingInstructions, e.cancellation_policy AS cancellationPolicy,
      e.pricing_type AS pricingType, e.participation_fee AS fee, e.currency, e.registration_type AS registrationType, e.external_registration_url AS externalRegistrationUrl,
      e.visibility, e.status, e.published_at AS publishedAt, e.created_at AS createdAt, e.updated_at AS updatedAt, u.name AS managerName,
      e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber,
      e.venue_id AS venueId, e.custom_address_line_1 AS customAddressLine1, e.custom_address_line_2 AS customAddressLine2, e.custom_postal_code AS customPostalCode, e.custom_locality AS customLocality, e.custom_municipality AS customMunicipality, e.custom_region AS customRegion, e.custom_country AS customCountry, e.custom_country_code AS customCountryCode, e.custom_latitude AS customLatitude, e.custom_longitude AS customLongitude, e.custom_google_place_id AS customGooglePlaceId, e.custom_formatted_address AS customFormattedAddress, e.online_url AS onlineUrl, e.online_platform AS onlinePlatform,
      vb.id AS venueBookingId, vb.status AS venueBookingStatus, v.name AS venueName, v.business_name AS venueBusinessName, v.location AS venueLocation, v.address_line_1 AS venueAddressLine1, v.address_line_2 AS venueAddressLine2, v.postal_code AS venuePostalCode, v.city AS venueCity, v.municipality AS venueMunicipality, v.region AS venueRegion, v.country AS venueCountry, v.country_code AS venueCountryCode, v.latitude AS venueLatitude, v.longitude AS venueLongitude, v.google_place_id AS venueGooglePlaceId, v.formatted_address AS venueFormattedAddress, v.location_visibility AS venueLocationVisibility,
      (SELECT ROUND(AVG(rating), 2) FROM event_ratings WHERE event_id = e.id) AS ratingAverage, (SELECT COUNT(*) FROM event_ratings WHERE event_id = e.id) AS ratingCount,
      (SELECT rating FROM event_ratings WHERE event_id = e.id AND user_id = ?) AS myRating
      FROM events e JOIN users u ON u.id=e.manager_id LEFT JOIN event_categories c ON c.id=e.category_id LEFT JOIN event_types t ON t.id=e.type_id LEFT JOIN event_groups g ON g.id=e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id LEFT JOIN venues v ON v.id = e.venue_id
      WHERE e.id=? AND e.deleted_at IS NULL AND (${privileged ? 'TRUE' : "e.visibility = 'Public' AND e.status = 'Published'"}${userId && !privileged ? ' OR e.manager_id = ?' : ''})`, userId && !privileged ? [userId, id, userId] : [userId, id]);
    return this.normalizeRichEventLocation(rows[0], { publicView: !privileged && (!userId || rows[0]?.managerId !== userId) });
  }
  async publishRichEvent(id, managerId, role) { const privileged = ['manager', 'admin'].includes(role); const [events] = await this.database.execute(`SELECT COALESCE(series_id, id) AS seriesId FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? [id] : [id, managerId]); if (!events[0]) return false; const [result] = await this.database.execute('UPDATE events SET status = ?, published_at = COALESCE(published_at, NOW()) WHERE deleted_at IS NULL AND (id = ? OR series_id = ?)', ['Published', events[0].seriesId, events[0].seriesId]); return result.affectedRows > 0; }
  async updateEventStatus(id, userId, status, role) { const globalAccess = ['manager', 'admin'].includes(role); const ownership = globalAccess ? '' : ' AND manager_id = ?'; const params = globalAccess ? [status, id] : [status, id, userId]; const [result] = await this.database.execute(`UPDATE events SET status = ? WHERE id = ?${ownership}`, params); return result.affectedRows > 0; }
  async registrations(eventId, managerId, isAdmin = false) { await this.database.execute("UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.payment_status = CASE WHEN e.participation_fee > 0 THEN 'Payment Required' ELSE 'Not Required' END WHERE r.event_id = ? AND r.status <> 'Withdrawn' AND r.payment_status <> 'Paid'", [eventId]); const ownership = isAdmin ? '' : ' AND e.manager_id = ?'; const params = isAdmin ? [eventId] : [eventId, managerId]; const [rows] = await this.database.execute(`SELECT r.id, r.event_id AS eventId, r.user_id AS userId, r.status, r.payment_status AS paymentStatus, r.created_at AS createdAt, COALESCE(u.name, r.attendee_name) AS name, COALESCE(r.attendee_email, u.email) AS email, COALESCE(r.attendee_phone, u.phone) AS phone FROM event_registrations r JOIN events e ON e.id = r.event_id LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status <> 'Withdrawn'${ownership} ORDER BY r.created_at DESC`, params); return rows; }
  async userRegistrations(userId) { const [rows] = await this.database.execute('SELECT r.id, r.event_id AS eventId, r.status, r.created_at AS createdAt, e.title, e.location, e.starts_at AS startsAt FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE r.user_id = ? ORDER BY r.created_at DESC', [userId]); return rows; }
  async registration(id, managerId) { const [rows] = await this.database.execute("SELECT r.id, r.event_id AS eventId, r.user_id AS userId, r.status, COALESCE(r.attendee_email, u.email) AS email, COALESCE(u.name, r.attendee_name) AS name, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity FROM event_registrations r JOIN events e ON e.id = r.event_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status <> 'Withdrawn' AND e.manager_id = ?", [id, managerId]); return rows[0]; }
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
  async registerForEvent(eventId, userId, email) { const [event] = await this.database.execute('SELECT e.id, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity, e.status, manager.email AS managerEmail, manager.name AS managerName, (SELECT COUNT(*) FROM event_registrations WHERE event_id = ? AND status IN (\'Pending\', \'Confirmed\')) AS registered FROM events e JOIN users manager ON manager.id = e.manager_id WHERE e.id = ?', [eventId, eventId]); if (!event[0] || event[0].status !== 'Published') return { error: 'EVENT_UNAVAILABLE' }; const existing = await this.existingEventRegistration(eventId, userId, email); if (existing && !(existing.source === 'registration' && existing.status === 'Withdrawn')) return { error: 'ALREADY_REGISTERED' }; if (event[0].capacity !== null && event[0].registered >= event[0].capacity) return { error: 'EVENT_FULL' }; const normalizedEmail = String(email || '').trim().toLowerCase() || null; const id = existing ? existing.id : (await this.database.execute('INSERT INTO event_registrations (event_id, user_id, attendee_email, status) VALUES (?, ?, ?, \'Pending\')', [eventId, userId, normalizedEmail]))[0].insertId; if (existing) await this.database.execute("UPDATE event_registrations SET user_id = COALESCE(user_id, ?), attendee_email = ?, status = 'Pending', payment_status = CASE WHEN payment_status = 'Paid' THEN 'Paid' ELSE 'Payment Required' END WHERE id = ?", [userId, normalizedEmail, id]); await this.database.execute('DELETE i FROM event_invitations i JOIN users u ON LOWER(u.email) = LOWER(i.email) WHERE i.event_id = ? AND u.id = ? AND i.status = \'Pending\'', [eventId, userId]); return { id, ...event[0] }; }
  async updateRegistrationStatus(id, managerId, status, isAdmin = false) { const ownership = isAdmin ? '' : ' AND e.manager_id = ?'; const params = isAdmin ? [status, id] : [status, id, managerId]; const [result] = await this.database.execute(`UPDATE event_registrations r JOIN events e ON e.id = r.event_id SET r.status = ? WHERE r.id = ? AND r.status <> 'Withdrawn'${ownership}`, params); if (result.affectedRows && status === 'Confirmed') { const [registration] = await this.database.execute('SELECT r.event_id AS eventId, r.user_id AS userId, COALESCE(u.name, r.attendee_name) AS name, COALESCE(r.attendee_email, u.email) AS email, COALESCE(r.attendee_phone, u.phone) AS phone, r.payment_status AS paymentStatus FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?', [id]); if (registration[0] && registration[0].name) { await this.database.execute('INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, payment_status) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE participant_name = VALUES(participant_name), participant_email = VALUES(participant_email), participant_phone = VALUES(participant_phone), payment_status = VALUES(payment_status)', [registration[0].eventId, registration[0].userId, registration[0].name, registration[0].email, registration[0].phone, registration[0].paymentStatus]); await this.database.execute('DELETE FROM event_registrations WHERE id = ?', [id]); } } if (result.affectedRows && ['Cancelled', 'Declined', 'Withdrawn'].includes(status)) { const [registration] = await this.database.execute('SELECT event_id AS eventId, user_id AS userId, attendee_email AS email FROM event_registrations WHERE id = ?', [id]); if (registration[0]) await this.database.execute('DELETE FROM event_participants WHERE event_id = ? AND (user_id = ? OR (user_id IS NULL AND participant_email = ?))', [registration[0].eventId, registration[0].userId, registration[0].email]); } return result.affectedRows > 0; }
  async withdrawRegistration(id, userId) { const [result] = await this.database.execute('UPDATE event_registrations SET status = \'Withdrawn\' WHERE id = ? AND user_id = ? AND status NOT IN (\'Attended\', \'Withdrawn\')', [id, userId]); return result.affectedRows > 0; }
  async findActiveRegistrationForUser(eventId, userId) { const [rows] = await this.database.execute(`SELECT id, source FROM (SELECT r.id, 'registration' AS source FROM event_registrations r LEFT JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.status IN ('Pending', 'Confirmed') AND (r.user_id = ? OR (r.user_id IS NULL AND LOWER(r.attendee_email) = LOWER((SELECT email FROM users WHERE id = ?)))) UNION ALL SELECT p.id, 'participant' AS source FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ? AND p.status = 'Pending' AND (p.user_id = ? OR (p.user_id IS NULL AND LOWER(p.participant_email) = LOWER((SELECT email FROM users WHERE id = ?))))) active_records LIMIT 1`, [eventId, userId, userId, eventId, userId, userId]); return rows[0] || null; }
  async markRegistrationWithdrawn(registration) { if (registration.source === 'participant') { const [result] = await this.database.execute('DELETE FROM event_participants WHERE id = ?', [registration.id]); return result.affectedRows > 0; } const [result] = await this.database.execute("UPDATE event_registrations SET status = 'Withdrawn' WHERE id = ? AND status IN ('Pending', 'Confirmed')", [registration.id]); return result.affectedRows > 0; }
  async customerRegistration(id, userId) { const [rows] = await this.database.execute('SELECT r.id, u.email, u.name, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.capacity FROM event_registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id WHERE r.id = ? AND r.user_id = ?', [id, userId]); return rows[0]; }
  async createInvitation(eventId, managerId, name, email) { const [event] = await this.database.execute('SELECT id, title, description, location, starts_at AS startsAt, ends_at AS endsAt, timezone FROM events WHERE id = ? AND manager_id = ?', [eventId, managerId]); if (!event[0]) return { error: 'EVENT_NOT_FOUND' }; const token = crypto.randomBytes(32).toString('hex'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); try { await this.database.execute('INSERT INTO event_invitations (event_id, manager_id, name, email, token_hash, token_expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [eventId, managerId, name, email, tokenHash]); return { ...event[0], invitationToken: token }; } catch (error) { if (error.code === 'ER_DUP_ENTRY') return { error: 'ALREADY_INVITED' }; throw error; } }
  async resendInvitation(eventId, invitationId, managerId) { const [rows] = await this.database.execute('SELECT i.id AS invitationId, i.name, i.email, e.id, e.title, e.description, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone FROM event_invitations i JOIN events e ON e.id = i.event_id WHERE i.id = ? AND i.event_id = ? AND i.manager_id = ? AND i.status = \'Pending\'', [invitationId, eventId, managerId]); const invitation = rows[0]; if (!invitation) return null; const token = crypto.randomBytes(32).toString('hex'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); await this.database.execute('UPDATE event_invitations SET token_hash = ?, token_expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?', [tokenHash, invitation.invitationId]); return { ...invitation, invitationToken: token }; }
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
  communityPostColumns() { return `p.id, p.slug, p.city, p.city_slug AS citySlug, p.title, p.short_description AS shortDescription, p.body, p.location_name AS locationName, p.latitude, p.longitude, p.location_radius_km AS locationRadiusKm, p.attributes, p.external_event_name AS externalEventName, p.external_event_url AS externalEventUrl, p.external_event_at AS externalEventAt, p.visibility, IF(p.status = 'active' AND p.expires_at IS NOT NULL AND p.expires_at <= NOW(), 'expired', p.status) AS status, p.is_indexable AS isIndexable, p.expires_at AS expiresAt, p.created_at AS createdAt, p.updated_at AS updatedAt, p.author_user_id AS authorUserId, u.name AS authorName, u.profile_picture AS authorProfilePicture, pt.id AS postTypeId, pt.type_key AS postTypeKey, pt.name AS postTypeName, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, sc.id AS subcategoryId, sc.name AS subcategoryName, sc.slug AS subcategorySlug, g.id AS groupId, g.name AS groupName, g.slug AS groupSlug, p.event_id AS eventId, COUNT(DISTINCT r.id) AS responseCount`; }
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
      return { ...post, eventIds, eventId: eventIds[0] ?? null };
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
      await connection.execute('UPDATE community_posts SET event_id = ? WHERE id = ?', [eventIds[0] ?? null, postId]);
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
    return `${prefix}.id, ${prefix}.organization_id AS organizationId, ${prefix}.owner_user_id AS ownerUserId, ${prefix}.name, ${prefix}.slug, ${prefix}.business_name AS businessName, ${prefix}.short_description AS shortDescription, ${prefix}.description, ${prefix}.location, ${prefix}.address_line_1 AS addressLine1, ${prefix}.address_line_2 AS addressLine2, ${prefix}.postal_code AS postalCode, ${prefix}.country, ${prefix}.country_code AS countryCode, ${prefix}.city, ${prefix}.municipality, ${prefix}.region, ${prefix}.address, ${prefix}.latitude, ${prefix}.longitude, ${prefix}.google_place_id AS googlePlaceId, ${prefix}.formatted_address AS formattedAddress, ${prefix}.location_visibility AS locationVisibility, ${prefix}.timezone, ${prefix}.capacity_min AS capacityMin, ${prefix}.capacity_max AS capacityMax, ${prefix}.standing_capacity AS standingCapacity, ${prefix}.seated_capacity AS seatedCapacity, ${prefix}.dining_capacity AS diningCapacity, ${prefix}.classroom_capacity AS classroomCapacity, ${prefix}.size_sqm AS sizeSqm, ${prefix}.price_from AS priceFrom, ${prefix}.price_unit AS priceUnit, ${prefix}.currency, ${prefix}.pricing_description AS pricingDescription, ${prefix}.minimum_booking_hours AS minimumBookingHours, ${prefix}.website_url AS websiteUrl, ${prefix}.phone, ${prefix}.contact_email AS contactEmail, ${prefix}.availability_type AS availabilityType, ${prefix}.house_rules_text AS houseRulesText, ${prefix}.is_active AS isActive, ${prefix}.is_verified AS isVerified, ${prefix}.is_featured AS isFeatured, ${prefix}.verification_status AS verificationStatus, ${prefix}.moderation_status AS moderationStatus, ${prefix}.published_at AS publishedAt, ${prefix}.created_at AS createdAt, ${prefix}.updated_at AS updatedAt, (SELECT vm.filename FROM venue_media vm WHERE vm.venue_id = ${prefix}.id AND vm.is_cover = TRUE ORDER BY vm.sort_order, vm.id LIMIT 1) AS coverImage`;
  }
  normalizeVenue(venue, { publicView = false } = {}) {
    if (!venue) return null;
    const normalized = { ...venue, isActive: Boolean(venue.isActive), isVerified: Boolean(venue.isVerified), isFeatured: Boolean(venue.isFeatured), sponsored: Boolean(venue.sponsored) };
    for (const key of ['latitude', 'longitude', 'sizeSqm', 'priceFrom', 'minimumBookingHours']) if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    for (const key of ['capacityMin', 'capacityMax', 'standingCapacity', 'seatedCapacity', 'diningCapacity', 'classroomCapacity']) if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    if (normalized.locationVisibility === 'private_until_booking') normalized.locationVisibility = 'private';
    normalized.location = {
      visibility: normalized.locationVisibility,
      addressLine1: normalized.addressLine1 || null, addressLine2: normalized.addressLine2 || null, postalCode: normalized.postalCode || null,
      locality: normalized.city || null, municipality: normalized.municipality || null, region: normalized.region || null,
      country: normalized.country || null, countryCode: normalized.countryCode || null, latitude: normalized.latitude ?? null, longitude: normalized.longitude ?? null,
      googlePlaceId: normalized.googlePlaceId || null, formattedAddress: normalized.formattedAddress || normalized.address || null,
    };
    normalized.capacity = { min: normalized.capacityMin ?? null, max: normalized.capacityMax ?? null, standing: normalized.standingCapacity ?? null, seated: normalized.seatedCapacity ?? null, dining: normalized.diningCapacity ?? null, classroom: normalized.classroomCapacity ?? null };
    normalized.pricing = { from: normalized.priceFrom ?? null, unit: normalized.priceUnit, currency: normalized.currency, description: normalized.pricingDescription || null };
    if (publicView && normalized.locationVisibility !== 'exact') {
      normalized.addressLine1 = null; normalized.addressLine2 = null; normalized.address = null; normalized.postalCode = null; normalized.formattedAddress = null; normalized.googlePlaceId = null;
      normalized.location.addressLine1 = null; normalized.location.addressLine2 = null; normalized.location.postalCode = null; normalized.location.formattedAddress = null; normalized.location.googlePlaceId = null;
      if (normalized.locationVisibility === 'private') { normalized.latitude = null; normalized.longitude = null; normalized.location.latitude = null; normalized.location.longitude = null; }
    }
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
  async setOrganizationMember(organizationId, actorUserId, actorRole, userId, membershipRole) {
    if (!['manager', 'admin'].includes(actorRole)) {
      const actor = await this.organizationMember(organizationId, actorUserId);
      if (!actor || !['owner', 'admin'].includes(actor.role)) return false;
    }
    const [result] = await this.database.execute('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [organizationId, userId, membershipRole]);
    return result.affectedRows > 0;
  }
  async canManageVenue(id, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(`SELECT v.id FROM venues v LEFT JOIN organization_members om ON om.organization_id = v.organization_id AND om.user_id = ? WHERE v.id = ? AND (v.owner_user_id = ? OR om.role IN ('owner','admin','manager'))`, [userId, id, userId]);
    return Boolean(rows[0]);
  }
  async venueAvailability(venueId) {
    const [rows] = await this.database.execute('SELECT id, venue_id AS venueId, weekday, TIME_FORMAT(start_time, \'%H:%i\') AS startTime, TIME_FORMAT(end_time, \'%H:%i\') AS endTime FROM venue_availability WHERE venue_id = ? ORDER BY weekday, start_time', [venueId]);
    return rows;
  }
  async venueAvailabilityForDate(venueId, date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const [venues] = await this.database.execute("SELECT id, timezone FROM venues WHERE id = ? AND is_active = TRUE AND moderation_status = 'approved'", [venueId]);
    if (!venues[0]) return null;
    const [slots] = await this.database.execute('SELECT TIME_FORMAT(start_time, \'%H:%i\') AS startTime, TIME_FORMAT(end_time, \'%H:%i\') AS endTime FROM venue_availability WHERE venue_id = ? AND weekday = ? ORDER BY start_time', [venueId, weekday]);
    return { venueId, date, timezone: venues[0].timezone, slots };
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
    // next edited or migrated.
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
    const [result] = await this.database.execute(`INSERT INTO venues (organization_id, owner_user_id, name, slug, business_name, short_description, description, location, address_line_1, address_line_2, postal_code, country, country_code, city, municipality, region, address, latitude, longitude, google_place_id, formatted_address, location_visibility, timezone, venue_type_id, capacity_min, capacity_max, standing_capacity, seated_capacity, dining_capacity, classroom_capacity, size_sqm, price_from, price_unit, currency, pricing_description, minimum_booking_hours, website_url, phone, contact_email, availability_type, house_rules_text, is_active, moderation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM venue_types WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`, [data.organizationId, ownerUserId, data.name, data.slug, data.businessName, data.shortDescription, data.description, data.location, data.addressLine1, data.addressLine2, data.postalCode, data.country, data.countryCode, data.city, data.municipality, data.region, data.address, data.latitude, data.longitude, data.googlePlaceId, data.formattedAddress, data.locationVisibility, data.timezone, data.venueType, data.capacityMin, data.capacityMax, data.standingCapacity, data.seatedCapacity, data.diningCapacity, data.classroomCapacity, data.sizeSqm, data.priceFrom, data.priceUnit, data.currency, data.pricingDescription, data.minimumBookingHours, data.websiteUrl, data.phone, data.contactEmail, data.availabilityType, data.houseRulesText, data.isActive]);
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
    const [result] = await this.database.execute('UPDATE venues SET name=?, slug=?, business_name=?, short_description=?, description=?, location=?, address_line_1=?, address_line_2=?, postal_code=?, country=?, country_code=?, city=?, municipality=?, region=?, address=?, latitude=?, longitude=?, google_place_id=?, formatted_address=?, location_visibility=?, timezone=?, venue_type_id=(SELECT id FROM venue_types WHERE slug=?), capacity_min=?, capacity_max=?, standing_capacity=?, seated_capacity=?, dining_capacity=?, classroom_capacity=?, size_sqm=?, price_from=?, price_unit=?, currency=?, pricing_description=?, minimum_booking_hours=?, website_url=?, phone=?, contact_email=?, availability_type=?, house_rules_text=?, is_active=? WHERE id=?', [data.name, data.slug, data.businessName, data.shortDescription, data.description, data.location, data.addressLine1, data.addressLine2, data.postalCode, data.country, data.countryCode, data.city, data.municipality, data.region, data.address, data.latitude, data.longitude, data.googlePlaceId, data.formattedAddress, data.locationVisibility, data.timezone, data.venueType, data.capacityMin, data.capacityMax, data.standingCapacity, data.seatedCapacity, data.diningCapacity, data.classroomCapacity, data.sizeSqm, data.priceFrom, data.priceUnit, data.currency, data.pricingDescription, data.minimumBookingHours, data.websiteUrl, data.phone, data.contactEmail, data.availabilityType, data.houseRulesText, data.isActive, id]);
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
    // Each branch compares like with like. COALESCE(?, verification_status)
    // would blend the parameter's connection collation with the column's,
    // leaving no winner against a literal ("Illegal mix of collations").
    // Both branches read the same value whichever order MySQL evaluates the
    // assignments in: an omitted status leaves the column unchanged.
    const [result] = await this.database.execute(`UPDATE venues SET moderation_status = ?, verification_status = COALESCE(?, verification_status), is_verified = CASE WHEN ? IS NULL THEN verification_status = 'verified' ELSE ? = 'verified' END, is_active = COALESCE(?, is_active), published_at = CASE WHEN ? = 'approved' AND published_at IS NULL THEN NOW() ELSE published_at END WHERE id = ?`, [moderationStatus, verificationStatus, verificationStatus, verificationStatus, isActive, moderationStatus, venueId]);
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
    await executor.execute('DELETE FROM venue_availability WHERE venue_id = ?', [venueId]);
    for (const slot of slots) await executor.execute('INSERT INTO venue_availability (venue_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)', [venueId, slot.weekday, slot.startTime, slot.endTime]);
  }
  async venueBookingContext(eventId, venueId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(`SELECT id, manager_id AS managerId, starts_at AS startsAt, ends_at AS endsAt, timezone FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`, privileged ? [eventId] : [eventId, userId]);
    if (!events[0]) return { error: 'EVENT_NOT_FOUND' };
    const [venues] = await this.database.execute('SELECT id, owner_user_id AS ownerUserId, name, timezone, is_active AS isActive FROM venues WHERE id = ?', [venueId]);
    if (!venues[0] || !venues[0].isActive) return { error: 'VENUE_NOT_FOUND' };
    return { event: events[0], venue: { ...venues[0], availability: await this.venueAvailability(venueId) } };
  }
  async requestVenueBooking(eventId, venueId, organizerUserId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [events] = await connection.execute('SELECT starts_at AS startsAt, ends_at AS endsAt FROM events WHERE id = ? AND manager_id = ? AND deleted_at IS NULL FOR UPDATE', [eventId, organizerUserId]);
      const event = events[0];
      if (!event) { await connection.rollback(); return { error: 'EVENT_NOT_FOUND' }; }
      const [venues] = await connection.execute('SELECT id FROM venues WHERE id = ? AND is_active = TRUE FOR UPDATE', [venueId]);
      if (!venues[0]) { await connection.rollback(); return { error: 'VENUE_NOT_FOUND' }; }
      const [existing] = await connection.execute('SELECT id, status FROM venue_bookings WHERE event_id = ? FOR UPDATE', [eventId]);
      if (existing[0] && ['pending', 'confirmed'].includes(existing[0].status)) { await connection.rollback(); return { error: 'EVENT_ALREADY_BOOKED' }; }
      const [conflicts] = await connection.execute(`SELECT b.id FROM venue_bookings b JOIN events e ON e.id = b.event_id
        WHERE b.venue_id = ? AND b.status IN ('pending', 'confirmed') AND e.deleted_at IS NULL AND e.starts_at < ? AND COALESCE(e.ends_at, e.starts_at) > ? FOR UPDATE`, [venueId, event.endsAt, event.startsAt]);
      if (conflicts[0]) { await connection.rollback(); return { error: 'VENUE_UNAVAILABLE' }; }
      let bookingId;
      if (existing[0]) {
        await connection.execute("UPDATE venue_bookings SET venue_id = ?, organizer_user_id = ?, status = 'pending', owner_note = NULL WHERE id = ?", [venueId, organizerUserId, existing[0].id]);
        bookingId = existing[0].id;
      } else {
        const [result] = await connection.execute("INSERT INTO venue_bookings (venue_id, event_id, organizer_user_id, status) VALUES (?, ?, ?, 'pending')", [venueId, eventId, organizerUserId]);
        bookingId = result.insertId;
      }
      await connection.commit();
      return { id: bookingId, status: 'pending' };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async eventVenueBooking(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId, b.status, b.owner_note AS ownerNote, b.created_at AS createdAt, b.updated_at AS updatedAt,
      v.name AS venueName, v.location AS venueLocation, v.owner_user_id AS venueOwnerUserId
      FROM venue_bookings b JOIN venues v ON v.id = b.venue_id JOIN events e ON e.id = b.event_id
      WHERE b.event_id = ? AND (${privileged ? 'TRUE' : 'e.manager_id = ? OR v.owner_user_id = ?'})`, privileged ? [eventId] : [eventId, userId, userId]);
    return rows[0] || null;
  }
  async venueBookings(venueId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(`SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId, b.status, b.owner_note AS ownerNote, b.created_at AS createdAt, b.updated_at AS updatedAt,
      e.title AS eventTitle, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone AS eventTimezone, organizer.name AS organizerName
      FROM venue_bookings b JOIN venues v ON v.id = b.venue_id JOIN events e ON e.id = b.event_id JOIN users organizer ON organizer.id = b.organizer_user_id
      WHERE b.venue_id = ?${privileged ? '' : ' AND v.owner_user_id = ?'} ORDER BY e.starts_at ASC`, privileged ? [venueId] : [venueId, userId]);
    return rows;
  }
  async reviewVenueBooking(bookingId, userId, role, status, ownerNote = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(`UPDATE venue_bookings b JOIN venues v ON v.id = b.venue_id SET b.status = ?, b.owner_note = ?
      WHERE b.id = ? AND b.status = 'pending'${privileged ? '' : ' AND v.owner_user_id = ?'}`, privileged ? [status, ownerNote, bookingId] : [status, ownerNote, bookingId, userId]);
    return result.affectedRows > 0;
  }
  async cancelVenueBooking(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(`UPDATE venue_bookings b JOIN events e ON e.id = b.event_id SET b.status = 'cancelled'
      WHERE b.event_id = ? AND b.status IN ('pending', 'confirmed')${privileged ? '' : ' AND e.manager_id = ?'}`, privileged ? [eventId] : [eventId, userId]);
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
