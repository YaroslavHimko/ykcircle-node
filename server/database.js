import mysql from 'mysql2/promise';

export class Database {
  constructor(config) {
    this.pool = mysql.createPool({ ...config, timezone: 'Z', waitForConnections: true, connectionLimit: 5 });
    this.initialized = null;
  }

  async initialize() {
    this.initialized ||= (async () => {
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, profile_picture VARCHAR(1024),
        name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL, phone VARCHAR(40) NULL,
        role ENUM('customer', 'organizer', 'manager', 'admin') NOT NULL DEFAULT 'customer',
        isEmailConfirmed BOOLEAN NOT NULL DEFAULT FALSE,
        verification_token_hash CHAR(64) NULL, verification_expires_at DATETIME NULL,
        verification_resend_available_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS contact_submissions (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NULL,
        name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL, contact VARCHAR(120) NULL,
        activity VARCHAR(80) NOT NULL, additional_information TEXT NULL,
        status ENUM('New', 'Approved', 'Contact Again', 'Ordered', 'Declined') NOT NULL DEFAULT 'New',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX (email),
        CONSTRAINT contact_submissions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS events (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, manager_id INT UNSIGNED NOT NULL,
        title VARCHAR(200) NOT NULL, description TEXT NULL, location VARCHAR(255) NULL,
        starts_at DATETIME NOT NULL, ends_at DATETIME NULL, capacity INT UNSIGNED NULL, participation_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
        status ENUM('Draft', 'Published', 'Cancelled', 'Completed', 'Archived') NOT NULL DEFAULT 'Draft',
        visibility ENUM('Public', 'Private') NOT NULL DEFAULT 'Public',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME NULL,
        INDEX (status), INDEX (manager_id),
        CONSTRAINT events_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS application_activities (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(80) NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.pool.execute(`INSERT IGNORE INTO application_activities (name, sort_order) VALUES
        ('Become an Event Organizer', 10), ('Travel Collaboration', 20), ('General Enquiry', 30)`);
      try { await this.pool.execute("ALTER TABLE contact_submissions MODIFY status ENUM('New', 'Approved', 'Contact Again', 'Ordered', 'Declined') NOT NULL DEFAULT 'New'"); } catch (error) { console.error('Application status migration failed:', error.message); throw error; }
      try { await this.pool.execute('ALTER TABLE events ADD COLUMN deleted_at DATETIME NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      try { await this.pool.execute('ALTER TABLE events ADD COLUMN participation_fee DECIMAL(10,2) NOT NULL DEFAULT 0'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      try { await this.pool.execute("ALTER TABLE events MODIFY status ENUM('Draft', 'Published', 'Cancelled', 'Completed', 'Archived') NOT NULL DEFAULT 'Draft'"); } catch (error) { console.error('Event status migration failed:', error.message); throw error; }
      try { await this.pool.execute("ALTER TABLE events MODIFY visibility ENUM('Public', 'Private', 'Members', 'Unlisted') NOT NULL DEFAULT 'Public'"); } catch (error) { console.error('Event visibility migration failed:', error.message); throw error; }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_groups (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, organizer_id INT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL, slug VARCHAR(140) NOT NULL UNIQUE, description TEXT NULL, cover_image VARCHAR(255) NULL,
        visibility ENUM('Public', 'Private') NOT NULL DEFAULT 'Public',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (organizer_id), INDEX (visibility),
        CONSTRAINT event_groups_organizer_fk FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      try { await this.pool.execute('ALTER TABLE event_groups ADD COLUMN cover_image VARCHAR(255) NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_memberships (
        group_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        role ENUM('owner', 'member') NOT NULL DEFAULT 'member', joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
      try { await this.pool.execute('ALTER TABLE events ADD COLUMN group_id INT UNSIGNED NULL, ADD INDEX (group_id)'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_KEYNAME') throw error; }
      try { await this.pool.execute('ALTER TABLE events ADD INDEX events_group_id_idx (group_id)'); } catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
      try { await this.pool.execute('ALTER TABLE events ADD CONSTRAINT events_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE SET NULL'); } catch (error) { if (error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_FK_DUP_NAME' && error.code !== 'ER_CANT_CREATE_TABLE') throw error; }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS group_event_notifications (
        event_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, user_id),
        CONSTRAINT group_event_notifications_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT group_event_notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_registrations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NULL, attendee_name VARCHAR(160) NULL, attendee_email VARCHAR(255) NULL, status ENUM('Pending', 'Confirmed', 'Cancelled', 'Attended', 'Declined', 'Withdrawn') NOT NULL DEFAULT 'Pending', payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required',
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
      const eventMigrations = [
        ['category_id', 'INT UNSIGNED NULL'], ['type_id', 'INT UNSIGNED NULL'], ['cover_image', 'VARCHAR(1024) NULL'],
        ['short_description', 'VARCHAR(240) NULL'], ['country', 'VARCHAR(120) NULL'], ['city', 'VARCHAR(120) NULL'], ['address', 'VARCHAR(255) NULL'],
        ['latitude', 'DECIMAL(10,7) NULL'], ['longitude', 'DECIMAL(10,7) NULL'], ['location_type', "ENUM('physical','online','tba') NOT NULL DEFAULT 'physical'"],
        ['location_visibility', "ENUM('public','registered','attendees_only','approximate') NOT NULL DEFAULT 'public'"],
        ['timezone', "VARCHAR(64) NOT NULL DEFAULT 'UTC'"], ['minimum_attendees', 'INT UNSIGNED NULL'],
        ['registration_deadline', 'DATETIME NULL'], ['minimum_age', 'TINYINT UNSIGNED NULL'], ['language_code', 'VARCHAR(12) NULL'],
        ['what_to_bring', 'TEXT NULL'], ['meeting_instructions', 'TEXT NULL'], ['cancellation_policy', 'TEXT NULL'],
        ['pricing_type', "ENUM('free','paid') NOT NULL DEFAULT 'free'"], ['currency', "CHAR(3) NOT NULL DEFAULT 'SEK'"],
        ['registration_type', "ENUM('yaroko','external','none') NOT NULL DEFAULT 'yaroko'"], ['external_registration_url', 'VARCHAR(1024) NULL'],
        ['published_at', 'DATETIME NULL']
      ];
      for (const [column, definition] of eventMigrations) {
        try { await this.pool.execute(`ALTER TABLE events ADD COLUMN ${column} ${definition}`); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS unsubscribed_emails (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE,
        reason VARCHAR(120) NOT NULL, unsubscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      try { await this.pool.execute("ALTER TABLE event_registrations ADD COLUMN payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required'"); } catch (error) { if (error.code === 'ER_DUP_FIELDNAME') await this.pool.execute("ALTER TABLE event_registrations MODIFY payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required'"); else throw error; }
      try { await this.pool.execute('ALTER TABLE event_registrations ADD COLUMN attendee_phone VARCHAR(40) NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_participants (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        user_id INT UNSIGNED NULL, participant_name VARCHAR(160) NOT NULL,
        status ENUM('Pending', 'Attended', 'No Show') NOT NULL DEFAULT 'Pending', payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required',
        participant_email VARCHAR(255) NULL, joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY event_participant_user (event_id, user_id), INDEX (event_id),
        CONSTRAINT participants_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT participants_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
      try { await this.pool.execute("ALTER TABLE event_participants ADD COLUMN payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required'"); } catch (error) { if (error.code === 'ER_DUP_FIELDNAME') await this.pool.execute("ALTER TABLE event_participants MODIFY payment_status ENUM('Not Required', 'Payment Required', 'Paid') NOT NULL DEFAULT 'Payment Required'"); else throw error; }
      try { await this.pool.execute('ALTER TABLE event_participants ADD COLUMN participant_phone VARCHAR(40) NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS event_invitations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL,
        manager_id INT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL, email VARCHAR(255) NOT NULL,
        status ENUM('Pending', 'Accepted', 'Declined') NOT NULL DEFAULT 'Pending',
        token_hash CHAR(64) NOT NULL, token_expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY event_invitation_email (event_id, email),
        CONSTRAINT invitations_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT invitations_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
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
        group_id INT UNSIGNED NULL, event_id INT UNSIGNED NULL, title VARCHAR(180) NOT NULL, short_description VARCHAR(300) NOT NULL, body TEXT NULL,
        location_name VARCHAR(255) NULL, latitude DECIMAL(10,7) NULL, longitude DECIMAL(10,7) NULL,
        location_radius_km DECIMAL(6,2) NULL, attributes JSON NULL,
        external_event_name VARCHAR(255) NULL, external_event_url VARCHAR(1024) NULL, external_event_at DATETIME NULL,
        visibility ENUM('public','members_only','private') NOT NULL DEFAULT 'public',
        status ENUM('draft','active','fulfilled','expired','archived','removed') NOT NULL DEFAULT 'draft',
        is_indexable BOOLEAN NOT NULL DEFAULT TRUE, expires_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX community_post_public_index (status, visibility, is_indexable, city_slug, category_id, subcategory_id, expires_at),
        INDEX community_post_author_index (author_user_id, status), INDEX (post_type_id), INDEX (group_id), INDEX (event_id),
        CONSTRAINT community_post_author_fk FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT community_post_type_fk FOREIGN KEY (post_type_id) REFERENCES community_post_types(id),
        CONSTRAINT community_post_category_fk FOREIGN KEY (category_id) REFERENCES community_categories(id),
        CONSTRAINT community_post_subcategory_fk FOREIGN KEY (subcategory_id) REFERENCES community_categories(id),
        CONSTRAINT community_post_group_fk FOREIGN KEY (group_id) REFERENCES event_groups(id) ON DELETE SET NULL,
        CONSTRAINT community_post_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
      )`);
      try { await this.pool.execute('ALTER TABLE community_posts ADD COLUMN event_id INT UNSIGNED NULL, ADD INDEX (event_id), ADD CONSTRAINT community_post_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_DUP_KEYNAME' && error.code !== 'ER_CANT_CREATE_TABLE') throw error; }
      await this.pool.execute(`CREATE TABLE IF NOT EXISTS community_post_events (
        post_id INT UNSIGNED NOT NULL, event_id INT UNSIGNED NOT NULL, position INT UNSIGNED NOT NULL,
        PRIMARY KEY (post_id, event_id), UNIQUE KEY community_post_event_position (post_id, position), INDEX (event_id),
        CONSTRAINT community_post_events_post_fk FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
        CONSTRAINT community_post_events_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`);
      await this.pool.execute('INSERT IGNORE INTO community_post_events (post_id, event_id, position) SELECT id, event_id, 0 FROM community_posts WHERE event_id IS NOT NULL');
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
        scope ENUM('community','group','event') NOT NULL, thread_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, last_read_message_id INT UNSIGNED NOT NULL,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (scope, thread_id, user_id), INDEX (user_id, scope, read_at),
        CONSTRAINT forum_thread_read_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
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
      for (const [column, definition] of [['city', 'VARCHAR(120) NULL'], ['category_id', 'INT UNSIGNED NULL'], ['source_post_id', 'INT UNSIGNED NULL'], ['status', "ENUM('active','archived','removed') NOT NULL DEFAULT 'active'"]]) {
        try { await this.pool.execute(`ALTER TABLE event_groups ADD COLUMN ${column} ${definition}`); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      }
      try { await this.pool.execute("ALTER TABLE group_memberships MODIFY role ENUM('owner', 'moderator', 'member') NOT NULL DEFAULT 'member'"); } catch (error) { console.error('Group membership role migration failed:', error.message); throw error; }
      try { await this.pool.execute("ALTER TABLE group_memberships ADD COLUMN status ENUM('invited', 'active', 'left', 'removed') NOT NULL DEFAULT 'active'"); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
      try { await this.pool.execute('ALTER TABLE event_groups ADD INDEX event_groups_community_index (city, category_id, status)'); } catch (error) { if (error.code !== 'ER_DUP_KEYNAME') throw error; }
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
    })();
    return this.initialized;
  }

  execute(...args) { return this.pool.execute(...args); }
  query(...args) { return this.pool.query(...args); }
  getConnection() { return this.pool.getConnection(); }
  close() { return this.pool.end(); }
}
