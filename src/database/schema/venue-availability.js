export async function initializeVenueAvailabilitySchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_availability_rules (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL,
        day_of_week TINYINT UNSIGNED NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY venue_availability_rule (venue_id, day_of_week, start_time, end_time),
        INDEX venue_availability_rules_day (venue_id, day_of_week),
        CONSTRAINT venue_availability_rules_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_availability_overrides (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL, date DATE NOT NULL,
        override_type ENUM('closed','custom') NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY venue_availability_override (venue_id, date),
        CONSTRAINT venue_availability_overrides_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_availability_override_windows (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, override_id INT UNSIGNED NOT NULL,
        start_time TIME NOT NULL, end_time TIME NOT NULL,
        UNIQUE KEY venue_availability_override_window (override_id, start_time, end_time),
        CONSTRAINT venue_availability_override_windows_override_fk FOREIGN KEY (override_id) REFERENCES venue_availability_overrides(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_availability_blocks (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL,
        start_at DATETIME NOT NULL, end_at DATETIME NOT NULL, reason TEXT NULL, created_by_user_id INT UNSIGNED NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_availability_blocks_range (venue_id, start_at, end_at),
        CONSTRAINT venue_availability_blocks_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
        CONSTRAINT venue_availability_blocks_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_external_reservations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, venue_id INT UNSIGNED NOT NULL,
        start_at DATETIME NOT NULL, end_at DATETIME NOT NULL,
        source ENUM('external','internal','phone','email','other_platform','other') NOT NULL DEFAULT 'external',
        title VARCHAR(255) NULL, notes TEXT NULL, created_by_user_id INT UNSIGNED NULL, cancelled_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX venue_external_reservations_range (venue_id, cancelled_at, start_at, end_at),
        CONSTRAINT venue_external_reservations_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
        CONSTRAINT venue_external_reservations_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_booking_settings (
        venue_id INT UNSIGNED NOT NULL PRIMARY KEY, booking_mode ENUM('hourly','daily','both','inquiry_only') NOT NULL DEFAULT 'hourly',
        slot_increment_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30, minimum_booking_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        maximum_booking_minutes SMALLINT UNSIGNED NULL, buffer_before_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        buffer_after_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0, minimum_notice_hours SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        maximum_advance_days SMALLINT UNSIGNED NOT NULL DEFAULT 365, currency CHAR(3) NOT NULL DEFAULT 'SEK',
        hourly_rate DECIMAL(12,2) NULL, daily_rate DECIMAL(12,2) NULL, invoice_due_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT venue_booking_settings_venue_fk FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      )`);
}
