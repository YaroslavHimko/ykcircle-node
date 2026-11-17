import crypto from 'node:crypto';
import { utcTimestamp, jsonValue } from '../../../utils/serialization.js';
export class TicketsOrdersRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async managedTicketTypes(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(
      `SELECT id FROM events WHERE id=? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id=?'}`,
      privileged ? [eventId] : [eventId, userId],
    );
    if (!events[0]) return null;
    return this.queries.ticketTypes(eventId);
  }

  async ticketTypes(eventId, { publicOnly = false } = {}) {
    const [rows] = await this.database.execute(
      `SELECT id, event_id AS eventId, name, description, price, currency,
      quantity_available AS quantityAvailable, quantity_sold AS quantitySold, sales_start_at AS salesStartAt, sales_end_at AS salesEndAt,
      (SELECT COALESCE(SUM(item.quantity),0) FROM ticket_order_items item JOIN ticket_orders o ON o.id=item.ticket_order_id
        WHERE item.ticket_type_id=event_ticket_types.id AND o.payment_status='pending') AS quantityReserved,
      is_active AS isActive FROM event_ticket_types WHERE event_id=?${publicOnly ? ' AND is_active=TRUE AND (sales_start_at IS NULL OR sales_start_at<=NOW()) AND (sales_end_at IS NULL OR sales_end_at>=NOW())' : ''} ORDER BY id`,
      [eventId],
    );
    return rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) }));
  }

  async saveTicketType(eventId, userId, role, ticketTypeId, ticketType) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id=?';
    const [events] = await this.database.execute(
      `SELECT id FROM events WHERE id=?${scope}`,
      ['manager', 'admin'].includes(role) ? [eventId] : [eventId, userId],
    );
    if (!events[0]) return null;
    if (ticketTypeId) {
      const [result] = await this.database.execute(
        `UPDATE event_ticket_types SET name=?, description=?, price=?, currency=?, quantity_available=?, sales_start_at=?, sales_end_at=?, is_active=? WHERE id=? AND event_id=?`,
        [
          ticketType.name,
          ticketType.description,
          ticketType.price,
          ticketType.currency,
          ticketType.quantityAvailable,
          ticketType.salesStartAt,
          ticketType.salesEndAt,
          Boolean(ticketType.isActive),
          ticketTypeId,
          eventId,
        ],
      );
      if (!result.affectedRows) return null;
      return { id: ticketTypeId };
    }
    const [result] = await this.database.execute(
      `INSERT INTO event_ticket_types (event_id, name, description, price, currency, quantity_available, sales_start_at, sales_end_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        ticketType.name,
        ticketType.description,
        ticketType.price,
        ticketType.currency,
        ticketType.quantityAvailable,
        ticketType.salesStartAt,
        ticketType.salesEndAt,
        Boolean(ticketType.isActive),
      ],
    );
    return { id: result.insertId };
  }

  async ticketCheckoutContext(eventId, connection = this.database) {
    const [rows] = await connection.execute(
      `SELECT e.id AS eventId, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.currency, e.status, e.visibility,
      s.seller_billing_profile_id AS sellerBillingProfileId, s.payment_account_id AS paymentAccountId, s.seller_capacity AS sellerCapacity,
      s.currency AS paymentCurrency, s.refund_policy_snapshot AS refundPolicy, account.provider, account.provider_account_id AS providerAccountId,
      account.charges_enabled AS chargesEnabled, account.onboarding_status AS onboardingStatus,
      profile.legal_name AS sellerLegalName, profile.organization_number AS sellerOrganizationNumber, profile.vat_number AS sellerVatNumber,
      profile.address_line_1 AS sellerAddressLine1, profile.address_line_2 AS sellerAddressLine2, profile.postal_code AS sellerPostalCode,
      profile.city AS sellerCity, profile.country AS sellerCountry, profile.billing_email AS sellerBillingEmail
      FROM events e JOIN event_payment_settings s ON s.event_id=e.id JOIN payment_accounts account ON account.id=s.payment_account_id
      JOIN billing_profiles profile ON profile.id=s.seller_billing_profile_id WHERE e.id=? AND e.status='Published' AND e.visibility='Public'
      AND e.deleted_at IS NULL AND e.starts_at>NOW() AND e.pricing_type='paid' AND e.registration_type='yaroko'
      AND account.billing_profile_id=profile.id AND profile.is_active=TRUE AND s.payments_enabled=TRUE
      AND s.ticket_sales_enabled=TRUE AND account.charges_enabled=TRUE AND account.onboarding_status='ready'`,
      [eventId],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      ...row,
      chargesEnabled: Boolean(row.chargesEnabled),
      refundPolicy: jsonValue(row.refundPolicy),
      seller: {
        brandName: row.brandName || row.sellerLegalName,
        logoImage: row.logoImage || null,
        legalName: row.sellerLegalName,
        organizationNumber: row.sellerOrganizationNumber,
        vatNumber: row.sellerVatNumber,
        addressLine1: row.sellerAddressLine1,
        addressLine2: row.sellerAddressLine2,
        postalCode: row.sellerPostalCode,
        city: row.sellerCity,
        country: row.sellerCountry,
        billingEmail: row.sellerBillingEmail,
        capacity: row.sellerCapacity,
      },
    };
  }

  async createTicketOrder(eventId, attendee, selections, checkoutKey = null) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      // Serialize reservations for this event, including purchases of different ticket types.
      const [eventRows] = await connection.execute(
        'SELECT id, starts_at AS startsAt FROM events WHERE id=? FOR UPDATE',
        [eventId],
      );
      if (!eventRows[0] || new Date(utcTimestamp(eventRows[0].startsAt)) <= new Date()) {
        await connection.rollback();
        return { error: 'EVENT_UNAVAILABLE' };
      }
      if (checkoutKey) {
        const [existing] = await connection.execute(
          'SELECT id FROM ticket_orders WHERE event_id=? AND attendee_user_id=? AND checkout_key=?',
          [eventId, attendee.userId, checkoutKey],
        );
        if (existing[0]) {
          await connection.commit();
          return this.queries.ticketOrder(existing[0].id, attendee.userId, 'customer');
        }
      }
      const context = await this.queries.ticketCheckoutContext(eventId, connection);
      if (!context) {
        await connection.rollback();
        return { error: 'PAYMENT_SETUP_REQUIRED' };
      }
      const ids = selections.map((selection) => Number(selection.ticketTypeId));
      if (!ids.length || ids.some((id) => !Number.isInteger(id))) {
        await connection.rollback();
        return { error: 'INVALID_TICKETS' };
      }
      const placeholders = ids.map(() => '?').join(',');
      const [types] = await connection.execute(
        `SELECT id, name, description, price, currency, quantity_available AS quantityAvailable,
        quantity_sold AS quantitySold FROM event_ticket_types WHERE event_id=? AND id IN (${placeholders}) AND is_active=TRUE
        AND (sales_start_at IS NULL OR sales_start_at<=NOW()) AND (sales_end_at IS NULL OR sales_end_at>=NOW()) FOR UPDATE`,
        [eventId, ...ids],
      );
      if (types.length !== ids.length || new Set(ids).size !== ids.length) {
        await connection.rollback();
        return { error: 'INVALID_TICKETS' };
      }
      let subtotal = 0;
      const items = [];
      // Pending Checkouts hold stock until Stripe confirms expiry/failure. A browser
      // cancellation alone cannot release stock: that Checkout might still be paid.
      const [reserved] = await connection.execute(
        `SELECT item.ticket_type_id AS ticketTypeId, SUM(item.quantity) AS quantity
        FROM ticket_order_items item JOIN ticket_orders o ON o.id=item.ticket_order_id
        WHERE o.event_id=? AND o.payment_status='pending' GROUP BY item.ticket_type_id`,
        [eventId],
      );
      for (const selection of selections) {
        const type = types.find(
          (candidate) => Number(candidate.id) === Number(selection.ticketTypeId),
        );
        const quantity = Number(selection.quantity);
        const held = Number(
          reserved.find((row) => Number(row.ticketTypeId) === Number(type.id))?.quantity || 0,
        );
        if (
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 20 ||
          (type.quantityAvailable !== null &&
            Number(type.quantitySold) + held + quantity > Number(type.quantityAvailable))
        ) {
          await connection.rollback();
          return { error: 'TICKETS_UNAVAILABLE' };
        }
        if (type.currency !== (context.paymentCurrency || context.currency)) {
          await connection.rollback();
          return { error: 'CURRENCY_MISMATCH' };
        }
        const amount = (Math.round(Number(type.price) * 100) * quantity) / 100;
        subtotal = Math.round((subtotal + amount) * 100) / 100;
        items.push({ type, quantity, amount });
      }
      const orderNumber = `TKT-${new Date().getUTCFullYear()}-${crypto.randomBytes(7).toString('hex').toUpperCase()}`;
      if (subtotal <= 0) {
        await connection.rollback();
        return { error: 'INVALID_TICKETS' };
      }
      const [order] = await connection.execute(
        `INSERT INTO ticket_orders (order_number, event_id, attendee_user_id, attendee_email, seller_billing_profile_id, payment_account_id, currency, subtotal, tax_amount, total_amount, provider, seller_snapshot_json, refund_policy_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          orderNumber,
          eventId,
          attendee.userId || null,
          attendee.email,
          context.sellerBillingProfileId,
          context.paymentAccountId,
          context.paymentCurrency || context.currency,
          subtotal,
          subtotal,
          context.provider,
          JSON.stringify(context.seller),
          context.refundPolicy ? JSON.stringify(context.refundPolicy) : null,
        ],
      );
      await connection.execute('UPDATE ticket_orders SET checkout_key=? WHERE id=?', [
        checkoutKey,
        order.insertId,
      ]);
      for (const item of items)
        await connection.execute(
          `INSERT INTO ticket_order_items (ticket_order_id, ticket_type_id, ticket_type_snapshot_json, quantity, unit_price, subtotal, tax_amount, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [
            order.insertId,
            item.type.id,
            JSON.stringify({
              id: item.type.id,
              name: item.type.name,
              description: item.type.description,
              currency: item.type.currency,
            }),
            item.quantity,
            item.type.price,
            item.amount,
            item.amount,
          ],
        );
      await connection.commit();
      // Do not await the pool read here: finally must release the transaction's
      // connection first, including when all pool slots are serving checkouts.
      return this.queries.ticketOrder(order.insertId, attendee.userId, 'customer');
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async attachTicketProviderPayment(orderId, provider, providerPaymentId) {
    await this.database.execute(
      `UPDATE ticket_orders SET provider=?, provider_payment_id=? WHERE id=? AND payment_status='pending'`,
      [provider, providerPaymentId, orderId],
    );
  }

  async ticketOrder(orderId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT o.id, o.order_number AS orderNumber, o.event_id AS eventId, e.title AS eventTitle,
      o.attendee_user_id AS attendeeUserId, o.attendee_email AS attendeeEmail, o.currency, o.subtotal, o.tax_amount AS taxAmount,
      o.total_amount AS totalAmount, o.payment_status AS paymentStatus, o.provider, o.created_at AS createdAt, o.paid_at AS paidAt,
      o.seller_snapshot_json AS sellerSnapshot, o.refund_policy_snapshot AS refundPolicy, o.test_mode AS testMode
      FROM ticket_orders o LEFT JOIN events e ON e.id=o.event_id LEFT JOIN event_payment_settings settings ON settings.event_id=o.event_id
      LEFT JOIN billing_profiles seller ON seller.id=settings.seller_billing_profile_id
      LEFT JOIN organization_members seller_member ON seller_member.organization_id=seller.owner_organization_id AND seller_member.user_id=?
      WHERE o.id=? AND (${privileged ? 'TRUE' : "o.attendee_user_id=? OR e.manager_id=? OR seller.owner_user_id=? OR seller_member.role IN ('owner','admin','manager')"})`,
      privileged ? [userId, orderId] : [userId, orderId, userId, userId, userId],
    );
    if (!rows[0]) return null;
    const [items] = await this.database.execute(
      `SELECT id, ticket_type_id AS ticketTypeId, ticket_type_snapshot_json AS ticketType,
      quantity, unit_price AS unitPrice, subtotal, tax_amount AS taxAmount, total_amount AS totalAmount FROM ticket_order_items WHERE ticket_order_id=?`,
      [orderId],
    );
    return {
      ...rows[0],
      seller: jsonValue(rows[0].sellerSnapshot),
      refundPolicy: jsonValue(rows[0].refundPolicy),
      items: items.map((item) => ({ ...item, ticketType: jsonValue(item.ticketType) })),
    };
  }

  async ticketOrdersForAttendee(userId) {
    const [rows] = await this.database.execute(
      `SELECT id, order_number AS orderNumber, event_id AS eventId, attendee_email AS attendeeEmail,
      currency, total_amount AS totalAmount, payment_status AS paymentStatus, created_at AS createdAt, paid_at AS paidAt FROM ticket_orders
      WHERE attendee_user_id=? ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  }

  async processTicketProviderEvent({ provider, providerEventId, eventType, payload }) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      try {
        await connection.execute(
          `INSERT INTO payment_provider_events (provider, provider_event_id, event_type, payload_json) VALUES (?, ?, ?, ?)`,
          [provider, providerEventId, eventType, JSON.stringify(payload)],
        );
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          await connection.rollback();
          return { duplicate: true };
        }
        throw error;
      }
      const object = payload?.data?.object || {};
      const metadata = object.metadata || {};
      if (eventType === 'account.updated' && object.id) {
        await connection.execute(
          `UPDATE payment_accounts SET onboarding_status=?, charges_enabled=?, payouts_enabled=?, details_submitted=?
          WHERE provider=? AND provider_account_id=?`,
          [
            object.charges_enabled ? 'ready' : object.details_submitted ? 'restricted' : 'pending',
            Boolean(object.charges_enabled),
            Boolean(object.payouts_enabled),
            object.details_submitted == null ? null : Boolean(object.details_submitted),
            provider,
            object.id,
          ],
        );
        await connection.execute(
          `UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`,
          [provider, providerEventId],
        );
        await connection.commit();
        return { paymentAccount: object.id, processed: true };
      }
      const orderId = Number(metadata.ticketOrderId || metadata.ticket_order_id || 0);
      const platformOrderId = Number(metadata.platformOrderId || metadata.platform_order_id || 0);
      if (platformOrderId) {
        const result = await this.queries.processPlatformProviderEventInTransaction(connection, {
          provider,
          eventType,
          object,
          platformOrderId,
        });
        await connection.execute(
          `UPDATE payment_provider_events SET processed_at=NOW(), processing_error=? WHERE provider=? AND provider_event_id=?`,
          [result.error || null, provider, providerEventId],
        );
        await connection.commit();
        return result;
      }
      if (!orderId) {
        await connection.execute(
          `UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`,
          [provider, providerEventId],
        );
        await connection.commit();
        return { ignored: true };
      }
      const [orders] = await connection.execute(
        `SELECT ticket.id, ticket.payment_status AS paymentStatus, ticket.payment_account_id AS paymentAccountId,
        account.provider_account_id AS providerAccountId FROM ticket_orders ticket JOIN payment_accounts account ON account.id=ticket.payment_account_id
        WHERE ticket.id=? FOR UPDATE`,
        [orderId],
      );
      const order = orders[0];
      if (!order || payload.account !== order.providerAccountId) {
        await connection.execute(
          `UPDATE payment_provider_events SET processing_error=? WHERE provider=? AND provider_event_id=?`,
          ['Ticket order/payment account mismatch', provider, providerEventId],
        );
        await connection.commit();
        return { ignored: true };
      }
      // TicketSales verifies Checkout and commits tickets + delivery together.
      // PaymentIntent notifications alone must never bypass that fulfillment path.
      if (
        ['charge.refunded', 'refund.created', 'refund.updated'].includes(eventType) &&
        ['paid', 'partially_refunded'].includes(order.paymentStatus)
      ) {
        const fullyRefunded =
          object.refunded === true ||
          (object.status === 'succeeded' &&
            Number(object.amount_refunded || 0) >= Number(object.amount || 0));
        await connection.execute(`UPDATE ticket_orders SET payment_status=? WHERE id=?`, [
          fullyRefunded ? 'refunded' : 'partially_refunded',
          orderId,
        ]);
      } else if (eventType.startsWith('charge.dispute.')) {
        await connection.execute(`UPDATE ticket_orders SET payment_status='disputed' WHERE id=?`, [
          orderId,
        ]);
      }
      await connection.execute(
        `UPDATE payment_provider_events SET processed_at=NOW() WHERE provider=? AND provider_event_id=?`,
        [provider, providerEventId],
      );
      await connection.commit();
      return { orderId, processed: true };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async processPlatformProviderEventInTransaction(
    connection,
    { provider, eventType, object, platformOrderId },
  ) {
    const [orders] = await connection.execute(
      `SELECT id, buyer_user_id AS buyerUserId, buyer_organization_id AS buyerOrganizationId,
      buyer_billing_profile_id AS buyerBillingProfileId, product_id AS productId, event_id AS eventId, buyer_capacity AS buyerCapacity,
      currency, subtotal, tax_amount AS taxAmount, total_amount AS totalAmount, payment_status AS paymentStatus, invoice_id AS invoiceId,
      product_snapshot_json AS productSnapshot FROM platform_orders WHERE id=? FOR UPDATE`,
      [platformOrderId],
    );
    const order = orders[0];
    if (!order) return { ignored: true, error: 'Platform order not found' };
    const product = jsonValue(order.productSnapshot) || {};
    if (product.productType === 'subscription')
      return {
        ignored: true,
        error: 'Subscription reconciliation requires the organizer subscription service',
      };
    const paymentId = object.payment_intent || object.id || null;
    const paid =
      ['checkout.session.completed', 'invoice.paid', 'payment_intent.succeeded'].includes(
        eventType,
      ) &&
      (eventType !== 'checkout.session.completed' ||
        object.payment_status === 'paid' ||
        product.productType === 'subscription');
    if (paid && order.paymentStatus === 'pending') {
      await connection.execute(
        `UPDATE platform_orders SET payment_status='paid', provider=?, provider_payment_id=? WHERE id=?`,
        [provider, paymentId, order.id],
      );
      const [updatedPayment] = await connection.execute(
        `UPDATE platform_payments SET provider_payment_id=?, provider_invoice_id=COALESCE(?, provider_invoice_id),
        status='succeeded', paid_at=COALESCE(paid_at, NOW()) WHERE order_id=? AND provider=?`,
        [paymentId, object.invoice || null, order.id, provider],
      );
      if (!updatedPayment.affectedRows)
        await connection.execute(
          `INSERT INTO platform_payments (order_id, provider, provider_payment_id, provider_invoice_id, amount, currency, status, paid_at)
        VALUES (?, ?, ?, ?, ?, ?, 'succeeded', NOW())`,
          [
            order.id,
            provider,
            paymentId,
            object.invoice || null,
            order.totalAmount,
            order.currency,
          ],
        );
      const invoiceId = await this.queries.issuePlatformOrderInvoice(connection, order);
      const sourceType = 'platform_order';
      const sourceId = order.id;
      if (product.entitlementFeature)
        await connection.execute(
          `INSERT INTO platform_entitlements (user_id, organization_id, event_id, feature, source_type, source_id)
        SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM platform_entitlements WHERE source_type=? AND source_id=? AND feature=? AND revoked_at IS NULL)`,
          [
            order.buyerUserId,
            order.buyerOrganizationId,
            order.eventId,
            product.entitlementFeature,
            sourceType,
            sourceId,
            sourceType,
            sourceId,
            product.entitlementFeature,
          ],
        );
      return { platformOrderId: order.id, invoiceId, processed: true };
    }
    if (
      [
        'checkout.session.expired',
        'payment_intent.payment_failed',
        'invoice.payment_failed',
      ].includes(eventType) &&
      order.paymentStatus === 'pending'
    ) {
      await connection.execute(`UPDATE platform_orders SET payment_status='failed' WHERE id=?`, [
        order.id,
      ]);
      await connection.execute(
        `INSERT INTO platform_payments (order_id, provider, provider_payment_id, amount, currency, status)
        VALUES (?, ?, ?, ?, ?, 'failed') ON DUPLICATE KEY UPDATE status='failed'`,
        [order.id, provider, paymentId, order.totalAmount, order.currency],
      );
    } else if (
      ['charge.refunded', 'refund.created', 'refund.updated'].includes(eventType) &&
      order.paymentStatus === 'paid'
    ) {
      await connection.execute(`UPDATE platform_orders SET payment_status='refunded' WHERE id=?`, [
        order.id,
      ]);
      await connection.execute(
        `UPDATE platform_payments SET status='refunded', refunded_at=NOW() WHERE order_id=?`,
        [order.id],
      );
      await connection.execute(
        `UPDATE platform_entitlements SET revoked_at=NOW() WHERE source_type='platform_order' AND source_id=? AND revoked_at IS NULL`,
        [order.id],
      );
    }
    return { platformOrderId: order.id, processed: true };
  }

  async ticketRefundContext(orderId, userId, role) {
    const [rows] = await this.database.execute(
      `SELECT ticket.id, ticket.payment_status AS paymentStatus, ticket.provider, ticket.provider_payment_id AS providerPaymentId,
      ticket.total_amount AS totalAmount, ticket.currency, account.provider_account_id AS providerAccountId
      FROM ticket_orders ticket JOIN events event_row ON event_row.id=ticket.event_id JOIN payment_accounts account ON account.id=ticket.payment_account_id
      LEFT JOIN billing_profiles seller ON seller.id=ticket.seller_billing_profile_id
      LEFT JOIN organization_members member ON member.organization_id=seller.owner_organization_id AND member.user_id=?
      WHERE ticket.id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "event_row.manager_id=? OR seller.owner_user_id=? OR member.role IN ('owner','admin','manager')"})`,
      ['manager', 'admin'].includes(role) ? [userId, orderId] : [userId, orderId, userId, userId],
    );
    return rows[0] || null;
  }
}
