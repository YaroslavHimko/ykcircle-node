import { jsonValue } from '../../../utils/serialization.js';
export class SubscriptionsPlatformRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async platformProducts({ activeOnly = true } = {}) {
    const [rows] = await this.database.execute(
      `SELECT product.id, product.product_type AS productType, product.code, product.name, product.description,
      product.entitlement_feature AS entitlementFeature, product.is_active AS isActive, price.id AS priceId, price.currency, price.amount,
      price.billing_interval AS billingInterval, price.provider_price_id AS providerPriceId FROM platform_products product
      LEFT JOIN platform_prices price ON price.product_id=product.id AND price.is_active=TRUE
      ${activeOnly ? 'WHERE product.is_active=TRUE' : ''} ORDER BY product.id, price.id`,
      [],
    );
    return rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
  }

  async savePlatformProduct(productId, product, actorUserId) {
    if (productId) {
      const [result] = await this.database.execute(
        `UPDATE platform_products SET product_type=?, code=?, name=?, description=?, entitlement_feature=?, is_active=? WHERE id=?`,
        [
          product.productType,
          product.code,
          product.name,
          product.description,
          product.entitlementFeature,
          Boolean(product.isActive),
          productId,
        ],
      );
      if (!result.affectedRows) return null;
      await this.queries.audit(
        actorUserId,
        'platform_product_updated',
        'platform_product',
        productId,
      );
      return { id: productId };
    }
    const [result] = await this.database.execute(
      `INSERT INTO platform_products (product_type, code, name, description, entitlement_feature, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        product.productType,
        product.code,
        product.name,
        product.description,
        product.entitlementFeature,
        Boolean(product.isActive),
      ],
    );
    await this.queries.audit(
      actorUserId,
      'platform_product_created',
      'platform_product',
      result.insertId,
    );
    return { id: result.insertId };
  }

  async savePlatformPrice(productId, price, actorUserId) {
    const [products] = await this.database.execute('SELECT id FROM platform_products WHERE id=?', [
      productId,
    ]);
    if (!products[0]) return null;
    const [result] = await this.database.execute(
      `INSERT INTO platform_prices (product_id, currency, amount, billing_interval, provider_price_id, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        productId,
        price.currency,
        price.amount,
        price.billingInterval,
        price.providerPriceId,
        Boolean(price.isActive),
      ],
    );
    await this.queries.audit(
      actorUserId,
      'platform_price_created',
      'platform_price',
      result.insertId,
      { productId },
    );
    return { id: result.insertId };
  }

  async createPlatformOrder(userId, role, request) {
    if (request.idempotencyKey) {
      const [existing] = await this.database.execute(
        `SELECT id, payment_status AS paymentStatus, currency, total_amount AS totalAmount,
        product_snapshot_json AS productSnapshot FROM platform_orders WHERE buyer_user_id=? AND checkout_idempotency_key=?`,
        [userId, request.idempotencyKey],
      );
      if (existing[0])
        return { ...existing[0], product: jsonValue(existing[0].productSnapshot), reused: true };
    }
    const profile = await this.queries.billingProfile(request.buyerBillingProfileId, userId, role);
    if (!profile) return { error: 'BUYER_PROFILE_UNAVAILABLE' };
    const [rows] = await this.database.execute(
      `SELECT product.id, product.product_type AS productType, product.code, product.name,
      product.entitlement_feature AS entitlementFeature, price.id AS priceId, price.currency, price.amount, price.billing_interval AS billingInterval
      FROM platform_products product JOIN platform_prices price ON price.product_id=product.id WHERE product.id=? AND price.id=? AND product.is_active=TRUE AND price.is_active=TRUE`,
      [request.productId, request.priceId],
    );
    const product = rows[0];
    if (!product || product.productType === 'subscription') return { error: 'PRODUCT_UNAVAILABLE' };
    if (request.eventId && product.productType !== 'event_fee')
      return { error: 'INVALID_PRODUCT_CONTEXT' };
    if (request.eventId) {
      const [events] = await this.database.execute(
        `SELECT id FROM events WHERE id=?${['manager', 'admin'].includes(role) ? '' : ' AND manager_id=?'}`,
        ['manager', 'admin'].includes(role) ? [request.eventId] : [request.eventId, userId],
      );
      if (!events[0]) return { error: 'EVENT_UNAVAILABLE' };
    }
    const snapshot = {
      productType: product.productType,
      code: product.code,
      name: product.name,
      entitlementFeature: product.entitlementFeature,
      priceId: product.priceId,
      amount: product.amount,
      currency: product.currency,
      billingInterval: product.billingInterval,
    };
    const [result] = await this.database.execute(
      `INSERT INTO platform_orders (buyer_user_id, buyer_organization_id, buyer_billing_profile_id, product_id, event_id, buyer_capacity, currency, subtotal, tax_amount, total_amount, checkout_idempotency_key, terms_version, accepted_at, product_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NOW(), ?)`,
      [
        userId,
        profile.ownerOrganizationId || null,
        profile.id,
        product.id,
        request.eventId || null,
        request.buyerCapacity,
        product.currency,
        product.amount,
        product.amount,
        request.idempotencyKey || null,
        request.termsVersion || null,
        JSON.stringify(snapshot),
      ],
    );
    await this.queries.audit(userId, 'platform_order_created', 'platform_order', result.insertId, {
      productId: product.id,
      eventId: request.eventId || null,
    });
    return {
      id: result.insertId,
      paymentStatus: 'pending',
      currency: product.currency,
      totalAmount: Number(product.amount),
      product: snapshot,
    };
  }

  async platformOrderForBuyer(orderId, userId, role) {
    const [rows] = await this.database.execute(
      `SELECT order_row.id, order_row.buyer_user_id AS buyerUserId, order_row.buyer_organization_id AS buyerOrganizationId,
      order_row.buyer_billing_profile_id AS buyerBillingProfileId, order_row.product_id AS productId, order_row.event_id AS eventId,
      order_row.buyer_capacity AS buyerCapacity, order_row.currency, order_row.subtotal, order_row.tax_amount AS taxAmount,
      order_row.total_amount AS totalAmount, order_row.payment_status AS paymentStatus, order_row.provider, order_row.provider_payment_id AS providerPaymentId,
      order_row.invoice_id AS invoiceId, order_row.product_snapshot_json AS productSnapshot, price.provider_price_id AS providerPriceId
      FROM platform_orders order_row JOIN platform_prices price ON price.id=JSON_UNQUOTE(JSON_EXTRACT(order_row.product_snapshot_json, '$.priceId'))
      WHERE order_row.id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : 'order_row.buyer_user_id=?'})`,
      ['manager', 'admin'].includes(role) ? [orderId] : [orderId, userId],
    );
    return rows[0] ? { ...rows[0], product: jsonValue(rows[0].productSnapshot) } : null;
  }

  async attachPlatformProviderPayment(orderId, provider, providerPaymentId) {
    const [orders] = await this.database.execute(
      `SELECT id, currency, total_amount AS totalAmount FROM platform_orders WHERE id=? AND payment_status='pending'`,
      [orderId],
    );
    if (!orders[0]) return false;
    await this.database.execute(
      `UPDATE platform_orders SET provider=?, provider_payment_id=? WHERE id=? AND payment_status='pending'`,
      [provider, providerPaymentId, orderId],
    );
    await this.database.execute(
      `INSERT INTO platform_payments (order_id, provider, provider_payment_id, amount, currency, status)
      VALUES (?, ?, ?, ?, ?, 'pending') ON DUPLICATE KEY UPDATE order_id=VALUES(order_id)`,
      [orderId, provider, providerPaymentId, orders[0].totalAmount, orders[0].currency],
    );
    return true;
  }

  async issuePlatformOrderInvoice(connection, order) {
    if (order.invoiceId) return order.invoiceId;
    const [sellers] =
      await connection.execute(`SELECT profile.id, profile.owner_organization_id AS ownerOrganizationId, profile.legal_name AS legalName,
      profile.organization_number AS organizationNumber, profile.vat_number AS vatNumber, profile.address_line_1 AS addressLine1,
      profile.address_line_2 AS addressLine2, profile.postal_code AS postalCode, profile.city, profile.country, profile.billing_email AS billingEmail,
      profile.invoice_prefix AS invoicePrefix, profile.invoice_due_days AS invoiceDueDays, profile.payment_instructions AS paymentInstructions
      FROM platform_billing_settings settings JOIN billing_profiles profile ON profile.id=settings.billing_profile_id
      WHERE settings.settings_key='platform' AND profile.is_active=TRUE FOR UPDATE`);
    const seller = sellers[0];
    if (!seller) throw new Error('Platform billing profile is not configured.');
    const [buyers] = await connection.execute(
      `SELECT id, owner_organization_id AS ownerOrganizationId, profile_type AS profileType, legal_name AS legalName,
      organization_number AS organizationNumber, vat_number AS vatNumber, address_line_1 AS addressLine1, address_line_2 AS addressLine2,
      postal_code AS postalCode, city, country, billing_email AS billingEmail, phone FROM billing_profiles WHERE id=? FOR UPDATE`,
      [order.buyerBillingProfileId],
    );
    const buyer = buyers[0];
    if (!buyer) throw new Error('Platform order buyer snapshot is unavailable.');
    const allocation = await this.queries.allocateInvoiceNumber(
      connection,
      seller.id,
      seller.invoicePrefix,
    );
    const product = jsonValue(order.productSnapshot) || {};
    const contextType =
      product.productType === 'subscription'
        ? 'platform_subscription'
        : product.productType === 'event_fee'
          ? 'platform_event_fee'
          : 'platform_service';
    const sellerSnapshot = {
      legalName: seller.legalName,
      organizationNumber: seller.organizationNumber,
      vatNumber: seller.vatNumber,
      addressLine1: seller.addressLine1,
      addressLine2: seller.addressLine2,
      postalCode: seller.postalCode,
      city: seller.city,
      country: seller.country,
      billingEmail: seller.billingEmail,
    };
    const transactionSnapshot = {
      product,
      eventId: order.eventId,
      buyerCapacity: order.buyerCapacity,
    };
    const [invoice] = await connection.execute(
      `INSERT INTO invoices (seller_organization_id, seller_billing_profile_id, buyer_user_id, buyer_organization_id, buyer_billing_profile_id, context_type, context_id, invoice_series_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total_amount, seller_snapshot_json, buyer_snapshot_json, booking_snapshot_json, tax_snapshot_json, payment_instructions_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seller.ownerOrganizationId,
        seller.id,
        order.buyerUserId,
        order.buyerOrganizationId || buyer.ownerOrganizationId || null,
        buyer.id,
        contextType,
        String(order.id),
        allocation.seriesId,
        allocation.invoiceNumber,
        seller.invoiceDueDays,
        order.currency,
        order.subtotal,
        order.taxAmount,
        order.totalAmount,
        JSON.stringify(sellerSnapshot),
        JSON.stringify(buyer),
        JSON.stringify(transactionSnapshot),
        JSON.stringify({ treatment: 'not_calculated', amount: order.taxAmount }),
        JSON.stringify({ text: seller.paymentInstructions }),
      ],
    );
    await connection.execute(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, tax_rate, subtotal, tax_amount, total) VALUES (?, ?, 1, 'service', ?, 0, ?, ?, ?)`,
      [
        invoice.insertId,
        product.name || 'YKCircle service',
        order.subtotal,
        order.subtotal,
        order.taxAmount,
        order.totalAmount,
      ],
    );
    await connection.execute(
      `INSERT INTO invoice_history (invoice_id, action, new_status, metadata_json) VALUES (?, 'issued', 'issued', ?)`,
      [invoice.insertId, JSON.stringify({ contextType, platformOrderId: order.id })],
    );
    await connection.execute('UPDATE platform_orders SET invoice_id=? WHERE id=?', [
      invoice.insertId,
      order.id,
    ]);
    return invoice.insertId;
  }

  async setPlatformBillingProfile(billingProfileId, actorUserId) {
    const [profiles] = await this.database.execute(
      'SELECT id FROM billing_profiles WHERE id=? AND is_active=TRUE',
      [billingProfileId],
    );
    if (!profiles[0]) return false;
    await this.database.execute(
      `INSERT INTO platform_billing_settings (settings_key, billing_profile_id, updated_by_user_id) VALUES ('platform', ?, ?)
      ON DUPLICATE KEY UPDATE billing_profile_id=VALUES(billing_profile_id), updated_by_user_id=VALUES(updated_by_user_id)`,
      [billingProfileId, actorUserId],
    );
    await this.queries.audit(
      actorUserId,
      'platform_billing_profile_changed',
      'billing_profile',
      billingProfileId,
    );
    return true;
  }

  async platformBillingProfileReady() {
    const [rows] = await this.database
      .execute(`SELECT profile.id FROM platform_billing_settings settings JOIN billing_profiles profile ON profile.id=settings.billing_profile_id
      WHERE settings.settings_key='platform' AND profile.is_active=TRUE`);
    return Boolean(rows[0]);
  }

  async hasPlatformEntitlement({ userId, organizationId = null, feature, eventId = null }) {
    const [rows] = await this.database.execute(
      `SELECT id FROM platform_entitlements WHERE feature=? AND revoked_at IS NULL AND starts_at<=NOW()
      AND (ends_at IS NULL OR ends_at>NOW()) AND (event_id IS NULL OR event_id=?) AND ((? IS NULL AND user_id=? AND organization_id IS NULL) OR (? IS NOT NULL AND organization_id=? AND user_id IS NULL)) LIMIT 1`,
      [feature, eventId, organizationId, userId, organizationId, organizationId],
    );
    return Boolean(rows[0]);
  }
}
