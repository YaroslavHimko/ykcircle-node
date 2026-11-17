import { emailPreferences } from '../accounts/email-preferences.repository.js';
import { foodSelections } from '../../../utils/serialization.js';
export class PrivacyRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async configureRetentionPolicies(retention) {
    for (const [key, days] of Object.entries(retention))
      await this.database.execute(
        'INSERT INTO retention_policies (policy_key, retention_days) VALUES (?, ?) ON DUPLICATE KEY UPDATE retention_days = VALUES(retention_days)',
        [key, days],
      );
  }

  async applyRetentionPolicies(retention) {
    const [reset] = await this.database.execute(
      'DELETE FROM password_reset_tokens WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [retention.passwordResetDays],
    );
    const [verification] = await this.database.execute(
      'UPDATE users SET verification_token_hash = NULL, verification_expires_at = NULL WHERE verification_expires_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [retention.verificationTokenDays],
    );
    const [invitations] = await this.database.execute(
      "DELETE FROM event_invitations WHERE token_expires_at < DATE_SUB(NOW(), INTERVAL ? DAY) AND status IN ('Pending', 'Declined')",
      [retention.invitationDays],
    );
    const [groupInvitations] = await this.database.execute(
      "DELETE FROM group_invitations WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? DAY) AND status IN ('pending', 'declined', 'revoked')",
      [retention.invitationDays],
    );
    const result = {
      passwordResetTokens: reset.affectedRows,
      verificationTokens: verification.affectedRows,
      eventInvitations: invitations.affectedRows,
      groupInvitations: groupInvitations.affectedRows,
    };
    await this.queries.audit(null, 'retention_cleanup', 'retention', null, result);
    return result;
  }

  async dataExport(userId) {
    const [user] = await this.database.execute(
      'SELECT id, name, email, phone, role, isEmailConfirmed, created_at AS createdAt FROM users WHERE id = ? AND deleted_at IS NULL',
      [userId],
    );
    if (!user[0]) return null;
    const [legalAcceptances] = await this.database.execute(
      'SELECT document_type AS documentType, version, accepted_at AS acceptedAt FROM user_legal_acceptances WHERE user_id = ? ORDER BY accepted_at',
      [userId],
    );
    const [marketingPreferences] = await this.database.execute(
      'SELECT marketing_opt_in AS marketingOptIn, policy_version AS policyVersion, source, changed_at AS changedAt FROM marketing_email_preferences WHERE LOWER(email) = LOWER(?)',
      [user[0].email],
    );
    const [registrations] = await this.database.execute(
      'SELECT event_id AS eventId, status, selected_food_options AS selectedFoodOptions, payment_status AS paymentStatus, created_at AS createdAt FROM event_registrations WHERE user_id = ?',
      [userId],
    );
    const [participants] = await this.database.execute(
      'SELECT event_id AS eventId, status, selected_food_options AS selectedFoodOptions, joined_at AS joinedAt FROM event_participants WHERE user_id = ?',
      [userId],
    );
    const [memberships] = await this.database.execute(
      'SELECT group_id AS groupId, role, status, joined_at AS joinedAt FROM group_memberships WHERE user_id = ?',
      [userId],
    );
    const [reports] = await this.database.execute(
      'SELECT reference, entity_type AS entityType, entity_id AS entityId, reason_code AS reasonCode, description, status, created_at AS createdAt FROM content_reports WHERE reporter_user_id = ?',
      [userId],
    );
    const [groupForumMessages] = await this.database.execute(
      'SELECT id, thread_id AS threadId, body, created_at AS createdAt FROM group_forum_messages WHERE author_user_id = ?',
      [userId],
    );
    const [eventForumMessages] = await this.database.execute(
      'SELECT id, thread_id AS threadId, body, created_at AS createdAt FROM event_forum_messages WHERE author_user_id = ?',
      [userId],
    );
    return {
      generatedAt: new Date().toISOString(),
      user: user[0],
      legalAcceptances,
      marketingPreferences,
      emailPreferences: await emailPreferences(this.database, userId),
      eventRegistrations: registrations.map((row) => ({
        ...row,
        selectedFoodOptions: foodSelections(row.selectedFoodOptions),
      })),
      eventParticipation: participants.map((row) => ({
        ...row,
        selectedFoodOptions: foodSelections(row.selectedFoodOptions),
      })),
      groupMemberships: memberships,
      reports,
      forumMessages: { group: groupForumMessages, event: eventForumMessages },
    };
  }
}
