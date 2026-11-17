export class ModerationRepository {
  constructor({ database }) {
    this.database = database;
  }
  async createPrivacyRequest(request) {
    const [result] = await this.database.execute(
      'INSERT INTO privacy_requests (reference, user_id, name, email, category, message) VALUES (?, ?, ?, ?, ?, ?)',
      [
        request.reference,
        request.userId,
        request.name,
        request.email,
        request.category,
        request.message,
      ],
    );
    return result.insertId;
  }

  async contactMessages() {
    const [rows] = await this.database.execute(
      'SELECT id, reference, name, email, category, message, status, created_at AS createdAt FROM privacy_requests ORDER BY created_at DESC, id DESC',
    );
    return rows;
  }

  async createModerationDecision(decision) {
    const [result] = await this.database.execute(
      `INSERT INTO moderation_decisions
      (entity_type, entity_id, subject_user_id, action, reason_code, explanation_internal, explanation_user, automated_detection, decided_by_user_id, appeal_available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        decision.entityType,
        String(decision.entityId),
        decision.subjectUserId,
        decision.action,
        decision.reasonCode,
        decision.explanationInternal,
        decision.explanationUser,
        Boolean(decision.automatedDetection),
        decision.decidedByUserId,
        Boolean(decision.appealAvailable),
      ],
    );
    return result.insertId;
  }

  async moderationDecision(id) {
    const [rows] = await this.database.execute(
      'SELECT id, entity_type AS entityType, entity_id AS entityId, subject_user_id AS subjectUserId, action, reason_code AS reasonCode, explanation_user AS explanationUser, appeal_available AS appealAvailable, created_at AS createdAt FROM moderation_decisions WHERE id = ?',
      [id],
    );
    return rows[0] || null;
  }

  async createModerationAppeal(appeal) {
    const [result] = await this.database.execute(
      'INSERT INTO moderation_appeals (moderation_decision_id, appellant_user_id, explanation) VALUES (?, ?, ?)',
      [appeal.decisionId, appeal.userId, appeal.explanation],
    );
    return result.insertId;
  }

  async resolveModerationAppeal(id, resolverUserId, status, outcome, outcomeReason) {
    const [result] = await this.database.execute(
      "UPDATE moderation_appeals SET status = ?, resolved_at = NOW(), resolved_by_user_id = ?, outcome = ?, outcome_reason = ? WHERE id = ? AND status IN ('submitted', 'under_review')",
      [status, resolverUserId, outcome, outcomeReason, id],
    );
    return result.affectedRows > 0;
  }
}
