export class EventsFollowupsRepository {
  constructor({ database }) {
    this.database = database;
  }
  async managedFollowupEvent(id, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT e.id, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.status, e.starts_at AS startsAt, e.ends_at AS endsAt, e.manager_id AS managerId, u.name AS managerName FROM events e JOIN users u ON u.id = e.manager_id WHERE e.id = ? AND e.deleted_at IS NULL${privileged ? '' : ' AND e.manager_id = ?'}`,
      privileged ? [id] : [id, userId],
    );
    return rows[0] || null;
  }

  async eventFollowupOverview(eventId) {
    const [attendance] = await this.database.execute(
      `SELECT
      SUM(p.status = 'Attended') AS attended,
      SUM(p.status = 'No Show') AS noShow,
      SUM(p.status = 'Pending') AS unmarked,
      SUM(p.status = 'Attended' AND COALESCE(NULLIF(TRIM(p.participant_email), ''), u.email) IS NOT NULL) AS attendedWithEmail,
      SUM(p.status = 'No Show' AND COALESCE(NULLIF(TRIM(p.participant_email), ''), u.email) IS NOT NULL) AS noShowWithEmail
      FROM event_participants p LEFT JOIN users u ON u.id = p.user_id WHERE p.event_id = ?`,
      [eventId],
    );
    const [templates] = await this.database.execute(
      'SELECT audience, subject, body FROM event_followup_templates WHERE event_id = ?',
      [eventId],
    );
    const [deliveries] = await this.database.execute(
      'SELECT audience, status, COUNT(*) AS total FROM event_followup_deliveries WHERE event_id = ? GROUP BY audience, status',
      [eventId],
    );
    return {
      attendance: Object.fromEntries(
        Object.entries(attendance[0] || {}).map(([key, value]) => [key, Number(value || 0)]),
      ),
      templates: Object.fromEntries(
        templates.map(({ audience, subject, body }) => [audience, { subject, body }]),
      ),
      deliveries: deliveries.reduce((result, item) => {
        result[item.audience] ||= {};
        result[item.audience][item.status] = Number(item.total);
        return result;
      }, {}),
    };
  }

  async saveEventFollowupTemplate(eventId, audience, subject, body) {
    const [locked] = await this.database.execute(
      'SELECT id FROM event_followup_deliveries WHERE event_id = ? AND audience = ? LIMIT 1',
      [eventId, audience],
    );
    if (locked.length) return false;
    await this.database.execute(
      'INSERT INTO event_followup_templates (event_id, audience, subject, body) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)',
      [eventId, audience, subject, body],
    );
    return true;
  }

  async queueEventFollowup(eventId, audience) {
    const participantStatus = audience === 'attended' ? 'Attended' : 'No Show';
    await this.database.execute(
      `INSERT IGNORE INTO event_followup_deliveries (event_id, participant_id, audience, recipient_email, recipient_name)
      SELECT p.event_id, p.id, ?, COALESCE(NULLIF(TRIM(p.participant_email), ''), u.email), COALESCE(NULLIF(TRIM(p.participant_name), ''), u.name, 'Guest')
      FROM event_participants p JOIN events e ON e.id = p.event_id LEFT JOIN users u ON u.id = p.user_id
      WHERE p.event_id = ? AND e.status = 'Completed' AND p.status = ? AND COALESCE(NULLIF(TRIM(p.participant_email), ''), u.email) IS NOT NULL`,
      [audience, eventId, participantStatus],
    );
    const [rows] = await this.database.execute(
      `SELECT d.id, d.recipient_email AS email, d.recipient_name AS name FROM event_followup_deliveries d
      JOIN event_participants p ON p.id = d.participant_id WHERE d.event_id = ? AND d.audience = ? AND d.status IN ('pending','failed') AND p.status = ? ORDER BY d.id LIMIT 25`,
      [eventId, audience, participantStatus],
    );
    return rows;
  }

  async claimEventFollowupDelivery(id) {
    const [result] = await this.database.execute(
      "UPDATE event_followup_deliveries SET status = 'sending', error_message = NULL WHERE id = ? AND status IN ('pending','failed')",
      [id],
    );
    return result.affectedRows > 0;
  }

  async finishEventFollowupDelivery(id, error = null) {
    await this.database.execute(
      "UPDATE event_followup_deliveries SET status = ?, sent_at = CASE WHEN ? IS NULL THEN UTC_TIMESTAMP() ELSE NULL END, error_message = ? WHERE id = ? AND status = 'sending'",
      [error ? 'failed' : 'sent', error, error ? String(error).slice(0, 500) : null, id],
    );
  }
}
