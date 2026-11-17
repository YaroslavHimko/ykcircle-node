export async function initializeVenueBillingSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_billing_settings (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS venue_payment_settings (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS booking_external_invoices (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS invoice_documents (
        invoice_id INT UNSIGNED NOT NULL PRIMARY KEY,
        pdf_document LONGBLOB NOT NULL,
        pdf_hash CHAR(64) NOT NULL,
        generated_at DATETIME NOT NULL,
        CONSTRAINT invoice_documents_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT
      )`);
}
