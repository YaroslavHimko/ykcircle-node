export async function initializeTicketsSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS event_ticket_types (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, event_id INT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL,
        description TEXT NULL, price DECIMAL(12,2) NOT NULL, currency CHAR(3) NOT NULL, quantity_available INT UNSIGNED NULL,
        quantity_sold INT UNSIGNED NOT NULL DEFAULT 0, sales_start_at DATETIME NULL, sales_end_at DATETIME NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX event_ticket_types_event (event_id, is_active),
        CONSTRAINT event_ticket_types_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS ticket_orders (
        test_mode BOOLEAN NOT NULL DEFAULT FALSE,
        checkout_expires_at DATETIME NULL,
        checkout_key VARCHAR(100) NULL,
        checkout_session_id VARCHAR(255) NULL,
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
  await database.execute(`CREATE TABLE IF NOT EXISTS ticket_order_items (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ticket_order_id INT UNSIGNED NOT NULL, ticket_type_id INT UNSIGNED NULL,
        ticket_type_snapshot_json JSON NOT NULL, quantity INT UNSIGNED NOT NULL, unit_price DECIMAL(12,2) NOT NULL,
        subtotal DECIMAL(12,2) NOT NULL, tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0, total_amount DECIMAL(12,2) NOT NULL,
        CONSTRAINT ticket_order_items_order_fk FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id) ON DELETE RESTRICT,
        CONSTRAINT ticket_order_items_type_fk FOREIGN KEY (ticket_type_id) REFERENCES event_ticket_types(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS issued_tickets (
        checked_in_by_user_id INT UNSIGNED NULL,
        checked_in_at DATETIME NULL,
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ticket_order_id INT UNSIGNED NOT NULL,
        ticket_order_item_id INT UNSIGNED NOT NULL, ordinal INT UNSIGNED NOT NULL,
        code VARCHAR(64) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY ticket_item_ordinal (ticket_order_item_id, ordinal),
        FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id) ON DELETE RESTRICT,
        FOREIGN KEY (ticket_order_item_id) REFERENCES ticket_order_items(id) ON DELETE RESTRICT
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS ticket_email_deliveries (
        ticket_order_id INT UNSIGNED PRIMARY KEY, sent_at DATETIME NULL, attempts INT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_until DATETIME NULL,
        lock_token VARCHAR(64) NULL, last_error VARCHAR(500) NULL,
        FOREIGN KEY (ticket_order_id) REFERENCES ticket_orders(id) ON DELETE RESTRICT
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS payment_provider_events (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(80) NOT NULL, provider_event_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(120) NOT NULL, payload_json JSON NOT NULL, processed_at DATETIME NULL, processing_error TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY payment_provider_event (provider, provider_event_id)
      )`);
}
