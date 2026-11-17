export async function initializeOrganizationsSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS organizations (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL, slug VARCHAR(180) NOT NULL UNIQUE,
        description TEXT NULL, website_url VARCHAR(1024) NULL, phone VARCHAR(80) NULL, contact_email VARCHAR(255) NULL,
        default_billing_profile_id INT UNSIGNED NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS organization_members (
        organization_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
        role ENUM('owner','admin','manager','staff') NOT NULL DEFAULT 'staff', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (organization_id, user_id), INDEX organization_members_user (user_id, organization_id),
        CONSTRAINT organization_members_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        CONSTRAINT organization_members_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
}
