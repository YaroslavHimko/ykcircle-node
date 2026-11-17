export class AccountsRepository {
  constructor({ database }) {
    this.database = database;
  }
  async findUserById(id) {
    const [rows] = await this.database.execute(
      'SELECT id, email, role, isEmailConfirmed, session_version AS sessionVersion FROM users WHERE id = ? AND deleted_at IS NULL',
      [id],
    );
    return rows[0];
  }

  async findUserByEmail(email) {
    const [rows] = await this.database.execute(
      'SELECT id, profile_picture AS profilePicture, name, email, password_hash, phone, role, isEmailConfirmed, session_version AS sessionVersion FROM users WHERE email = ? AND deleted_at IS NULL',
      [email],
    );
    return rows[0];
  }

  async emailExists(email) {
    const [rows] = await this.database.execute(
      'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL',
      [email],
    );
    return rows.length > 0;
  }

  async verifyEmail(tokenHash) {
    const [result] = await this.database.execute(
      'UPDATE users SET isEmailConfirmed = TRUE, verification_token_hash = NULL, verification_expires_at = NULL WHERE verification_token_hash = ? AND verification_expires_at > NOW()',
      [tokenHash],
    );
    return result.affectedRows > 0;
  }

  async refreshVerification(email, tokenHash) {
    const [rows] = await this.database.execute(
      'SELECT name, email, isEmailConfirmed, verification_resend_available_at AS availableAt FROM users WHERE email = ?',
      [email],
    );
    const user = rows[0];
    if (!user || user.isEmailConfirmed) return null;
    if (user.availableAt && new Date(user.availableAt).getTime() > Date.now())
      return {
        cooldownSeconds: Math.ceil((new Date(user.availableAt).getTime() - Date.now()) / 1000),
      };
    const [result] = await this.database.execute(
      'UPDATE users SET verification_token_hash = ?, verification_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR), verification_resend_available_at = DATE_ADD(NOW(), INTERVAL 30 SECOND) WHERE email = ? AND isEmailConfirmed = FALSE',
      [tokenHash, email],
    );
    return result.affectedRows ? { name: user.name, email: user.email } : null;
  }

  async createPasswordReset(email, tokenHash) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [users] = await connection.execute(
        'SELECT id, name, email FROM users WHERE email = ? FOR UPDATE',
        [email],
      );
      const user = users[0];
      if (!user) {
        await connection.commit();
        return null;
      }
      const [tokens] = await connection.execute(
        'SELECT resend_available_at AS availableAt FROM password_reset_tokens WHERE user_id = ? FOR UPDATE',
        [user.id],
      );
      if (tokens[0]?.availableAt && new Date(tokens[0].availableAt).getTime() > Date.now()) {
        await connection.commit();
        return { cooldown: true };
      }
      await connection.execute(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, resend_available_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), DATE_ADD(NOW(), INTERVAL 30 SECOND)) ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), expires_at = VALUES(expires_at), resend_available_at = VALUES(resend_available_at), created_at = CURRENT_TIMESTAMP',
        [user.id, tokenHash],
      );
      await connection.commit();
      return user;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async resetPassword(tokenHash, passwordHash) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [tokens] = await connection.execute(
        'SELECT user_id AS userId FROM password_reset_tokens WHERE token_hash = ? AND expires_at > NOW() FOR UPDATE',
        [tokenHash],
      );
      if (!tokens[0]) {
        await connection.commit();
        return false;
      }
      await connection.execute(
        'UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?',
        [passwordHash, tokens[0].userId],
      );
      await connection.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [
        tokens[0].userId,
      ]);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async profile(id) {
    const [rows] = await this.database.execute(
      'SELECT u.id, u.profile_picture AS profilePicture, u.name, u.email, u.phone, u.role, u.isEmailConfirmed, u.timezone_display_mode AS timezoneDisplayMode, u.preferred_timezone AS preferredTimezone, u.created_at AS createdAt, COALESCE((SELECT marketing_opt_in FROM marketing_email_preferences p WHERE LOWER(p.email) = LOWER(u.email)), FALSE) AS marketingConsent FROM users u WHERE u.id = ? AND u.deleted_at IS NULL',
      [id],
    );
    return rows[0];
  }

  async setMarketingEmailPreference(email, enabled, policyVersion = null, source = 'settings') {
    await this.database.execute(
      'INSERT INTO marketing_email_preferences (email, marketing_opt_in, policy_version, source) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE marketing_opt_in = VALUES(marketing_opt_in), policy_version = VALUES(policy_version), source = VALUES(source), changed_at = CURRENT_TIMESTAMP',
      [email.toLowerCase(), enabled, policyVersion, source],
    );
    return enabled;
  }

  async marketingEmailPreference(email) {
    const [rows] = await this.database.execute(
      'SELECT marketing_opt_in AS marketingOptIn FROM marketing_email_preferences WHERE LOWER(email) = LOWER(?)',
      [email],
    );
    return Boolean(rows[0]?.marketingOptIn);
  }

  async updateProfilePicture(id, profilePicture) {
    const [result] = await this.database.execute(
      'UPDATE users SET profile_picture = ? WHERE id = ?',
      [profilePicture, id],
    );
    return result.affectedRows > 0;
  }

  async updateTimezonePreference(id, timezoneDisplayMode, preferredTimezone) {
    const [result] = await this.database.execute(
      'UPDATE users SET timezone_display_mode=?, preferred_timezone=? WHERE id=? AND deleted_at IS NULL',
      [timezoneDisplayMode, preferredTimezone, id],
    );
    return result.affectedRows > 0;
  }

  async deleteUser(id) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        'SELECT id, email, name, profile_picture AS profilePicture FROM users WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
        [id],
      );
      const user = rows[0];
      if (!user) {
        await connection.rollback();
        return null;
      }
      const deletedEmail = `deleted-${user.id}-${Date.now()}@deleted.invalid`;
      await connection.execute(
        "UPDATE users SET name = 'Deleted user', email = ?, phone = NULL, profile_picture = NULL, password_hash = ?, isEmailConfirmed = FALSE, session_version = session_version + 1, deleted_at = NOW() WHERE id = ?",
        [deletedEmail, `deleted:${Date.now()}`, id],
      );
      await connection.execute(
        "UPDATE events SET deleted_at = NOW(), status = 'Archived' WHERE manager_id = ? AND deleted_at IS NULL",
        [id],
      );
      await connection.execute(
        "UPDATE event_groups SET visibility = 'Private', status = 'archived' WHERE organizer_id = ?",
        [id],
      );
      await connection.execute('UPDATE venues SET is_active = FALSE WHERE owner_user_id = ?', [id]);
      await connection.execute(
        "UPDATE articles SET status = 'removed', is_indexable = FALSE WHERE author_user_id = ?",
        [id],
      );
      for (const table of ['group_forum_messages', 'event_forum_messages']) {
        const authorColumn = 'author_user_id';
        await connection.execute(
          `UPDATE ${table} SET body = '[Deleted]' WHERE ${authorColumn} = ?`,
          [id],
        );
      }
      await connection.execute(
        "INSERT INTO account_deletion_jobs (user_id, requested_by_user_id, status, details, completed_at) VALUES (?, ?, 'completed', ?, NOW())",
        [id, id, JSON.stringify({ profilePicture: user.profilePicture, contentAnonymised: true })],
      );
      await connection.execute(
        "INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, 'account_deleted', 'user', ?, ?)",
        [id, String(id), JSON.stringify({ contentAnonymised: true })],
      );
      await connection.commit();
      return user;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createUser(data, sendVerification) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        'INSERT INTO users (profile_picture, name, email, password_hash, phone, role, isEmailConfirmed, verification_token_hash, verification_expires_at, verification_resend_available_at) VALUES (?, ?, ?, ?, ?, ?, FALSE, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), DATE_ADD(NOW(), INTERVAL 30 SECOND))',
        [
          data.profilePicture,
          data.name,
          data.email,
          data.passwordHash,
          data.phone,
          data.role || 'customer',
          data.tokenHash,
        ],
      );
      if (data.termsVersion)
        await connection.execute(
          "INSERT INTO user_legal_acceptances (user_id, document_type, version, source) VALUES (?, 'terms', ?, 'registration')",
          [result.insertId, data.termsVersion],
        );
      await connection.execute(
        "INSERT INTO marketing_email_preferences (email, marketing_opt_in, policy_version, source) VALUES (?, ?, ?, 'registration')",
        [data.email, Boolean(data.marketingConsent), data.marketingPolicyVersion || null],
      );
      await connection.execute(
        "INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, 'registration', 'user', ?, ?)",
        [
          result.insertId,
          String(result.insertId),
          JSON.stringify({
            termsVersion: data.termsVersion,
            marketingConsent: Boolean(data.marketingConsent),
          }),
        ],
      );
      await sendVerification();
      await connection.commit();
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async users() {
    const [rows] = await this.database.execute(
      'SELECT id, name, email, phone, role, isEmailConfirmed, created_at AS createdAt FROM users ORDER BY created_at DESC',
    );
    return rows;
  }

  async updateUserRole(id, role, actorRole = 'admin') {
    const allowed =
      actorRole === 'admin'
        ? "role IN ('customer', 'organizer', 'venue_owner', 'manager', 'admin')"
        : "role = 'customer'";
    const targetRole = actorRole === 'admin' ? role : 'organizer';
    const [result] = await this.database.execute(
      `UPDATE users SET role = ? WHERE id = ? AND ${allowed}`,
      [targetRole, id],
    );
    return result.affectedRows > 0;
  }
}
