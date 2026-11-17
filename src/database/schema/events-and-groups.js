export async function initializeEventsAndGroupsSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS event_groups (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, organizer_id INT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL, slug VARCHAR(140) NOT NULL UNIQUE, description TEXT NULL, cover_image VARCHAR(255) NULL,
        visibility ENUM('Public', 'Private') NOT NULL DEFAULT 'Public', status ENUM('active','archived','removed') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (organizer_id), INDEX (visibility), INDEX event_groups_status_index (status),
        CONSTRAINT event_groups_organizer_fk FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS events (
        organizer_organization_id INT UNSIGNED NULL,
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, manager_id INT UNSIGNED NOT NULL,
        group_id INT UNSIGNED NULL, series_id INT UNSIGNED NULL, recurrence_frequency ENUM('none','daily','weekly','monthly') NOT NULL DEFAULT 'none', recurrence_interval SMALLINT UNSIGNED NOT NULL DEFAULT 1, recurrence_count SMALLINT UNSIGNED NOT NULL DEFAULT 1, occurrence_number SMALLINT UNSIGNED NOT NULL DEFAULT 1,
        title VARCHAR(200) NOT NULL, brand_name VARCHAR(160) NULL, logo_image MEDIUMTEXT NULL, short_description VARCHAR(240) NULL, description TEXT NULL, food_options JSON NULL, cover_image VARCHAR(1024) NULL, category_id INT UNSIGNED NULL, type_id INT UNSIGNED NULL,
        location_type ENUM('venue','custom','online') NOT NULL DEFAULT 'custom', location_visibility ENUM('public','registered','attendees_only','approximate') NOT NULL DEFAULT 'public',
        venue_id INT UNSIGNED NULL,
        custom_address_line_1 VARCHAR(255) NULL, custom_address_line_2 VARCHAR(255) NULL, custom_postal_code VARCHAR(32) NULL, custom_locality VARCHAR(120) NULL, custom_municipality VARCHAR(120) NULL, custom_region VARCHAR(120) NULL, custom_country VARCHAR(120) NULL, custom_country_code CHAR(2) NULL, custom_latitude DECIMAL(9,6) NULL, custom_longitude DECIMAL(9,6) NULL, custom_google_place_id VARCHAR(255) NULL, custom_formatted_address VARCHAR(500) NULL,
        online_url VARCHAR(1024) NULL, online_platform VARCHAR(120) NULL,
        starts_at DATETIME NOT NULL, ends_at DATETIME NULL, timezone VARCHAR(64) NOT NULL DEFAULT 'UTC', cancellation_policy TEXT NULL,
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
  await database.execute(`CREATE TABLE IF NOT EXISTS event_representatives (
        event_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        assigned_by_user_id INT UNSIGNED NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, user_id), INDEX (user_id),
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS group_memberships (
        group_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        role ENUM('owner', 'moderator', 'member') NOT NULL DEFAULT 'member', status ENUM('invited', 'active', 'left', 'removed') NOT NULL DEFAULT 'active', joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id), INDEX (user_id),
        CONSTRAINT group_memberships_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE CASCADE,
        CONSTRAINT group_memberships_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS group_invitations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, group_id INT UNSIGNED NOT NULL, invited_by_user_id INT UNSIGNED NOT NULL,
        invited_user_id INT UNSIGNED NULL, email VARCHAR(255) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
        status ENUM('pending','accepted','declined','revoked') NOT NULL DEFAULT 'pending', expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY group_invitation_email (group_id, email), INDEX (invited_user_id, status), INDEX (expires_at),
        CONSTRAINT group_invitation_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE CASCADE,
        CONSTRAINT group_invitation_inviter_fk FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT group_invitation_user_fk FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS group_event_notifications (
        event_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, user_id),
        CONSTRAINT group_event_notifications_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT group_event_notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_registrations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        selected_food_options JSON NULL,
        user_id INT UNSIGNED NULL, attendee_name VARCHAR(160) NULL, attendee_email VARCHAR(255) NULL, attendee_phone VARCHAR(40) NULL, status ENUM('Pending', 'Confirmed', 'Cancelled', 'Attended', 'Declined', 'Withdrawn') NOT NULL DEFAULT 'Pending', payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY event_user_unique (event_id, user_id), INDEX (user_id),
        CONSTRAINT registrations_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT registrations_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_categories (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(255) NULL, icon VARCHAR(80) NULL,
        sort_order INT NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(255) NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  await database.execute(`INSERT IGNORE INTO event_categories (name, slug, sort_order) VALUES
        ('Social', 'social', 10), ('Outdoors', 'outdoors', 20), ('Sports', 'sports', 30), ('Food & Drink', 'food-drink', 40),
        ('Travel', 'travel', 50), ('Culture', 'culture', 60), ('Language', 'language', 70), ('Photography', 'photography', 80),
        ('Creators', 'creators', 90), ('Technology', 'technology', 100), ('Business & Networking', 'business-networking', 110),
        ('Music', 'music', 120), ('Wellness', 'wellness', 130), ('Nightlife', 'nightlife', 140), ('Education', 'education', 150), ('Family', 'family', 160), ('Other', 'other', 170)`);
  await database.execute(`INSERT IGNORE INTO event_types (name, slug) VALUES
        ('Meetup', 'meetup'), ('Activity', 'activity'), ('Workshop', 'workshop'), ('Class', 'class'), ('Dinner', 'dinner'),
        ('Tour', 'tour'), ('Trip', 'trip'), ('Networking', 'networking'), ('Conference', 'conference'), ('Party', 'party'),
        ('Performance', 'performance'), ('Competition', 'competition'), ('Online Event', 'online-event'), ('Other', 'other')`);
  await database.execute(`CREATE TABLE IF NOT EXISTS unsubscribed_emails (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE,
        reason VARCHAR(120) NOT NULL, unsubscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_participants (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        selected_food_options JSON NULL,
        user_id INT UNSIGNED NULL, participant_name VARCHAR(160) NOT NULL, participant_phone VARCHAR(40) NULL,
        status ENUM('Pending', 'Attended', 'No Show') NOT NULL DEFAULT 'Pending', payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required',
        participant_email VARCHAR(255) NULL, joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY event_participant_user (event_id, user_id), INDEX (event_id),
        CONSTRAINT participants_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT participants_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_followup_templates (
        event_id INT UNSIGNED NOT NULL, audience ENUM('attended','no_show') NOT NULL,
        subject VARCHAR(180) NOT NULL, body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, audience),
        CONSTRAINT event_followup_templates_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_followup_deliveries (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        participant_id INT UNSIGNED NOT NULL, audience ENUM('attended','no_show') NOT NULL,
        recipient_email VARCHAR(255) NOT NULL, recipient_name VARCHAR(160) NOT NULL,
        status ENUM('pending','sending','sent','failed') NOT NULL DEFAULT 'pending',
        sent_at DATETIME NULL, error_message VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY event_followup_participant_unique (event_id, participant_id),
        INDEX event_followup_queue (event_id, audience, status),
        CONSTRAINT event_followup_deliveries_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_followup_deliveries_participant_fk FOREIGN KEY (participant_id) REFERENCES event_participants(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_ratings (
        event_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, rating TINYINT UNSIGNED NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, user_id), INDEX (event_id, rating),
        CONSTRAINT event_ratings_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_ratings_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_invitations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        manager_id INT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL,
        status ENUM('Pending', 'Accepted', 'Declined') NOT NULL DEFAULT 'Pending',
        token_hash CHAR(64) NOT NULL, token_expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY event_invitation_email (event_id, email),
        CONSTRAINT invitations_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT invitations_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
}
