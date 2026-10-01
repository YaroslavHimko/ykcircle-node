export async function initializeSubscriptionSchema(database) {
  const pool = database.pool;
  await pool.execute(`CREATE TABLE IF NOT EXISTS product_configuration (
    id TINYINT UNSIGNED PRIMARY KEY, settings_json JSON NOT NULL, updated_by_user_id INT UNSIGNED NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.execute(`INSERT IGNORE INTO product_configuration (id, settings_json) VALUES (1, '{"subscriptionsEnabled":false,"paidEventsEnabled":false,"paidVenuesEnabled":false}')`);
  await database.ensureColumn('events', 'organizer_organization_id', 'INT UNSIGNED NULL');
  await database.ensureColumn('platform_subscriptions', 'trial_end', 'DATETIME NULL');
  // Keep historic spellings while accepting every canonical Stripe state.
  const [columns] = await pool.execute("SHOW COLUMNS FROM platform_subscriptions LIKE 'status'");
  if (!columns[0].Type.includes("'trialing'")) await pool.execute(`ALTER TABLE platform_subscriptions MODIFY status ENUM('pending','active','past_due','cancelled','expired','incomplete','incomplete_expired','trialing','unpaid','paused','canceled') NOT NULL DEFAULT 'pending'`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS subscription_customers (
    owner_key VARCHAR(80) PRIMARY KEY, owner_type ENUM('user','organization') NOT NULL, owner_id INT UNSIGNED NOT NULL,
    provider_customer_id VARCHAR(255) NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await pool.execute(`CREATE TABLE IF NOT EXISTS subscription_checkouts (
    id CHAR(36) PRIMARY KEY, owner_key VARCHAR(80) NOT NULL, actor_user_id INT UNSIGNED NOT NULL,
    billing_profile_id INT UNSIGNED NOT NULL, product_id INT UNSIGNED NOT NULL, price_id INT UNSIGNED NOT NULL,
    provider_price_id VARCHAR(255) NOT NULL, session_id VARCHAR(255) NULL UNIQUE, subscription_id VARCHAR(255) NULL UNIQUE,
    return_path VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX subscription_checkout_owner (owner_key, created_at),
    CONSTRAINT subscription_checkout_customer_fk FOREIGN KEY (owner_key) REFERENCES subscription_customers(owner_key))`);
  await database.ensureColumn('subscription_checkouts', 'feature', "VARCHAR(100) NOT NULL DEFAULT 'organizer.publish_event'");
  await pool.execute(`CREATE TABLE IF NOT EXISTS subscription_invoices (
    provider_invoice_id VARCHAR(255) PRIMARY KEY, subscription_id INT UNSIGNED NOT NULL, status VARCHAR(40) NOT NULL,
    currency CHAR(3) NOT NULL, amount_due BIGINT NOT NULL, amount_paid BIGINT NOT NULL, hosted_invoice_url TEXT NULL,
    invoice_pdf_url TEXT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT subscription_invoice_subscription_fk FOREIGN KEY (subscription_id) REFERENCES platform_subscriptions(id))`);
}
