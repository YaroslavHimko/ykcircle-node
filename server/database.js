import mysql from 'mysql2/promise';

export class Database {
  constructor(config) {
    this.pool = mysql.createPool({ ...config, timezone: 'Z', waitForConnections: true, connectionLimit: 5 });
    this.initialized = null;
  }

  // The application historically bootstrapped its schema with CREATE TABLE IF
  // NOT EXISTS.  Financial columns must therefore be additive for deployed
  // databases too; never rely on a fresh database when rolling this out.
  async ensureColumn(table, column, definition) {
    const [rows] = await this.pool.execute(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
    if (!rows[0]) await this.pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
  async hasIndex(table, index) {
    const [rows] = await this.pool.execute(`SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index]);
    return Boolean(rows[0]);
  }

  async initialize() {
    this.initialized ||= (async () => {
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, profile_picture VARCHAR(1024),
        name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL, phone VARCHAR(40) NULL,
        role ENUM('customer', 'organizer', 'venue_owner', 'manager', 'admin') NOT NULL DEFAULT 'customer', session_version INT UNSIGNED NOT NULL DEFAULT 0,
        isEmailConfirmed BOOLEAN NOT NULL DEFAULT FALSE,
        verification_token_hash CHAR(64) NULL, verification_expires_at DATETIME NULL,
        verification_resend_available_at DATETIME NULL, deleted_at DATETIME NULL,
        timezone_display_mode ENUM('device','fixed') NOT NULL DEFAULT 'device', preferred_timezone VARCHAR(64) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
        user_id INT UNSIGNED NOT NULL PRIMARY KEY,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        resend_available_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX password_reset_tokens_expiry_index (expires_at),
        CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS contact_submissions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NULL,
        name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL, contact VARCHAR(120) NULL,
        activity VARCHAR(80) NOT NULL, additional_information TEXT NULL,
        status ENUM('New', 'Approved', 'Contact Again', 'Ordered', 'Declined') NOT NULL DEFAULT 'New',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (email),
        CONSTRAINT contact_submissions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS legal_document_versions (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS user_legal_acceptances (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS marketing_email_preferences (
        email VARCHAR(255) NOT NULL PRIMARY KEY,
        marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
        policy_version VARCHAR(64) NULL,
        source VARCHAR(80) NOT NULL DEFAULT 'registration',
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX marketing_preference_opt_in (marketing_opt_in, changed_at)
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS privacy_requests (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS moderation_decisions (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS moderation_appeals (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS account_deletion_jobs (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS audit_log (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS retention_policies (
        policy_key VARCHAR(80) NOT NULL PRIMARY KEY,
        retention_days INT UNSIGNED NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      // A polymorphic report table intentionally has no foreign key to the reported
      // object. Reports must remain reviewable even if the reported content is
      // subsequently removed, and not every supported entity has the same table.
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS content_reports (
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
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_groups (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, organizer_id INT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL, slug VARCHAR(140) NOT NULL UNIQUE, description TEXT NULL, cover_image VARCHAR(255) NULL,
        visibility ENUM('Public', 'Private') NOT NULL DEFAULT 'Public', status ENUM('active','archived','removed') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (organizer_id), INDEX (visibility), INDEX event_groups_status_index (status),
        CONSTRAINT event_groups_organizer_fk FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS events (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, manager_id INT UNSIGNED NOT NULL,
        group_id INT UNSIGNED NULL, series_id INT UNSIGNED NULL, recurrence_frequency ENUM('none','daily','weekly','monthly') NOT NULL DEFAULT 'none', recurrence_interval SMALLINT UNSIGNED NOT NULL DEFAULT 1, recurrence_count SMALLINT UNSIGNED NOT NULL DEFAULT 1, occurrence_number SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        title VARCHAR(200) NOT NULL, short_description VARCHAR(240) NULL, description TEXT NULL, cover_image VARCHAR(1024) NULL, category_id INT UNSIGNED NULL, type_id INT UNSIGNED NULL,
        location_type ENUM('venue','custom','online') NOT NULL DEFAULT 'custom', location_visibility ENUM('public','registered','attendees_only','approximate') NOT NULL DEFAULT 'public',
        venue_id INT UNSIGNED NULL,
        custom_address_line_1 VARCHAR(255) NULL, custom_address_line_2 VARCHAR(255) NULL, custom_postal_code VARCHAR(32) NULL, custom_locality VARCHAR(120) NULL, custom_municipality VARCHAR(120) NULL, custom_region VARCHAR(120) NULL, custom_country VARCHAR(120) NULL, custom_country_code CHAR(2) NULL, custom_latitude DECIMAL(9,6) NULL, custom_longitude DECIMAL(9,6) NULL, custom_google_place_id VARCHAR(255) NULL, custom_formatted_address VARCHAR(500) NULL,
        online_url VARCHAR(1024) NULL, online_platform VARCHAR(120) NULL,
        starts_at DATETIME NOT NULL, ends_at DATETIME NULL, timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', capacity INT UNSIGNED NULL, minimum_attendees INT UNSIGNED NULL, registration_deadline DATETIME NULL, minimum_age TINYINT UNSIGNED NULL, language_code VARCHAR(12) NULL, what_to_bring TEXT NULL, meeting_instructions TEXT NULL, cancellation_policy TEXT NULL,
        pricing_type ENUM('free','paid') NOT NULL DEFAULT 'free', participation_fee DECIMAL(10,2) NOT NULL DEFAULT 0, currency CHAR(3) NOT NULL DEFAULT 'SEK', registration_type ENUM('yaroko','external','none') NOT NULL DEFAULT 'yaroko', external_registration_url VARCHAR(1024) NULL,
        status ENUM('Draft', 'Published', 'Cancelled', 'Completed', 'Archived') NOT NULL DEFAULT 'Draft',
        visibility ENUM('Public', 'Private', 'Members', 'Unlisted') NOT NULL DEFAULT 'Public', published_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        INDEX (status), INDEX (manager_id), INDEX (group_id), INDEX (category_id), INDEX (type_id), INDEX events_series_id_idx (series_id, occurrence_number),
        CONSTRAINT events_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT events_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE SET NULL,
        CONSTRAINT events_series_fk FOREIGN KEY (series_id) REFERENCES events(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS application_activities (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`INSERT IGNORE INTO application_activities (name, sort_order) VALUES
        ('Publish an Article', 10), ('Travel Collaboration', 20), ('General Enquiry', 30)`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_memberships (
        group_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        role ENUM('owner', 'moderator', 'member') NOT NULL DEFAULT 'member', status ENUM('invited', 'active', 'left', 'removed') NOT NULL DEFAULT 'active', joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id), INDEX (user_id),
        CONSTRAINT group_memberships_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE CASCADE,
        CONSTRAINT group_memberships_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_invitations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, group_id INT UNSIGNED NOT NULL, invited_by_user_id INT UNSIGNED NOT NULL,
        invited_user_id INT UNSIGNED NULL, email VARCHAR(255) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
        status ENUM('pending','accepted','declined','revoked') NOT NULL DEFAULT 'pending', expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY group_invitation_email (group_id, email), INDEX (invited_user_id, status), INDEX (expires_at),
        CONSTRAINT group_invitation_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE CASCADE,
        CONSTRAINT group_invitation_inviter_fk FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT group_invitation_user_fk FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_event_notifications (
        event_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, user_id),
        CONSTRAINT group_event_notifications_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT group_event_notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_registrations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NULL, attendee_name VARCHAR(160) NULL, attendee_email VARCHAR(255) NULL, attendee_phone VARCHAR(40) NULL, status ENUM('Pending', 'Confirmed', 'Cancelled', 'Attended', 'Declined', 'Withdrawn') NOT NULL DEFAULT 'Pending', payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY event_user_unique (event_id, user_id), INDEX (user_id),
        CONSTRAINT registrations_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT registrations_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_categories (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(255) NULL, icon VARCHAR(80) NULL,
        sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(255) NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`INSERT IGNORE INTO event_categories (name, slug, sort_order) VALUES
        ('Social', 'social', 10), ('Outdoors', 'outdoors', 20), ('Sports', 'sports', 30), ('Food & Drink', 'food-drink', 40),
        ('Travel', 'travel', 50), ('Culture', 'culture', 60), ('Language', 'language', 70), ('Photography', 'photography', 80),
        ('Creators', 'creators', 90), ('Technology', 'technology', 100), ('Business & Networking', 'business-networking', 110),
        ('Music', 'music', 120), ('Wellness', 'wellness', 130), ('Nightlife', 'nightlife', 140), ('Education', 'education', 150), ('Family', 'family', 160), ('Other', 'other', 170)`);
      await this.pool.execute(`INSERT IGNORE INTO event_types (name, slug) VALUES
        ('Meetup', 'meetup'), ('Activity', 'activity'), ('Workshop', 'workshop'), ('Class', 'class'), ('Dinner', 'dinner'),
        ('Tour', 'tour'), ('Trip', 'trip'), ('Networking', 'networking'), ('Conference', 'conference'), ('Party', 'party'),
        ('Performance', 'performance'), ('Competition', 'competition'), ('Online Event', 'online-event'), ('Other', 'other')`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS unsubscribed_emails (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE,
        reason VARCHAR(120) NOT NULL, unsubscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_participants (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NULL, participant_name VARCHAR(160) NOT NULL, participant_phone VARCHAR(40) NULL,
        status ENUM('Pending', 'Attended', 'No Show') NOT NULL DEFAULT 'Pending', payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required',
        participant_email VARCHAR(255) NULL, joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY event_participant_user (event_id, user_id), INDEX (event_id),
        CONSTRAINT participants_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT participants_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_ratings (
        event_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, rating TINYINT UNSIGNED NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, user_id), INDEX (event_id, rating),
        CONSTRAINT event_ratings_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_ratings_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_invitations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        manager_id INT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL,
        status ENUM('Pending', 'Accepted', 'Declined') NOT NULL DEFAULT 'Pending',
        token_hash CHAR(64) NOT NULL, token_expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY event_invitation_email (event_id, email),
        CONSTRAINT invitations_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT invitations_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      /* Communities were retired. Existing data is intentionally left untouched, but new installations no longer provision these tables.
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, type_key VARCHAR(48) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL, description VARCHAR(255) NULL, sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_categories (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, parent_id INT UNSIGNED NULL,
        name VARCHAR(100) NOT NULL, slug VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(255) NULL,
        sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (parent_id),
        CONSTRAINT community_category_parent_fk FOREIGN KEY (parent_id) REFERENCES community_categories(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_posts (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(180) NOT NULL UNIQUE,
        author_user_id INT UNSIGNED NOT NULL, city VARCHAR(120) NOT NULL, city_slug VARCHAR(140) NOT NULL,
        post_type_id INT UNSIGNED NOT NULL, category_id INT UNSIGNED NOT NULL, subcategory_id INT UNSIGNED NULL,
        group_id INT UNSIGNED NULL, title VARCHAR(180) NOT NULL, short_description VARCHAR(300) NOT NULL, body TEXT NULL,
        location_name VARCHAR(255) NULL, latitude DECIMAL(10,7) NULL, longitude DECIMAL(10,7) NULL,
        location_radius_km DECIMAL(6,2) NULL, attributes JSON NULL,
        external_event_name VARCHAR(255) NULL, external_event_url VARCHAR(1024) NULL, external_event_at DATETIME NULL,
        visibility ENUM('public','members_only','private') NOT NULL DEFAULT 'public',
        status ENUM('draft','active','fulfilled','expired','archived','removed') NOT NULL DEFAULT 'draft',
        is_indexable BOOLEAN NOT NULL DEFAULT TRUE, expires_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX community_post_public_index (status, visibility, is_indexable, city_slug, category_id, subcategory_id, expires_at),
        INDEX community_post_author_index (author_user_id, status), INDEX (post_type_id), INDEX (group_id),
        CONSTRAINT community_post_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT community_post_type_fk FOREIGN KEY (post_type_id) REFERENCES community_post_types(id),
        CONSTRAINT community_post_category_fk FOREIGN KEY (category_id) REFERENCES community_categories(id),
        CONSTRAINT community_post_subcategory_fk FOREIGN KEY (subcategory_id) REFERENCES community_categories(id),
        CONSTRAINT community_post_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_events (
        post_id INT UNSIGNED NOT NULL, event_id INT UNSIGNED NOT NULL, position INT UNSIGNED NOT NULL,
        PRIMARY KEY (post_id, event_id), UNIQUE KEY community_post_event_position (post_id, position), INDEX (event_id),
        CONSTRAINT community_post_events_post_fk FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
        CONSTRAINT community_post_events_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_responses (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, post_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        message VARCHAR(2000) NULL, status ENUM('active','accepted','declined','removed') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY community_post_response_user (post_id, user_id), INDEX (user_id, status),
        CONSTRAINT community_response_post_fk FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
        CONSTRAINT community_response_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_conversations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, post_id INT UNSIGNED NOT NULL, owner_user_id INT UNSIGNED NOT NULL, member_user_id INT UNSIGNED NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY community_conversation_participants (post_id, member_user_id), INDEX (owner_user_id, updated_at),
        CONSTRAINT community_conversation_post_fk FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
        CONSTRAINT community_conversation_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT community_conversation_member_fk FOREIGN KEY (member_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_conversation_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, conversation_id INT UNSIGNED NOT NULL, sender_user_id INT UNSIGNED NOT NULL, body VARCHAR(4000) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (conversation_id, created_at),
        CONSTRAINT community_conversation_message_fk FOREIGN KEY (conversation_id) REFERENCES community_post_conversations(id) ON DELETE CASCADE,
        CONSTRAINT community_conversation_sender_fk FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_conversation_reads (
        conversation_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, last_read_message_id INT UNSIGNED NOT NULL,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (conversation_id, user_id), INDEX (user_id, read_at),
        CONSTRAINT community_conversation_read_fk FOREIGN KEY (conversation_id) REFERENCES community_post_conversations(id) ON DELETE CASCADE,
        CONSTRAINT community_conversation_read_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`INSERT IGNORE INTO community_post_conversations (post_id, owner_user_id, member_user_id)
        SELECT p.id, p.author_user_id, r.user_id FROM community_post_responses r JOIN community_posts p ON p.id = r.post_id`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_forum_threads (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, post_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
        status ENUM('active','locked','removed') NOT NULL DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (post_id, status, updated_at), CONSTRAINT community_forum_post_fk FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
        CONSTRAINT community_forum_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_forum_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, thread_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, body VARCHAR(4000) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (thread_id, created_at),
        CONSTRAINT community_forum_message_thread_fk FOREIGN KEY (thread_id) REFERENCES community_post_forum_threads(id) ON DELETE CASCADE,
        CONSTRAINT community_forum_message_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      */
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_forum_threads (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, group_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
        status ENUM('active','locked','removed') NOT NULL DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (group_id, status, updated_at), CONSTRAINT group_forum_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE CASCADE,
        CONSTRAINT group_forum_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_forum_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, thread_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, body VARCHAR(4000) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (thread_id, created_at),
        CONSTRAINT group_forum_message_thread_fk FOREIGN KEY (thread_id) REFERENCES group_forum_threads(id) ON DELETE CASCADE,
        CONSTRAINT group_forum_message_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_forum_threads (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
        status ENUM('active','locked','removed') NOT NULL DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (event_id, status, updated_at), CONSTRAINT event_forum_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_forum_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_forum_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, thread_id INT UNSIGNED NOT NULL, author_user_id INT UNSIGNED NOT NULL, body VARCHAR(4000) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (thread_id, created_at),
        CONSTRAINT event_forum_message_thread_fk FOREIGN KEY (thread_id) REFERENCES event_forum_threads(id) ON DELETE CASCADE,
        CONSTRAINT event_forum_message_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS forum_thread_reads (
        scope ENUM('group','event') NOT NULL, thread_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, last_read_message_id INT UNSIGNED NOT NULL,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (scope, thread_id, user_id), INDEX (user_id, scope, read_at),
        CONSTRAINT forum_thread_read_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      /* Communities were retired. Existing report records are retained but no longer provisioned on new installations.
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_reports (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, post_id INT UNSIGNED NOT NULL, reporter_user_id INT UNSIGNED NOT NULL,
        reason VARCHAR(120) NOT NULL, details VARCHAR(1000) NULL,
        status ENUM('open','resolved','dismissed') NOT NULL DEFAULT 'open', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY community_post_reporter (post_id, reporter_user_id), INDEX (status),
        CONSTRAINT community_report_post_fk FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
        CONSTRAINT community_reporter_user_fk FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`INSERT IGNORE INTO community_post_types (type_key, name, sort_order) VALUES
        ('find_people', 'Find people', 10), ('find_group', 'Find a group', 20), ('find_members', 'Find members', 30),
        ('go_together', 'Go together', 40), ('start_activity', 'Start something', 50), ('recommendation', 'Share / recommend', 60),
        ('find_place', 'Find a place', 70), ('find_service', 'Find a service', 80)`);
      const communityCategories = [
        ['Sports', 'sports', 10], ['Music', 'music', 20], ['Outdoors', 'outdoors', 30], ['Travel', 'travel', 40],
        ['Food & Drink', 'food-drink', 50], ['Culture', 'culture', 60], ['Photography', 'photography', 70], ['Creators', 'creators', 80],
        ['Languages', 'languages', 90], ['Gaming', 'gaming', 100], ['Business', 'business', 110], ['Technology', 'technology', 120],
        ['Nightlife', 'nightlife', 130], ['Wellness', 'wellness', 140], ['Family', 'family', 150], ['Other', 'other', 160],
      ];
      for (const [name, slug, sortOrder] of communityCategories) await this.pool.execute('INSERT IGNORE INTO community_categories (name, slug, sort_order) VALUES (?, ?, ?)', [name, slug, sortOrder]);
      const communitySubcategories = { sports: ['Tennis', 'Padel', 'Football', 'Running', 'Cycling'], music: ['Guitar', 'Bands', 'Singing', 'DJ', 'Jam Sessions'] };
      for (const [parentSlug, names] of Object.entries(communitySubcategories)) {
        const [parents] = await this.pool.execute('SELECT id FROM community_categories WHERE parent_id IS NULL AND slug = ?', [parentSlug]);
        for (const [index, name] of names.entries()) await this.pool.execute('INSERT IGNORE INTO community_categories (parent_id, name, slug, sort_order) VALUES (?, ?, ?, ?)', [parents[0].id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), (index + 1) * 10]);
      }
      */
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS article_categories (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, slug VARCHAR(120) NOT NULL UNIQUE,
        description VARCHAR(255) NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`INSERT IGNORE INTO article_categories (name, slug, sort_order) VALUES
        ('News', 'news', 10), ('Guides', 'guides', 20), ('Community Stories', 'community-stories', 30), ('Updates', 'updates', 40)`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS articles (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(180) NOT NULL UNIQUE, author_user_id INT UNSIGNED NOT NULL,
        category_id INT UNSIGNED NULL, title VARCHAR(200) NOT NULL, excerpt VARCHAR(400) NOT NULL, body MEDIUMTEXT NOT NULL,
        cover_image VARCHAR(255) NULL, cover_alt_text VARCHAR(200) NULL,
        status ENUM('draft','published','archived','removed') NOT NULL DEFAULT 'draft', is_indexable BOOLEAN NOT NULL DEFAULT TRUE,
        published_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX article_public_index (status, is_indexable, published_at), INDEX (author_user_id), INDEX (category_id),
        CONSTRAINT article_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT article_category_fk FOREIGN KEY (category_id) REFERENCES article_categories(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS article_tags (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL, slug VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS article_tag_assignments (
        article_id INT UNSIGNED NOT NULL, tag_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (article_id, tag_id), INDEX (tag_id),
        CONSTRAINT article_tag_article_fk FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
        CONSTRAINT article_tag_tag_fk FOREIGN KEY (tag_id) REFERENCES article_tags(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS article_media (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, article_id INT UNSIGNED NOT NULL, filename VARCHAR(255) NOT NULL UNIQUE,
        alt_text VARCHAR(200) NOT NULL, caption VARCHAR(500) NULL, sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (article_id, sort_order),
        CONSTRAINT article_media_article_fk FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_owner_applications (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id INT UNSIGNED NOT NULL UNIQUE,
        business_name VARCHAR(160) NOT NULL,
        message TEXT NULL,
        status ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
        reviewed_by_user_id INT UNSIGNED NULL,
        reviewed_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_owner_application_status (status, created_at),
        CONSTRAINT venue_owner_application_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT venue_owner_application_reviewer_fk FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venues (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        organization_id INT UNSIGNED NULL,
        billing_profile_id INT UNSIGNED NULL,
        owner_user_id INT UNSIGNED NOT NULL,
        name VARCHAR(160) NOT NULL,
        slug VARCHAR(180) NOT NULL UNIQUE,
        business_name VARCHAR(160) NULL,
        short_description VARCHAR(400) NULL,
        description TEXT NULL,
        address_line_1 VARCHAR(255) NULL,
        address_line_2 VARCHAR(255) NULL,
        postal_code VARCHAR(32) NULL,
        country VARCHAR(120) NULL,
        country_code CHAR(2) NULL,
        city VARCHAR(120) NULL,
        municipality VARCHAR(120) NULL,
        region VARCHAR(120) NULL,
        latitude DECIMAL(9,6) NULL,
        longitude DECIMAL(9,6) NULL,
        google_place_id VARCHAR(255) NULL,
        formatted_address VARCHAR(500) NULL,
        location_visibility ENUM('exact','approximate','private') NOT NULL DEFAULT 'exact',
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        venue_type_id INT UNSIGNED NULL,
        capacity_min INT UNSIGNED NULL,
        capacity_max INT UNSIGNED NULL,
        standing_capacity INT UNSIGNED NULL,
        seated_capacity INT UNSIGNED NULL,
        dining_capacity INT UNSIGNED NULL,
        classroom_capacity INT UNSIGNED NULL,
        size_sqm DECIMAL(8,2) NULL,
        price_from DECIMAL(10,2) NULL,
        price_unit ENUM('hour','half_day','day','evening','person','event','contact') NOT NULL DEFAULT 'contact',
        currency CHAR(3) NOT NULL DEFAULT 'SEK',
        pricing_description TEXT NULL,
        minimum_booking_hours DECIMAL(5,2) NULL,
        website_url VARCHAR(1024) NULL,
        phone VARCHAR(80) NULL,
        contact_email VARCHAR(255) NULL,
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        is_featured BOOLEAN NOT NULL DEFAULT FALSE,
        moderation_status ENUM('draft','pending','approved','rejected','removed') NOT NULL DEFAULT 'draft',
        verification_status ENUM('unverified','pending','verified','rejected') NOT NULL DEFAULT 'unverified',
        published_at DATETIME NULL,
        availability_type ENUM('contact','calendar','always_open') NOT NULL DEFAULT 'contact',
        house_rules_text TEXT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venues_owner_index (owner_user_id, is_active),
        INDEX venues_location_index (city, country),
        INDEX venues_public_discovery (is_active, moderation_status, city, venue_type_id),
        CONSTRAINT venues_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_media (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        venue_id INT UNSIGNED NOT NULL,
        filename VARCHAR(255) NOT NULL UNIQUE,
        alt_text VARCHAR(200) NOT NULL,
        caption VARCHAR(500) NULL,
        is_cover BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX venue_media_venue_order (venue_id, is_cover, sort_order),
        CONSTRAINT venue_media_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_bookings (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        venue_id INT UNSIGNED NOT NULL,
        event_id INT UNSIGNED NULL,
        organizer_user_id INT UNSIGNED NOT NULL,
        organizer_organization_id INT UNSIGNED NULL,
        buyer_billing_profile_id INT UNSIGNED NULL,
        billing_status ENUM('not_required','complete','incomplete') NOT NULL DEFAULT 'not_required',
        booking_source ENUM('ykcircle','external','internal') NOT NULL DEFAULT 'ykcircle',
        booking_type ENUM('hourly','daily') NOT NULL DEFAULT 'hourly',
        -- booking_date is a venue-local calendar DATE; timestamp columns are UTC instants.
        booking_date DATE NULL, venue_timezone VARCHAR(64) NULL, start_at DATETIME NULL, end_at DATETIME NULL,
        occupied_start_at DATETIME NULL, occupied_end_at DATETIME NULL,
        status ENUM('requested','confirmed','declined','cancelled','completed') NOT NULL DEFAULT 'requested',
        payment_status ENUM('unpaid','paid') NOT NULL DEFAULT 'unpaid', currency CHAR(3) NOT NULL DEFAULT 'SEK',
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0, tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0, total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        organizer_message TEXT NULL, venue_internal_note TEXT NULL,
        confirmed_at DATETIME NULL, confirmed_by INT UNSIGNED NULL, cancelled_at DATETIME NULL,
        owner_note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY venue_booking_event (event_id),
        INDEX venue_booking_schedule (venue_id, status),
        CONSTRAINT venue_booking_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
        CONSTRAINT venue_booking_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT venue_booking_organizer_fk FOREIGN KEY (organizer_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_booking_messages (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, booking_id INT UNSIGNED NOT NULL, sender_user_id INT UNSIGNED NOT NULL,
        body TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX venue_booking_messages_booking (booking_id, created_at),
        CONSTRAINT venue_booking_messages_booking_fk FOREIGN KEY (booking_id) REFERENCES venue_bookings(id) ON DELETE CASCADE,
        CONSTRAINT venue_booking_messages_sender_fk FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS organizations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL, slug VARCHAR(180) NOT NULL UNIQUE,
        description TEXT NULL, website_url VARCHAR(1024) NULL, phone VARCHAR(80) NULL, contact_email VARCHAR(255) NULL,
        default_billing_profile_id INT UNSIGNED NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS organization_members (
        organization_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        role ENUM('owner','admin','manager','staff') NOT NULL DEFAULT 'staff', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (organization_id, user_id), INDEX organization_members_user (user_id, organization_id),
        CONSTRAINT organization_members_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT organization_members_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_availability_rules (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL,
        day_of_week TINYINT UNSIGNED NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY venue_availability_rule (venue_id, day_of_week, start_time, end_time),
        INDEX venue_availability_rules_day (venue_id, day_of_week),
        CONSTRAINT venue_availability_rules_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_availability_overrides (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL, date DATE NOT NULL,
        override_type ENUM('closed','custom') NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY venue_availability_override (venue_id, date),
        CONSTRAINT venue_availability_overrides_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_availability_override_windows (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, override_id INT UNSIGNED NOT NULL,
        start_time TIME NOT NULL, end_time TIME NOT NULL,
        UNIQUE KEY venue_availability_override_window (override_id, start_time, end_time),
        CONSTRAINT venue_availability_override_windows_override_fk FOREIGN KEY (override_id) REFERENCES venue_availability_overrides(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_availability_blocks (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL,
        start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, reason TEXT NULL, created_by_user_id INT UNSIGNED NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_availability_blocks_range (venue_id, start_at, end_at),
        CONSTRAINT venue_availability_blocks_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
        CONSTRAINT venue_availability_blocks_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_external_reservations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL,
        start_at DATETIME NOT NULL, end_at DATETIME NOT NULL,
        source ENUM('external','internal','phone','email','other_platform','other') NOT NULL DEFAULT 'external',
        title VARCHAR(255) NULL, notes TEXT NULL, created_by_user_id INT UNSIGNED NULL, cancelled_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_external_reservations_range (venue_id, cancelled_at, start_at, end_at),
        CONSTRAINT venue_external_reservations_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
        CONSTRAINT venue_external_reservations_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_booking_settings (
        venue_id INT UNSIGNED NOT NULL PRIMARY KEY, booking_mode ENUM('hourly','daily','both','inquiry_only') NOT NULL DEFAULT 'hourly',
        slot_increment_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30, minimum_booking_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        maximum_booking_minutes SMALLINT UNSIGNED NULL, buffer_before_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        buffer_after_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0, minimum_notice_hours SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        maximum_advance_days SMALLINT UNSIGNED NOT NULL DEFAULT 365, currency CHAR(3) NOT NULL DEFAULT 'SEK',
        hourly_rate DECIMAL(12,2) NULL, daily_rate DECIMAL(12,2) NULL, invoice_due_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT venue_booking_settings_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS billing_profiles (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, owner_user_id INT UNSIGNED NULL, owner_organization_id INT UNSIGNED NULL,
        profile_type ENUM('individual','organization') NOT NULL, legal_name VARCHAR(255) NOT NULL,
        organization_number VARCHAR(100) NULL, vat_number VARCHAR(100) NULL,
        address_line_1 VARCHAR(255) NOT NULL, address_line_2 VARCHAR(255) NULL,
        postal_code VARCHAR(32) NOT NULL, city VARCHAR(120) NOT NULL, country VARCHAR(120) NOT NULL,
        billing_email VARCHAR(255) NOT NULL, phone VARCHAR(80) NULL, default_currency CHAR(3) NULL,
        invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'INV', invoice_due_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        payment_instructions TEXT NULL, is_default BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX billing_profiles_user (owner_user_id, is_active, is_default),
        INDEX billing_profiles_organization (owner_organization_id, is_active, is_default),
        CONSTRAINT billing_profiles_owner_user_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT billing_profiles_owner_organization_fk FOREIGN KEY (owner_organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT billing_profiles_exactly_one_owner CHECK ((owner_user_id IS NULL) <> (owner_organization_id IS NULL))
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS payment_accounts (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, billing_profile_id INT UNSIGNED NOT NULL, provider VARCHAR(80) NOT NULL,
        provider_account_id VARCHAR(255) NULL, onboarding_status ENUM('not_started','pending','restricted','ready','disabled') NOT NULL DEFAULT 'not_started',
        charges_enabled BOOLEAN NOT NULL DEFAULT FALSE, payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        details_submitted BOOLEAN NULL, country VARCHAR(120) NULL, default_currency CHAR(3) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY payment_account_provider (provider, provider_account_id), INDEX payment_accounts_profile (billing_profile_id),
        CONSTRAINT payment_accounts_profile_fk FOREIGN KEY (billing_profile_id) REFERENCES billing_profiles(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_payment_settings (
        event_id INT UNSIGNED NOT NULL PRIMARY KEY, seller_billing_profile_id INT UNSIGNED NULL, payment_account_id INT UNSIGNED NULL,
        seller_capacity ENUM('trader','private') NULL, currency CHAR(3) NULL, payments_enabled BOOLEAN NOT NULL DEFAULT FALSE, ticket_sales_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        refund_policy_snapshot JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT event_payment_settings_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_payment_settings_seller_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT event_payment_settings_account_fk FOREIGN KEY (payment_account_id) REFERENCES payment_accounts(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS invoices (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, seller_organization_id INT UNSIGNED NULL, buyer_user_id INT UNSIGNED NULL,
        buyer_organization_id INT UNSIGNED NULL, buyer_billing_profile_id INT UNSIGNED NULL, seller_billing_profile_id INT UNSIGNED NULL, booking_id INT UNSIGNED NULL,
        context_type VARCHAR(64) NULL, context_id VARCHAR(128) NULL, invoice_series_id INT UNSIGNED NULL, invoice_number VARCHAR(80) NULL,
        status ENUM('draft','issued','sent','paid','overdue','void') NOT NULL DEFAULT 'draft', delivery_status ENUM('pending','sent','failed') NULL,
        issue_date DATE NULL, due_date DATE NULL, currency CHAR(3) NOT NULL, subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
        tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0, total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
        seller_snapshot_json JSON NULL, buyer_snapshot_json JSON NULL, booking_snapshot_json JSON NULL, tax_snapshot_json JSON NULL, payment_instructions_snapshot TEXT NULL,
        pdf_storage_key VARCHAR(1024) NULL, pdf_generated_at DATETIME NULL, pdf_hash CHAR(64) NULL, sent_at DATETIME NULL,
        paid_at DATETIME NULL, paid_date DATE NULL, paid_by_user_id INT UNSIGNED NULL, manual_payment_reference VARCHAR(255) NULL,
        manual_payment_method ENUM('bank_transfer','bankgiro','plusgiro','swish','cash','other') NULL, manual_payment_note TEXT NULL,
        voided_at DATETIME NULL, voided_by INT UNSIGNED NULL, void_reason TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY invoice_number_per_profile (seller_billing_profile_id, invoice_number), INDEX invoices_seller (seller_organization_id), INDEX invoices_booking (booking_id),
        CONSTRAINT invoices_seller_fk FOREIGN KEY (seller_organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
        CONSTRAINT invoices_buyer_fk FOREIGN KEY (buyer_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT invoices_buyer_billing_profile_fk FOREIGN KEY (buyer_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT invoices_seller_billing_profile_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT invoices_booking_fk FOREIGN KEY (booking_id) REFERENCES venue_bookings(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS invoice_items (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED NOT NULL, description VARCHAR(500) NOT NULL,
        quantity DECIMAL(12,3) NOT NULL, unit VARCHAR(40) NOT NULL, unit_price DECIMAL(12,2) NOT NULL, tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
        subtotal DECIMAL(12,2) NOT NULL, tax_amount DECIMAL(12,2) NOT NULL, total DECIMAL(12,2) NOT NULL,
        CONSTRAINT invoice_items_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS invoice_history (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED NOT NULL, action VARCHAR(40) NOT NULL,
        previous_status VARCHAR(20) NULL, new_status VARCHAR(20) NULL, performed_by_user_id INT UNSIGNED NULL,
        metadata_json JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX invoice_history_invoice (invoice_id, created_at),
        CONSTRAINT invoice_history_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
        CONSTRAINT invoice_history_user_fk FOREIGN KEY (performed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS payments (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED NOT NULL, booking_id INT UNSIGNED NULL,
        provider VARCHAR(80) NOT NULL, provider_payment_id VARCHAR(255) NULL, status ENUM('pending','requires_action','succeeded','failed','cancelled') NOT NULL,
        currency CHAR(3) NOT NULL, amount DECIMAL(12,2) NOT NULL, payment_method_type VARCHAR(40) NULL,
        payment_method_brand VARCHAR(80) NULL, payment_method_last4 CHAR(4) NULL, metadata_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, authorized_at DATETIME NULL, paid_at DATETIME NULL, failed_at DATETIME NULL, cancelled_at DATETIME NULL,
        INDEX payments_invoice (invoice_id, created_at),
        CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
        CONSTRAINT payments_booking_fk FOREIGN KEY (booking_id) REFERENCES venue_bookings(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS invoice_series (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, seller_billing_profile_id INT UNSIGNED NOT NULL,
        prefix VARCHAR(20) NOT NULL, year SMALLINT UNSIGNED NOT NULL, next_number INT UNSIGNED NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY invoice_series_seller_year (seller_billing_profile_id, year),
        CONSTRAINT invoice_series_seller_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_billing_settings (
        venue_id INT UNSIGNED NOT NULL PRIMARY KEY,
        invoice_mode ENUM('ykcircle','external') NOT NULL DEFAULT 'ykcircle',
        seller_billing_profile_id INT UNSIGNED NULL,
        payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        tax_mode ENUM('no_tax','configured') NOT NULL DEFAULT 'no_tax',
        default_tax_rate DECIMAL(5,2) NULL,
        prices_include_tax BOOLEAN NOT NULL DEFAULT FALSE,
        confirmation_policy ENUM('on_owner_approval','after_payment') NOT NULL DEFAULT 'on_owner_approval',
        accepted_terms_version VARCHAR(64) NULL,
        accepted_at DATETIME NULL,
        accepted_by_user_id INT UNSIGNED NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT venue_billing_settings_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
        CONSTRAINT venue_billing_settings_seller_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT venue_billing_settings_terms_user_fk FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_payment_settings (
        venue_id INT UNSIGNED NOT NULL PRIMARY KEY,
        methods_json JSON NULL,
        bankgiro VARCHAR(80) NULL,
        plusgiro VARCHAR(80) NULL,
        iban VARCHAR(80) NULL,
        bic VARCHAR(32) NULL,
        swish_number VARCHAR(80) NULL,
        bank_name VARCHAR(160) NULL,
        account_details_text TEXT NULL,
        additional_instructions TEXT NULL,
        payment_reference_mode ENUM('invoice_number','custom') NOT NULL DEFAULT 'invoice_number',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT venue_payment_settings_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS booking_external_invoices (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        booking_id INT UNSIGNED NOT NULL,
        external_invoice_number VARCHAR(120) NULL,
        external_invoice_date DATE NULL,
        amount DECIMAL(12,2) NULL,
        currency CHAR(3) NULL,
        due_date DATE NULL,
        file_storage_key VARCHAR(1024) NULL,
        external_invoice_url VARCHAR(2048) NULL,
        status ENUM('awaiting_invoice','issued','paid','void') NOT NULL DEFAULT 'awaiting_invoice',
        marked_paid_at DATETIME NULL,
        marked_paid_by_user_id INT UNSIGNED NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY external_invoice_booking (booking_id),
        CONSTRAINT external_invoice_booking_fk FOREIGN KEY (booking_id) REFERENCES venue_bookings(id) ON DELETE RESTRICT,
        CONSTRAINT external_invoice_paid_by_fk FOREIGN KEY (marked_paid_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS invoice_documents (
        invoice_id INT UNSIGNED NOT NULL PRIMARY KEY,
        pdf_document LONGBLOB NOT NULL,
        pdf_hash CHAR(64) NOT NULL,
        generated_at DATETIME NOT NULL,
        CONSTRAINT invoice_documents_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_billing_settings (
        settings_key VARCHAR(64) NOT NULL PRIMARY KEY, billing_profile_id INT UNSIGNED NULL,
        updated_by_user_id INT UNSIGNED NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT platform_billing_profile_fk FOREIGN KEY (billing_profile_id) REFERENCES billing_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT platform_billing_settings_user_fk FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_products (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, product_type ENUM('subscription','event_fee','featured_listing','other') NOT NULL,
        code VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, description TEXT NULL,
        entitlement_feature VARCHAR(100) NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_prices (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, product_id INT UNSIGNED NOT NULL, currency CHAR(3) NOT NULL,
        amount DECIMAL(12,2) NOT NULL, billing_interval ENUM('month','year') NULL, provider_price_id VARCHAR(255) NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY platform_price_provider (provider_price_id), INDEX platform_price_product (product_id, is_active),
        CONSTRAINT platform_prices_product_fk FOREIGN KEY (product_id) REFERENCES platform_products(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_orders (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, buyer_user_id INT UNSIGNED NULL, buyer_organization_id INT UNSIGNED NULL,
        buyer_billing_profile_id INT UNSIGNED NULL, product_id INT UNSIGNED NOT NULL, event_id INT UNSIGNED NULL,
        buyer_capacity ENUM('consumer','business') NOT NULL, currency CHAR(3) NOT NULL, subtotal DECIMAL(12,2) NOT NULL,
        tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0, total_amount DECIMAL(12,2) NOT NULL,
        payment_status ENUM('pending','paid','failed','refunded','cancelled') NOT NULL DEFAULT 'pending',
        provider VARCHAR(80) NULL, provider_payment_id VARCHAR(255) NULL, checkout_idempotency_key VARCHAR(128) NULL, invoice_id INT UNSIGNED NULL,
        terms_version VARCHAR(64) NULL, accepted_at DATETIME NULL, product_snapshot_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY platform_order_provider_payment (provider, provider_payment_id), UNIQUE KEY platform_order_idempotency (buyer_user_id, checkout_idempotency_key), INDEX platform_orders_buyer (buyer_user_id, created_at),
        CONSTRAINT platform_orders_buyer_user_fk FOREIGN KEY (buyer_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT platform_orders_buyer_org_fk FOREIGN KEY (buyer_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
        CONSTRAINT platform_orders_buyer_profile_fk FOREIGN KEY (buyer_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT platform_orders_product_fk FOREIGN KEY (product_id) REFERENCES platform_products(id) ON DELETE RESTRICT,
        CONSTRAINT platform_orders_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
        CONSTRAINT platform_orders_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_subscriptions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, subscriber_user_id INT UNSIGNED NULL, subscriber_organization_id INT UNSIGNED NULL,
        buyer_billing_profile_id INT UNSIGNED NULL, product_id INT UNSIGNED NOT NULL, buyer_capacity ENUM('consumer','business') NOT NULL,
        status ENUM('pending','active','past_due','cancelled','expired') NOT NULL DEFAULT 'pending',
        current_period_start DATETIME NULL, current_period_end DATETIME NULL, cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        provider VARCHAR(80) NULL, provider_customer_id VARCHAR(255) NULL, provider_subscription_id VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY platform_subscription_provider (provider, provider_subscription_id), INDEX platform_subscriptions_subscriber (subscriber_user_id, status),
        CONSTRAINT platform_subscriptions_user_fk FOREIGN KEY (subscriber_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT platform_subscriptions_org_fk FOREIGN KEY (subscriber_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
        CONSTRAINT platform_subscriptions_profile_fk FOREIGN KEY (buyer_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT platform_subscriptions_product_fk FOREIGN KEY (product_id) REFERENCES platform_products(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_payments (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id INT UNSIGNED NULL, subscription_id INT UNSIGNED NULL,
        provider VARCHAR(80) NOT NULL, provider_payment_id VARCHAR(255) NULL, provider_invoice_id VARCHAR(255) NULL,
        amount DECIMAL(12,2) NOT NULL, currency CHAR(3) NOT NULL,
        status ENUM('pending','succeeded','failed','refunded','partially_refunded','cancelled') NOT NULL DEFAULT 'pending',
        paid_at DATETIME NULL, refunded_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY platform_payment_provider (provider, provider_payment_id), INDEX platform_payments_order (order_id, created_at),
        CONSTRAINT platform_payments_order_fk FOREIGN KEY (order_id) REFERENCES platform_orders(id) ON DELETE SET NULL,
        CONSTRAINT platform_payments_subscription_fk FOREIGN KEY (subscription_id) REFERENCES platform_subscriptions(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS platform_entitlements (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NULL, organization_id INT UNSIGNED NULL,
        event_id INT UNSIGNED NULL, feature VARCHAR(100) NOT NULL, source_type VARCHAR(64) NOT NULL, source_id INT UNSIGNED NULL,
        starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ends_at DATETIME NULL, revoked_at DATETIME NULL,
        INDEX platform_entitlement_lookup (user_id, organization_id, event_id, feature, revoked_at),
        CONSTRAINT platform_entitlements_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT platform_entitlements_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
        CONSTRAINT platform_entitlements_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_ticket_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL,
        description TEXT NULL, price DECIMAL(12,2) NOT NULL, currency CHAR(3) NOT NULL, quantity_available INT UNSIGNED NULL,
        quantity_sold INT UNSIGNED NOT NULL DEFAULT 0, sales_start_at DATETIME NULL, sales_end_at DATETIME NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX event_ticket_types_event (event_id, is_active),
        CONSTRAINT event_ticket_types_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS ticket_orders (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_number VARCHAR(64) NOT NULL UNIQUE, event_id INT UNSIGNED NULL,
        attendee_user_id INT UNSIGNED NULL, attendee_email VARCHAR(255) NOT NULL, seller_billing_profile_id INT UNSIGNED NULL,
        payment_account_id INT UNSIGNED NULL, currency CHAR(3) NOT NULL, subtotal DECIMAL(12,2) NOT NULL,
        tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0, total_amount DECIMAL(12,2) NOT NULL,
        payment_status ENUM('pending','paid','failed','refunded','partially_refunded','disputed','cancelled') NOT NULL DEFAULT 'pending',
        provider VARCHAR(80) NOT NULL, provider_payment_id VARCHAR(255) NULL, seller_snapshot_json JSON NOT NULL,
        refund_policy_snapshot JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ticket_order_provider_payment (provider, provider_payment_id), INDEX ticket_orders_attendee (attendee_user_id, created_at),
        CONSTRAINT ticket_orders_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
        CONSTRAINT ticket_orders_attendee_fk FOREIGN KEY (attendee_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT ticket_orders_seller_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT ticket_orders_account_fk FOREIGN KEY (payment_account_id) REFERENCES payment_accounts(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS ticket_order_items (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ticket_order_id INT UNSIGNED NOT NULL, ticket_type_id INT UNSIGNED NULL,
        ticket_type_snapshot_json JSON NOT NULL, quantity INT UNSIGNED NOT NULL, unit_price DECIMAL(12,2) NOT NULL,
        subtotal DECIMAL(12,2) NOT NULL, tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0, total_amount DECIMAL(12,2) NOT NULL,
        CONSTRAINT ticket_order_items_order_fk FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id) ON DELETE RESTRICT,
        CONSTRAINT ticket_order_items_type_fk FOREIGN KEY (ticket_type_id) REFERENCES event_ticket_types(id) ON DELETE SET NULL
      )`);
      await this.ensureColumn('ticket_orders', 'checkout_session_id', 'VARCHAR(255) NULL');
      await this.ensureColumn('ticket_orders', 'checkout_key', 'VARCHAR(100) NULL');
      await this.ensureColumn('ticket_orders', 'checkout_expires_at', 'DATETIME NULL');
      await this.ensureColumn('ticket_orders', 'test_mode', 'BOOLEAN NOT NULL DEFAULT FALSE');
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS issued_tickets (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ticket_order_id INT UNSIGNED NOT NULL,
        ticket_order_item_id INT UNSIGNED NOT NULL, ordinal INT UNSIGNED NOT NULL,
        code VARCHAR(64) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY ticket_item_ordinal (ticket_order_item_id, ordinal),
        FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id) ON DELETE RESTRICT,
        FOREIGN KEY (ticket_order_item_id) REFERENCES ticket_order_items(id) ON DELETE RESTRICT
      )`);
      // Durable delivery jobs are committed with tickets. SMTP failure cannot lose a purchase.
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS ticket_email_deliveries (
        ticket_order_id INT UNSIGNED PRIMARY KEY, sent_at DATETIME NULL, attempts INT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_until DATETIME NULL,
        lock_token VARCHAR(64) NULL, last_error VARCHAR(500) NULL,
        FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id) ON DELETE RESTRICT
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS payment_provider_events (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(80) NOT NULL, provider_event_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(120) NOT NULL, payload_json JSON NOT NULL, processed_at DATETIME NULL, processing_error TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY payment_provider_event (provider, provider_event_id)
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await this.pool.execute(`INSERT IGNORE INTO venue_types (slug, name, sort_order) VALUES
        ('event-space','Event space',10),('conference-room','Conference room',20),('meeting-room','Meeting room',30),('restaurant','Restaurant',40),('bar','Bar',50),('cafe','Café',60),('rooftop','Rooftop',70),('studio','Studio',80),('photography-studio','Photography studio',90),('music-rehearsal-studio','Music rehearsal studio',100),('dance-studio','Dance studio',110),('sports-facility','Sports facility',120),('tennis-court','Tennis court',130),('padel-court','Padel court',140),('coworking-space','Coworking space',150),('classroom','Classroom',160),('gallery','Gallery',170),('theatre','Theatre',180),('cinema','Cinema',190),('outdoor-venue','Outdoor venue',200),('park','Park',210),('community-center','Community center',220),('private-dining-room','Private dining room',230),('party-venue','Party venue',240),('wedding-venue','Wedding venue',250),('hotel-venue','Hotel venue',260),('other','Other',999)`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_event_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await this.pool.execute(`INSERT IGNORE INTO venue_event_types (slug, name, sort_order) VALUES
        ('meetup','Meetup',10),('workshop','Workshop',20),('class','Class',30),('networking','Networking',40),('conference','Conference',50),('party','Party',60),('private-dinner','Private dinner',70),('birthday','Birthday',80),('wedding','Wedding',90),('concert','Concert',100),('rehearsal','Rehearsal',110),('photography','Photography',120),('video-production','Video production',130),('yoga','Yoga',140),('sports','Sports',150),('exhibition','Exhibition',160),('product-launch','Product launch',170),('corporate-event','Corporate event',180),('community-event','Community event',190)`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_amenities (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, category VARCHAR(80) NOT NULL, sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE
      )`);
      await this.pool.execute(`INSERT IGNORE INTO venue_amenities (slug, name, category, sort_order) VALUES
        ('wifi','Wi-Fi','technology',10),('projector','Projector','technology',20),('tv-display','TV / display','technology',30),('microphones','Microphones','technology',40),('pa-system','PA system','technology',50),('speakers','Speakers','technology',60),('stage-lighting','Stage lighting','technology',70),('streaming-equipment','Streaming equipment','technology',80),('tables','Tables','furniture',10),('chairs','Chairs','furniture',20),('sofas','Sofas','furniture',30),('standing-tables','Standing tables','furniture',40),('podium','Podium','furniture',50),('kitchen','Kitchen','food',10),('catering-allowed','Catering allowed','food',20),('external-catering-allowed','External catering allowed','food',30),('bar','Bar','food',40),('refrigerator','Refrigerator','food',50),('coffee-machine','Coffee machine','food',60),('step-free-entrance','Step-free entrance','accessibility',10),('accessible-toilet','Accessible toilet','accessibility',20),('elevator','Elevator','accessibility',30),('accessible-parking','Accessible parking','accessibility',40),('toilets','Toilets','facilities',10),('changing-rooms','Changing rooms','facilities',20),('shower','Shower','facilities',30),('coat-storage','Coat storage','facilities',40),('reception','Reception','facilities',50),('storage-room','Storage room','facilities',60),('parking','Parking','transport',10),('bicycle-parking','Bicycle parking','transport',20),('near-metro','Near metro','transport',30),('near-train','Near train','transport',40),('near-bus','Near bus','transport',50)`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_amenity_assignments (
        venue_id INT UNSIGNED NOT NULL, amenity_id INT UNSIGNED NOT NULL, PRIMARY KEY (venue_id, amenity_id), INDEX venue_amenity_assignments_amenity (amenity_id, venue_id),
        CONSTRAINT venue_amenity_assignments_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE, CONSTRAINT venue_amenity_assignments_amenity_fk FOREIGN KEY (amenity_id) REFERENCES venue_amenities(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_event_type_assignments (
        venue_id INT UNSIGNED NOT NULL, event_type_id INT UNSIGNED NOT NULL, PRIMARY KEY (venue_id, event_type_id), INDEX venue_event_type_assignments_type (event_type_id, venue_id),
        CONSTRAINT venue_event_type_assignments_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE, CONSTRAINT venue_event_type_assignments_type_fk FOREIGN KEY (event_type_id) REFERENCES venue_event_types(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_inquiries (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL, organizer_user_id INT UNSIGNED NOT NULL, event_id INT UNSIGNED NULL,
        event_name VARCHAR(200) NOT NULL, event_type VARCHAR(120) NULL, requested_date DATE NULL, start_time TIME NULL, end_time TIME NULL, expected_guests INT UNSIGNED NULL, budget DECIMAL(10,2) NULL, message TEXT NOT NULL,
        status ENUM('new','viewed','responded','accepted','declined','cancelled') NOT NULL DEFAULT 'new', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_inquiries_venue_status (venue_id, status, created_at), INDEX venue_inquiries_organizer (organizer_user_id, created_at),
        CONSTRAINT venue_inquiries_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE, CONSTRAINT venue_inquiries_organizer_fk FOREIGN KEY (organizer_user_id) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT venue_inquiries_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS saved_venues (
        user_id INT UNSIGNED NOT NULL, venue_id INT UNSIGNED NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, venue_id), INDEX saved_venues_venue (venue_id),
        CONSTRAINT saved_venues_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, CONSTRAINT saved_venues_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS venue_promotions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL, promotion_type ENUM('featured_search','featured_city','homepage_feature','category_feature') NOT NULL, city VARCHAR(120) NULL, venue_type_id INT UNSIGNED NULL,
        starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL, status ENUM('draft','scheduled','active','paused','ended') NOT NULL DEFAULT 'draft', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX venue_promotions_active (status, starts_at, ends_at), CONSTRAINT venue_promotions_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
      // Additive compatibility migrations. Existing production rows are left
      // untouched; the new nullable fields are populated only by new flows.
      await this.ensureColumn('organizations', 'default_billing_profile_id', 'INT UNSIGNED NULL');
      await this.ensureColumn('payment_accounts', 'details_submitted', 'BOOLEAN NULL');
      await this.ensureColumn('event_payment_settings', 'seller_capacity', "ENUM('trader','private') NULL");
      await this.ensureColumn('event_payment_settings', 'refund_policy_snapshot', 'JSON NULL');
      await this.ensureColumn('invoices', 'context_type', 'VARCHAR(64) NULL');
      await this.ensureColumn('invoices', 'context_id', 'VARCHAR(128) NULL');
      await this.ensureColumn('invoices', 'invoice_series_id', 'INT UNSIGNED NULL');
      await this.ensureColumn('invoices', 'paid_date', 'DATE NULL');
      await this.ensureColumn('invoices', 'manual_payment_note', 'TEXT NULL');
      const [invoicePaymentMethodColumns] = await this.pool.execute(`SELECT column_type AS columnType FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'invoices' AND column_name = 'manual_payment_method'`);
      if (invoicePaymentMethodColumns[0] && !String(invoicePaymentMethodColumns[0].columnType).includes("'bankgiro'")) {
        await this.pool.execute("ALTER TABLE invoices MODIFY COLUMN manual_payment_method ENUM('bank_transfer','bankgiro','plusgiro','swish','cash','other') NULL");
      }
      await this.ensureColumn('venue_bookings', 'invoice_generation_status', "ENUM('not_required','pending','succeeded','failed') NOT NULL DEFAULT 'not_required'");
      await this.ensureColumn('venue_bookings', 'invoice_generation_error', 'VARCHAR(500) NULL');
      await this.ensureColumn('platform_orders', 'checkout_idempotency_key', 'VARCHAR(128) NULL');
      // This is additive for historic acceptance evidence. The old unique key
      // prevented us from retaining a second acceptance for the same version
      // in a distinct Event, Venue, Organization, booking, or order context.
      await this.ensureColumn('user_legal_acceptances', 'context_type', 'VARCHAR(64) NULL');
      await this.ensureColumn('user_legal_acceptances', 'context_id', 'VARCHAR(128) NULL');
      await this.ensureColumn('user_legal_acceptances', 'organization_id', 'INT UNSIGNED NULL');
      if (await this.hasIndex('user_legal_acceptances', 'user_legal_acceptance')) {
        await this.pool.execute('ALTER TABLE user_legal_acceptances DROP INDEX user_legal_acceptance');
      }
      if (!await this.hasIndex('user_legal_acceptances', 'user_legal_context_lookup')) {
        await this.pool.execute('CREATE INDEX user_legal_context_lookup ON user_legal_acceptances (user_id, document_type, context_type, context_id, organization_id, accepted_at)');
      }
      // Invoice numbers belong to a legal seller profile, not to an
      // organization. Retiring this index does not alter legacy numbers.
      if (await this.hasIndex('invoices', 'invoice_number_per_seller')) {
        // The legacy composite key may be the index MySQL chose for
        // invoices_seller_fk. Keep an explicit replacement before removing it.
        if (!await this.hasIndex('invoices', 'invoices_seller')) await this.pool.execute('ALTER TABLE invoices ADD INDEX invoices_seller (seller_organization_id)');
        await this.pool.execute('ALTER TABLE invoices DROP INDEX invoice_number_per_seller');
      }
      if (!await this.hasIndex('invoices', 'invoice_number_per_profile')) await this.pool.execute('ALTER TABLE invoices ADD UNIQUE KEY invoice_number_per_profile (seller_billing_profile_id, invoice_number)');
      if (!await this.hasIndex('platform_orders', 'platform_order_idempotency')) await this.pool.execute('ALTER TABLE platform_orders ADD UNIQUE KEY platform_order_idempotency (buyer_user_id, checkout_idempotency_key)');
    })();
    return this.initialized;
  }

  execute(...args) { return this.pool.execute(...args); }
  query(...args) { return this.pool.query(...args); }
  getConnection() { return this.pool.getConnection(); }
  close() { return this.pool.end(); }
}
