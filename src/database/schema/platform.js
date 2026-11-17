import { initializeSubscriptionSchema } from './subscriptions.js';
export async function initializePlatformSchema(database) {
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_billing_settings (
        settings_key VARCHAR(64) NOT NULL PRIMARY KEY, billing_profile_id INT UNSIGNED NULL,
        updated_by_user_id INT UNSIGNED NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT platform_billing_profile_fk FOREIGN KEY (billing_profile_id) REFERENCES billing_profiles(id) ON DELETE RESTRICT,
        CONSTRAINT platform_billing_settings_user_fk FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_products (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, product_type ENUM('subscription','event_fee','featured_listing','other') NOT NULL,
        code VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, description TEXT NULL,
        entitlement_feature VARCHAR(100) NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_prices (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, product_id INT UNSIGNED NOT NULL, currency CHAR(3) NOT NULL,
        amount DECIMAL(12,2) NOT NULL, billing_interval ENUM('month','year') NULL, provider_price_id VARCHAR(255) NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY platform_price_provider (provider_price_id), INDEX platform_price_product (product_id, is_active),
        CONSTRAINT platform_prices_product_fk FOREIGN KEY (product_id) REFERENCES platform_products(id) ON DELETE RESTRICT
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_orders (
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
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_subscriptions (
        trial_end DATETIME NULL,
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, subscriber_user_id INT UNSIGNED NULL, subscriber_organization_id INT UNSIGNED NULL,
        buyer_billing_profile_id INT UNSIGNED NULL, product_id INT UNSIGNED NOT NULL, buyer_capacity ENUM('consumer','business') NOT NULL,
        status ENUM('pending','active','past_due','cancelled','expired','incomplete','incomplete_expired','trialing','unpaid','paused','canceled') NOT NULL DEFAULT 'pending',
        current_period_start DATETIME NULL, current_period_end DATETIME NULL, cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        provider VARCHAR(80) NULL, provider_customer_id VARCHAR(255) NULL, provider_subscription_id VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY platform_subscription_provider (provider, provider_subscription_id), INDEX platform_subscriptions_subscriber (subscriber_user_id, status),
        CONSTRAINT platform_subscriptions_user_fk FOREIGN KEY (subscriber_user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT platform_subscriptions_org_fk FOREIGN KEY (subscriber_organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
        CONSTRAINT platform_subscriptions_profile_fk FOREIGN KEY (buyer_billing_profile_id) REFERENCES billing_profiles(id) ON DELETE SET NULL,
        CONSTRAINT platform_subscriptions_product_fk FOREIGN KEY (product_id) REFERENCES platform_products(id) ON DELETE RESTRICT
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_payments (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id INT UNSIGNED NULL, subscription_id INT UNSIGNED NULL,
        provider VARCHAR(80) NOT NULL, provider_payment_id VARCHAR(255) NULL, provider_invoice_id VARCHAR(255) NULL,
        amount DECIMAL(12,2) NOT NULL, currency CHAR(3) NOT NULL,
        status ENUM('pending','succeeded','failed','refunded','partially_refunded','cancelled') NOT NULL DEFAULT 'pending',
        paid_at DATETIME NULL, refunded_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY platform_payment_provider (provider, provider_payment_id), INDEX platform_payments_order (order_id, created_at),
        CONSTRAINT platform_payments_order_fk FOREIGN KEY (order_id) REFERENCES platform_orders(id) ON DELETE SET NULL,
        CONSTRAINT platform_payments_subscription_fk FOREIGN KEY (subscription_id) REFERENCES platform_subscriptions(id) ON DELETE SET NULL
      )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS platform_entitlements (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id INT UNSIGNED NULL, organization_id INT UNSIGNED NULL,
        event_id INT UNSIGNED NULL, feature VARCHAR(100) NOT NULL, source_type VARCHAR(64) NOT NULL, source_id INT UNSIGNED NULL,
        starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ends_at DATETIME NULL, revoked_at DATETIME NULL,
        INDEX platform_entitlement_lookup (user_id, organization_id, event_id, feature, revoked_at),
        CONSTRAINT platform_entitlements_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT platform_entitlements_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL,
        CONSTRAINT platform_entitlements_event_fk FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
      )`);
  await initializeSubscriptionSchema({ pool: database });
}
