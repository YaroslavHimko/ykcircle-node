import {
  calculateVenueBookingPrice,
  venueFinancialReadiness as evaluateVenueFinancialReadiness,
} from '../../../domain/venues/venue-finance.js';
import { utcTimestamp, jsonValue } from '../../../utils/serialization.js';
export class VenuesBookingFinanceRepository {
  constructor({ database, queries, productAccess }) {
    this.database = database;
    this.queries = queries;
    this.productAccess = productAccess;
  }
  async venueBookingFinancialContext(bookingId, executor = this.database, { lock = false } = {}) {
    const [rows] = await executor.execute(
      `SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId,
      b.buyer_billing_profile_id AS buyerBillingProfileId, b.booking_type AS bookingType, b.booking_date AS bookingDate,
      b.start_at AS startAt, b.end_at AS endAt, b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt,
      b.venue_timezone AS venueTimezone, b.status, b.currency, b.subtotal AS storedSubtotal,
      v.organization_id AS sellerOrganizationId, v.owner_user_id AS sellerOwnerUserId,
      v.name AS venueName, v.business_name AS venueBrandName, v.logo_image AS venueLogoImage, v.formatted_address AS venueAddress, v.price_from AS fallbackRate,
      organization.default_billing_profile_id AS organizationDefaultBillingProfileId, organization.name AS organizationName,
      event.title AS eventTitle, booking.hourly_rate AS hourlyRate, booking.daily_rate AS dailyRate,
      COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode,
      COALESCE(finance.seller_billing_profile_id, v.billing_profile_id, organization.default_billing_profile_id) AS sellerBillingProfileId,
      COALESCE(finance.payment_terms_days, booking.invoice_due_days, 30) AS paymentTermsDays,
      COALESCE(finance.tax_mode, 'no_tax') AS taxMode, finance.default_tax_rate AS defaultTaxRate,
      COALESCE(finance.prices_include_tax, FALSE) AS pricesIncludeTax,
      COALESCE(finance.confirmation_policy, 'on_owner_approval') AS confirmationPolicy,
      finance.accepted_terms_version AS acceptedTermsVersion, finance.accepted_at AS acceptedAt,
      finance.accepted_by_user_id AS acceptedByUserId,
      payment.methods_json AS methods, payment.bankgiro, payment.plusgiro, payment.iban, payment.bic,
      payment.swish_number AS swishNumber, payment.bank_name AS bankName, payment.account_details_text AS accountDetailsText,
      payment.additional_instructions AS additionalInstructions, COALESCE(payment.payment_reference_mode, 'invoice_number') AS paymentReferenceMode
      FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
      LEFT JOIN organizations organization ON organization.id=v.organization_id
      LEFT JOIN events event ON event.id=b.event_id
      JOIN venue_booking_settings booking ON booking.venue_id=v.id
      LEFT JOIN venue_billing_settings finance ON finance.venue_id=v.id
      LEFT JOIN venue_payment_settings payment ON payment.venue_id=v.id
      WHERE b.id=?${lock ? ' FOR UPDATE' : ''}`,
      [bookingId],
    );
    if (!rows[0]) return null;
    const context = {
      ...rows[0],
      methods: jsonValue(rows[0].methods) || [],
      pricesIncludeTax: Boolean(rows[0].pricesIncludeTax),
    };
    const [sellers] = context.sellerBillingProfileId
      ? await executor.execute(
          `SELECT ${this.queries.billingProfileColumns('p')} FROM billing_profiles p WHERE p.id=?`,
          [context.sellerBillingProfileId],
        )
      : [[]];
    const [buyers] = context.buyerBillingProfileId
      ? await executor.execute(
          `SELECT ${this.queries.billingProfileColumns('p')} FROM billing_profiles p WHERE p.id=?`,
          [context.buyerBillingProfileId],
        )
      : [[]];
    context.seller = sellers[0] ? { ...sellers[0], isActive: Boolean(sellers[0].isActive) } : null;
    context.buyer = buyers[0] ? { ...buyers[0], isActive: Boolean(buyers[0].isActive) } : null;
    return context;
  }

  async calculateVenueBookingPrice(bookingId, executor = this.database) {
    const context = await this.queries.venueBookingFinancialContext(bookingId, executor);
    if (!context) return null;
    return calculateVenueBookingPrice({
      bookingType: context.bookingType,
      startAt: context.startAt,
      endAt: context.endAt,
      hourlyRate: context.hourlyRate,
      dailyRate: context.dailyRate,
      fallbackRate: context.fallbackRate,
      currency: context.currency,
      taxMode: context.taxMode,
      defaultTaxRate: context.defaultTaxRate,
      pricesIncludeTax: context.pricesIncludeTax,
      venueName: context.venueName,
    });
  }

  async getVenueBookingBillingReadiness(bookingId) {
    const context = await this.queries.venueBookingFinancialContext(bookingId);
    if (!context) return null;
    const price = calculateVenueBookingPrice({
      bookingType: context.bookingType,
      startAt: context.startAt,
      endAt: context.endAt,
      hourlyRate: context.hourlyRate,
      dailyRate: context.dailyRate,
      fallbackRate: context.fallbackRate,
      currency: context.currency,
      taxMode: context.taxMode,
      defaultTaxRate: context.defaultTaxRate,
      pricesIncludeTax: context.pricesIncludeTax,
      venueName: context.venueName,
    });
    const isInvoiceRequired = !price?.error && price.total > 0;
    const buyerBillingProfileReady =
      !isInvoiceRequired ||
      Boolean(
        context.buyer?.isActive &&
        context.buyer.legalName &&
        context.buyer.addressLine1 &&
        context.buyer.postalCode &&
        context.buyer.city &&
        context.buyer.country &&
        context.buyer.billingEmail,
      );
    const seller =
      context.seller &&
      Number(context.seller.ownerOrganizationId) === Number(context.sellerOrganizationId)
        ? context.seller
        : null;
    const venueReadiness = evaluateVenueFinancialReadiness(context, seller, context);
    const priceReady = !price?.error;
    return {
      bookingId,
      invoiceMode: context.invoiceMode,
      isInvoiceRequired,
      buyerBillingProfileReady,
      priceReady,
      price: priceReady ? price : null,
      priceError: price?.error || null,
      venue: venueReadiness,
      canApprove:
        !isInvoiceRequired ||
        (buyerBillingProfileReady &&
          priceReady &&
          (context.invoiceMode === 'external' || venueReadiness.canIssueInvoice)),
    };
  }

  async ensureVenueBookingInvoice(bookingId, issuedByUserId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const context = await this.queries.venueBookingFinancialContext(bookingId, connection, {
        lock: true,
      });
      if (!context || context.status !== 'confirmed') {
        await connection.rollback();
        return { error: 'BOOKING_NOT_CONFIRMED' };
      }
      const price = calculateVenueBookingPrice({
        bookingType: context.bookingType,
        startAt: context.startAt,
        endAt: context.endAt,
        hourlyRate: context.hourlyRate,
        dailyRate: context.dailyRate,
        fallbackRate: context.fallbackRate,
        currency: context.currency,
        taxMode: context.taxMode,
        defaultTaxRate: context.defaultTaxRate,
        pricesIncludeTax: context.pricesIncludeTax,
        venueName: context.venueName,
      });
      if (price?.error) {
        await connection.rollback();
        return { error: price.error };
      }
      if (price.total <= 0) {
        await connection.execute(
          "UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='not_required', invoice_generation_error=NULL WHERE id=?",
          [bookingId],
        );
        await connection.commit();
        return { invoiceId: null, invoiceMode: context.invoiceMode, paymentStatus: 'not_required' };
      }
      if (context.invoiceMode === 'external') {
        const [existing] = await connection.execute(
          'SELECT id FROM booking_external_invoices WHERE booking_id=? FOR UPDATE',
          [bookingId],
        );
        let externalInvoiceId = existing[0]?.id;
        if (!externalInvoiceId) {
          const [created] = await connection.execute(
            `INSERT INTO booking_external_invoices (booking_id, amount, currency, status)
            VALUES (?, ?, ?, 'awaiting_invoice')`,
            [bookingId, price.total, price.currency],
          );
          externalInvoiceId = created.insertId;
        }
        await connection.execute(
          "UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL WHERE id=?",
          [bookingId],
        );
        await connection.commit();
        return {
          invoiceId: null,
          externalInvoiceId,
          invoiceMode: 'external',
          paymentStatus: 'unpaid',
        };
      }
      const seller =
        context.seller &&
        Number(context.seller.ownerOrganizationId) === Number(context.sellerOrganizationId)
          ? context.seller
          : null;
      const readiness = evaluateVenueFinancialReadiness(context, seller, context);
      if (!readiness.canIssueInvoice) {
        await connection.rollback();
        return { error: 'FINANCIAL_SETUP_INCOMPLETE', missing: readiness.missing };
      }
      if (!context.buyer?.isActive) {
        await connection.rollback();
        return { error: 'BUYER_PROFILE_INCOMPLETE' };
      }
      const [existing] = await connection.execute(
        'SELECT id FROM invoices WHERE booking_id=? FOR UPDATE',
        [bookingId],
      );
      if (existing[0]) {
        await connection.execute(
          "UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL WHERE id=?",
          [bookingId],
        );
        await connection.commit();
        return {
          invoiceId: existing[0].id,
          invoiceMode: 'ykcircle',
          paymentStatus: 'invoice_open',
        };
      }
      const allocation = await this.queries.allocateInvoiceNumber(
        connection,
        seller.id,
        seller.invoicePrefix,
      );
      const sellerSnapshot = {
        brandName: context.venueBrandName || context.venueName || seller.legalName,
        logoImage: context.venueLogoImage || null,
        legalName: seller.legalName,
        organizationNumber: seller.organizationNumber,
        vatNumber: seller.vatNumber,
        addressLine1: seller.addressLine1,
        addressLine2: seller.addressLine2,
        postalCode: seller.postalCode,
        city: seller.city,
        country: seller.country,
        billingEmail: seller.billingEmail,
        phone: seller.phone,
      };
      const buyerSnapshot = {
        legalName: context.buyer.legalName,
        profileType: context.buyer.profileType,
        organizationNumber: context.buyer.organizationNumber,
        vatNumber: context.buyer.vatNumber,
        addressLine1: context.buyer.addressLine1,
        addressLine2: context.buyer.addressLine2,
        postalCode: context.buyer.postalCode,
        city: context.buyer.city,
        country: context.buyer.country,
        billingEmail: context.buyer.billingEmail,
        phone: context.buyer.phone,
      };
      const bookingSnapshot = {
        venueName: context.venueName,
        venueAddress: context.venueAddress,
        bookingDate: context.bookingDate,
        startsAt: utcTimestamp(context.startAt),
        endsAt: utcTimestamp(context.endAt),
        venueTimezone: context.venueTimezone,
        bookingReference: `VB-${bookingId}`,
        eventId: context.eventId,
        eventTitle: context.eventTitle,
        pricingRuleVersion: price.pricingRuleVersion,
      };
      const paymentInstructions = {
        methods: context.methods,
        bankgiro: context.bankgiro,
        plusgiro: context.plusgiro,
        iban: context.iban,
        bic: context.bic,
        swishNumber: context.swishNumber,
        bankName: context.bankName,
        accountDetailsText: context.accountDetailsText,
        additionalInstructions: context.additionalInstructions,
        referenceMode: context.paymentReferenceMode,
      };
      paymentInstructions.text = [
        context.bankgiro && `Bankgiro: ${context.bankgiro}`,
        context.plusgiro && `Plusgiro: ${context.plusgiro}`,
        context.iban && `IBAN: ${context.iban}`,
        context.bic && `BIC: ${context.bic}`,
        context.swishNumber && `Swish: ${context.swishNumber}`,
        context.bankName,
        context.accountDetailsText,
        context.additionalInstructions,
        `Reference: ${allocation.invoiceNumber}`,
      ]
        .filter(Boolean)
        .join('\n');
      const [invoice] = await connection.execute(
        `INSERT INTO invoices (seller_organization_id, seller_billing_profile_id, buyer_user_id, buyer_organization_id, buyer_billing_profile_id,
        booking_id, context_type, context_id, invoice_series_id, invoice_number, status, delivery_status, issue_date, due_date, currency, subtotal, tax_amount, total_amount,
        seller_snapshot_json, buyer_snapshot_json, booking_snapshot_json, tax_snapshot_json, payment_instructions_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, 'venue_booking', ?, ?, ?, 'issued', 'pending', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.sellerOrganizationId,
          seller.id,
          context.organizerUserId,
          context.buyer.ownerOrganizationId,
          context.buyer.id,
          bookingId,
          String(bookingId),
          allocation.seriesId,
          allocation.invoiceNumber,
          context.paymentTermsDays,
          price.currency,
          price.subtotal,
          price.taxAmount,
          price.total,
          JSON.stringify(sellerSnapshot),
          JSON.stringify(buyerSnapshot),
          JSON.stringify(bookingSnapshot),
          JSON.stringify({
            mode: context.taxMode,
            rate: price.lineItems[0].taxRate,
            pricesIncludeTax: context.pricesIncludeTax,
          }),
          JSON.stringify(paymentInstructions),
        ],
      );
      for (const item of price.lineItems)
        await connection.execute(
          `INSERT INTO invoice_items
        (invoice_id, description, quantity, unit, unit_price, tax_rate, subtotal, tax_amount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            invoice.insertId,
            item.description,
            item.quantity,
            item.unit,
            item.unitPrice,
            item.taxRate,
            item.subtotal,
            item.taxAmount,
            item.total,
          ],
        );
      await connection.execute(
        `INSERT INTO invoice_history (invoice_id, action, new_status, performed_by_user_id, metadata_json)
        VALUES (?, 'issued', 'issued', ?, ?)`,
        [invoice.insertId, issuedByUserId, JSON.stringify({ source: 'venue_booking_approval' })],
      );
      await connection.execute(
        "UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL, subtotal=?, tax_amount=?, total_amount=?, currency=? WHERE id=?",
        [price.subtotal, price.taxAmount, price.total, price.currency, bookingId],
      );
      await connection.commit();
      return {
        invoiceId: invoice.insertId,
        invoiceMode: 'ykcircle',
        invoiceNumber: allocation.invoiceNumber,
        paymentStatus: 'invoice_open',
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async externalInvoice(bookingId, userId, role) {
    if (!(await this.queries.canAccessVenueBooking(bookingId, userId, role))) return null;
    const [rows] = await this.database.execute(
      `SELECT external.id, external.booking_id AS bookingId,
      external.external_invoice_number AS externalInvoiceNumber, external.external_invoice_date AS externalInvoiceDate,
      external.amount, external.currency, external.due_date AS dueDate, external.external_invoice_url AS externalInvoiceUrl,
      external.status, external.marked_paid_at AS markedPaidAt, external.created_at AS createdAt, external.updated_at AS updatedAt,
      organization.name AS sellerName FROM booking_external_invoices external
      JOIN venue_bookings booking ON booking.id=external.booking_id JOIN venues venue ON venue.id=booking.venue_id
      LEFT JOIN organizations organization ON organization.id=venue.organization_id WHERE external.booking_id=?`,
      [bookingId],
    );
    return rows[0] || null;
  }

  async saveExternalInvoice(bookingId, userId, role, data) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [bookings] = await connection.execute(
        `SELECT booking.id, booking.currency, booking.total_amount AS totalAmount,
        COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode FROM venue_bookings booking
        JOIN venues venue ON venue.id=booking.venue_id LEFT JOIN venue_billing_settings finance ON finance.venue_id=venue.id
        LEFT JOIN organization_members member ON member.organization_id=venue.organization_id AND member.user_id=?
        WHERE booking.id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "member.role IN ('owner','admin') OR (venue.organization_id IS NULL AND venue.owner_user_id=?)"}) FOR UPDATE`,
        ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId],
      );
      const booking = bookings[0];
      if (!booking) {
        await connection.rollback();
        return { error: 'FORBIDDEN' };
      }
      if (booking.invoiceMode !== 'external') {
        await connection.rollback();
        return { error: 'INVALID_MODE' };
      }
      if (Number(data.amount ?? booking.totalAmount) > Number(booking.totalAmount))
        await this.productAccess.requirePaidFeature('paidVenuesEnabled', connection);
      await connection.execute(
        `INSERT INTO booking_external_invoices
        (booking_id, external_invoice_number, external_invoice_date, amount, currency, due_date, external_invoice_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'issued') ON DUPLICATE KEY UPDATE external_invoice_number=VALUES(external_invoice_number),
        external_invoice_date=VALUES(external_invoice_date), amount=VALUES(amount), currency=VALUES(currency), due_date=VALUES(due_date),
        external_invoice_url=VALUES(external_invoice_url), status=IF(status='paid', status, 'issued')`,
        [
          bookingId,
          data.externalInvoiceNumber,
          data.externalInvoiceDate,
          data.amount ?? booking.totalAmount,
          data.currency || booking.currency,
          data.dueDate,
          data.externalInvoiceUrl,
        ],
      );
      await connection.execute(
        "UPDATE venue_bookings SET payment_status='unpaid', invoice_generation_status='succeeded', invoice_generation_error=NULL WHERE id=?",
        [bookingId],
      );
      await connection.commit();
      await this.queries.audit(userId, 'external_invoice_recorded', 'venue_booking', bookingId, {
        externalInvoiceNumber: data.externalInvoiceNumber,
      });
      return this.queries.externalInvoice(bookingId, userId, role);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markExternalInvoicePaid(bookingId, userId, role) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT external.id FROM booking_external_invoices external
        JOIN venue_bookings booking ON booking.id=external.booking_id JOIN venues venue ON venue.id=booking.venue_id
        LEFT JOIN organization_members member ON member.organization_id=venue.organization_id AND member.user_id=?
        WHERE external.booking_id=? AND external.status IN ('awaiting_invoice','issued')
        AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "member.role IN ('owner','admin') OR (venue.organization_id IS NULL AND venue.owner_user_id=?)"}) FOR UPDATE`,
        ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId],
      );
      if (!rows[0]) {
        await connection.rollback();
        return false;
      }
      await connection.execute(
        "UPDATE booking_external_invoices SET status='paid', marked_paid_at=NOW(), marked_paid_by_user_id=? WHERE id=?",
        [userId, rows[0].id],
      );
      await connection.execute("UPDATE venue_bookings SET payment_status='paid' WHERE id=?", [
        bookingId,
      ]);
      await connection.commit();
      await this.queries.audit(userId, 'external_invoice_marked_paid', 'venue_booking', bookingId, {
        source: 'confirmed_by_venue',
      });
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async reviewVenueBooking(bookingId, userId, role, status, ownerNote = null) {
    let billingReadiness = null;
    if (status === 'confirmed') {
      billingReadiness = await this.queries.getVenueBookingBillingReadiness(bookingId);
      if (!billingReadiness) return false;
      if (billingReadiness.isInvoiceRequired) {
        await this.productAccess.requirePaidFeature('paidVenuesEnabled');
        const context = await this.queries.venueBookingFinancialContext(bookingId);
        if (!context || !(await this.queries.canManageVenueBilling(context.venueId, userId, role)))
          return { error: 'BILLING_PERMISSION_REQUIRED' };
      }
      if (!billingReadiness.priceReady)
        return { error: billingReadiness.priceError || 'PRICE_NOT_CONFIGURED' };
      if (!billingReadiness.buyerBillingProfileReady) return { error: 'BUYER_PROFILE_INCOMPLETE' };
      if (
        billingReadiness.isInvoiceRequired &&
        billingReadiness.invoiceMode === 'ykcircle' &&
        !billingReadiness.venue.canIssueInvoice
      )
        return { error: 'FINANCIAL_SETUP_INCOMPLETE', missing: billingReadiness.venue.missing };
    }
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT b.id, b.venue_id AS venueId, b.booking_type AS bookingType, b.booking_date AS bookingDate,
        b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
        LEFT JOIN organization_members member ON member.organization_id=v.organization_id AND member.user_id=?
        WHERE b.id=? AND b.status='requested' AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "v.owner_user_id=? OR member.role IN ('owner','admin','manager')"}) FOR UPDATE`,
        ['manager', 'admin'].includes(role) ? [userId, bookingId] : [userId, bookingId, userId],
      );
      const booking = rows[0];
      if (!booking) {
        await connection.rollback();
        return false;
      }
      await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [booking.venueId]);
      if (status === 'confirmed') {
        const conflict = await this.queries.checkBookingConflict(
          {
            venueId: booking.venueId,
            bookingType: booking.bookingType,
            bookingDate: booking.bookingDate,
            occupiedStartAt: booking.occupiedStartAt,
            occupiedEndAt: booking.occupiedEndAt,
            excludeBookingId: bookingId,
          },
          connection,
        );
        if (conflict.conflict) {
          await connection.rollback();
          return { error: 'CONFLICT' };
        }
      }
      const confirmed = status === 'confirmed';
      await connection.execute(
        `UPDATE venue_bookings SET status=?, owner_note=?, venue_internal_note=?,
        confirmed_at=CASE WHEN ? THEN NOW() ELSE confirmed_at END, confirmed_by=CASE WHEN ? THEN ? ELSE confirmed_by END,
        invoice_generation_status=CASE WHEN ? THEN 'pending' ELSE invoice_generation_status END WHERE id=?`,
        [status, ownerNote, ownerNote, confirmed, confirmed, userId, confirmed, bookingId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    if (status !== 'confirmed') return { invoiceId: null };
    if (!billingReadiness?.isInvoiceRequired)
      return {
        invoiceId: null,
        invoiceMode: billingReadiness?.invoiceMode || null,
        paymentStatus: 'not_required',
      };
    try {
      return await this.queries.ensureVenueBookingInvoice(bookingId, userId);
    } catch (error) {
      await this.database.execute(
        "UPDATE venue_bookings SET invoice_generation_status='failed', invoice_generation_error=? WHERE id=?",
        [String(error.message || 'Invoice generation failed').slice(0, 500), bookingId],
      );
      return {
        invoiceId: null,
        invoiceGenerationStatus: 'failed',
        warning: 'INVOICE_GENERATION_FAILED',
      };
    }
  }

  async cancelVenueBooking(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(
      `UPDATE venue_bookings b JOIN events e ON e.id = b.event_id SET b.status = 'cancelled'
      WHERE b.event_id = ? AND b.status IN ('requested', 'confirmed')${privileged ? '' : ' AND e.manager_id = ?'}`,
      privileged ? [eventId] : [eventId, userId],
    );
    return result.affectedRows > 0;
  }
}
