export async function initializeComplianceSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS legal_document_versions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        document_type VARCHAR(64) NOT NULL,
        version VARCHAR(64) NOT NULL,
        published_at DATETIME NOT NULL,
        content_hash CHAR(64) NOT NULL,
        requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
        is_current BOOLEAN NOT NULL DEFAULT TRUE,
        UNIQUE KEY legal_document_version (document_type, version),
        INDEX legal_document_current (document_type, is_current)
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS user_legal_acceptances (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL,
        document_type VARCHAR(64) NOT NULL,
        version VARCHAR(64) NOT NULL,
        accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source VARCHAR(80) NOT NULL DEFAULT 'registration',
        context_type VARCHAR(64) NULL,
        context_id VARCHAR(128) NULL,
        organization_id INT UNSIGNED NULL,
        UNIQUE KEY user_legal_acceptance (user_id, document_type, version),
        INDEX user_legal_lookup (user_id, document_type, accepted_at),
        INDEX user_legal_context_lookup (user_id, document_type, context_type, context_id, organization_id, accepted_at),
        CONSTRAINT user_legal_acceptance_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS user_email_preferences (
        user_id INT UNSIGNED NOT NULL PRIMARY KEY,
        event_invitations BOOLEAN NOT NULL DEFAULT TRUE,
        group_invitations BOOLEAN NOT NULL DEFAULT TRUE,
        group_event_announcements BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT email_preferences_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS marketing_email_preferences (
        email VARCHAR(255) NOT NULL PRIMARY KEY,
        marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        policy_version VARCHAR(64) NULL,
        source VARCHAR(80) NOT NULL DEFAULT 'registration',
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX marketing_preference_opt_in (marketing_opt_in, changed_at)
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS privacy_requests (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        reference VARCHAR(40) NOT NULL UNIQUE,
        user_id INT UNSIGNED NULL,
        name VARCHAR(160) NOT NULL,
        email VARCHAR(255) NOT NULL,
        category ENUM('General','Privacy','Account','Safety','Other') NOT NULL,
        message TEXT NOT NULL,
        status ENUM('submitted','under_review','resolved') NOT NULL DEFAULT 'submitted',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME NULL,
        INDEX privacy_requests_status (status, created_at),
        CONSTRAINT privacy_requests_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS moderation_decisions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        entity_type VARCHAR(64) NOT NULL,
        entity_id VARCHAR(128) NOT NULL,
        subject_user_id INT UNSIGNED NULL,
        action VARCHAR(64) NOT NULL,
        reason_code VARCHAR(80) NOT NULL,
        explanation_internal TEXT NULL,
        explanation_user TEXT NULL,
        automated_detection BOOLEAN NOT NULL DEFAULT FALSE,
        decided_by_user_id INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        appeal_available BOOLEAN NOT NULL DEFAULT TRUE,
        INDEX moderation_decisions_entity (entity_type, entity_id, created_at),
        INDEX moderation_decisions_subject (subject_user_id, created_at),
        CONSTRAINT moderation_decision_subject_fk FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT moderation_decision_actor_fk FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS moderation_appeals (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        moderation_decision_id INT UNSIGNED NOT NULL,
        appellant_user_id INT UNSIGNED NOT NULL,
        explanation TEXT NOT NULL,
        status ENUM('submitted','under_review','upheld','reversed','partially_reversed') NOT NULL DEFAULT 'submitted',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME NULL,
        resolved_by_user_id INT UNSIGNED NULL,
        outcome VARCHAR(64) NULL,
        outcome_reason TEXT NULL,
        INDEX moderation_appeals_status (status, created_at),
        CONSTRAINT moderation_appeal_decision_fk FOREIGN KEY (moderation_decision_id) REFERENCES moderation_decisions(id) ON DELETE CASCADE,
        CONSTRAINT moderation_appeal_appellant_fk FOREIGN KEY (appellant_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT moderation_appeal_resolver_fk FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS account_deletion_jobs (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNSIGNED NULL,
        requested_by_user_id INT UNSIGNED NULL,
        status ENUM('completed','failed') NOT NULL DEFAULT 'completed',
        details JSON NULL,
        requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        INDEX account_deletion_jobs_user (user_id, requested_at),
        CONSTRAINT deletion_job_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT deletion_job_requester_fk FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS audit_log (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        actor_user_id INT UNSIGNED NULL,
        event_type VARCHAR(80) NOT NULL,
        entity_type VARCHAR(64) NULL,
        entity_id VARCHAR(128) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX audit_log_event (event_type, created_at),
        INDEX audit_log_actor (actor_user_id, created_at),
        CONSTRAINT audit_log_actor_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS retention_policies (
        policy_key VARCHAR(80) NOT NULL PRIMARY KEY,
        retention_days INT UNSIGNED NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS content_reports (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        reference VARCHAR(40) NOT NULL UNIQUE,
        reporter_user_id INT UNSIGNED NULL,
        reporter_email VARCHAR(255) NULL,
        entity_type ENUM('image','event','group','review','profile','organization','venue','business_listing') NOT NULL,
        entity_id VARCHAR(128) NULL,
        content_url VARCHAR(2048) NULL,
        reason_code ENUM('illegal_content','harassment','sexual_content','child_safety','violence','hate','scam_fraud','impersonation','privacy','intellectual_property','spam','unsafe_event','misleading_business','misleading_listing','other') NOT NULL,
        description TEXT NOT NULL,
        supporting_details TEXT NULL,
        alleged_illegal BOOLEAN NOT NULL DEFAULT FALSE,
        good_faith_declared BOOLEAN NOT NULL,
        status ENUM('submitted','under_review','resolved','dismissed') NOT NULL DEFAULT 'submitted',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME NULL,
        reviewed_by_user_id INT UNSIGNED NULL,
        INDEX content_reports_status_created (status, created_at),
        INDEX content_reports_entity (entity_type, entity_id),
        INDEX content_reports_reporter (reporter_user_id, created_at),
        CONSTRAINT content_reports_reporter_fk FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT content_reports_reviewer_fk FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
}
