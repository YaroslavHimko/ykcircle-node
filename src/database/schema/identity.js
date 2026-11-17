export async function initializeIdentitySchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS users (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
        user_id INT UNSIGNED NOT NULL PRIMARY KEY,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at DATETIME NOT NULL,
        resend_available_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX password_reset_tokens_expiry_index (expires_at),
        CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
}
