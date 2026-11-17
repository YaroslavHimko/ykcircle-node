export async function initializeBillingSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS billing_profiles (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS payment_accounts (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, billing_profile_id INT UNSIGNED NOT NULL, provider VARCHAR(80) NOT NULL,
        provider_account_id VARCHAR(255) NULL, onboarding_status ENUM('not_started','pending','restricted','ready','disabled') NOT NULL DEFAULT 'not_started',
        charges_enabled BOOLEAN NOT NULL DEFAULT FALSE, payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        details_submitted BOOLEAN NULL, country VARCHAR(120) NULL, default_currency CHAR(3) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY payment_account_provider (provider, provider_account_id), INDEX payment_accounts_profile (billing_profile_id),
        CONSTRAINT payment_accounts_profile_fk FOREIGN KEY (billing_profile_id) REFERENCES billing_profiles(id) ON DELETE RESTRICT
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS event_payment_settings (
        event_id INT UNSIGNED NOT NULL PRIMARY KEY, seller_billing_profile_id INT UNSIGNED NULL, payment_account_id INT UNSIGNED NULL,
        seller_capacity ENUM('trader','private') NULL, currency CHAR(3) NULL, payments_enabled BOOLEAN NOT NULL DEFAULT FALSE, ticket_sales_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        refund_policy_snapshot JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT event_payment_settings_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        CONSTRAINT event_payment_settings_seller_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT event_payment_settings_account_fk FOREIGN KEY (payment_account_id) REFERENCES payment_accounts(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS invoices (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS invoice_items (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED NOT NULL, description VARCHAR(500) NOT NULL,
        quantity DECIMAL(12,3) NOT NULL, unit VARCHAR(40) NOT NULL, unit_price DECIMAL(12,2) NOT NULL, tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
        subtotal DECIMAL(12,2) NOT NULL, tax_amount DECIMAL(12,2) NOT NULL, total DECIMAL(12,2) NOT NULL,
        CONSTRAINT invoice_items_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS invoice_history (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED NOT NULL, action VARCHAR(40) NOT NULL,
        previous_status VARCHAR(20) NULL, new_status VARCHAR(20) NULL, performed_by_user_id INT UNSIGNED NULL,
        metadata_json JSON NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX invoice_history_invoice (invoice_id, created_at),
        CONSTRAINT invoice_history_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
        CONSTRAINT invoice_history_user_fk FOREIGN KEY (performed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS payments (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id INT UNSIGNED NOT NULL, booking_id INT UNSIGNED NULL,
        provider VARCHAR(80) NOT NULL, provider_payment_id VARCHAR(255) NULL, status ENUM('pending','requires_action','succeeded','failed','cancelled') NOT NULL,
        currency CHAR(3) NOT NULL, amount DECIMAL(12,2) NOT NULL, payment_method_type VARCHAR(40) NULL,
        payment_method_brand VARCHAR(80) NULL, payment_method_last4 CHAR(4) NULL, metadata_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, authorized_at DATETIME NULL, paid_at DATETIME NULL, failed_at DATETIME NULL, cancelled_at DATETIME NULL,
        INDEX payments_invoice (invoice_id, created_at),
        CONSTRAINT payments_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
        CONSTRAINT payments_booking_fk FOREIGN KEY (booking_id) REFERENCES venue_bookings(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS invoice_series (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, seller_billing_profile_id INT UNSIGNED NOT NULL,
        prefix VARCHAR(20) NOT NULL, year SMALLINT UNSIGNED NOT NULL, next_number INT UNSIGNED NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY invoice_series_seller_year (seller_billing_profile_id, year),
        CONSTRAINT invoice_series_seller_fk FOREIGN KEY (seller_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE RESTRICT
      )`);
}
