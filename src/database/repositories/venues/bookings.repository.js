import { zonedDateTime } from '../../../utils/time.js';
import { utcTimestamp } from '../../../utils/serialization.js';
export class VenuesBookingsRepository {
  constructor({ database, queries, productAccess }) {
    this.database = database;
    this.queries = queries;
    this.productAccess = productAccess;
  }
  async replaceVenueAvailability(venueId, userId, role, slots) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return false;
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [venues] = await connection.execute('SELECT id FROM venues WHERE id = ? FOR UPDATE', [
        venueId,
      ]);
      if (!venues[0]) {
        await connection.rollback();
        return false;
      }
      await this.queries.replaceVenueAvailabilitySlots(venueId, slots, connection);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async replaceVenueAvailabilitySlots(venueId, slots = [], executor = this.database) {
    await executor.execute('DELETE FROM venue_availability_rules WHERE venue_id = ?', [venueId]);
    for (const slot of slots)
      await executor.execute(
        'INSERT INTO venue_availability_rules (venue_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)',
        [venueId, slot.weekday, slot.startTime, slot.endTime],
      );
  }

  async venueBookingContext(eventId, venueId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(
      `SELECT id, manager_id AS managerId, starts_at AS startsAt, ends_at AS endsAt, timezone FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`,
      privileged ? [eventId] : [eventId, userId],
    );
    if (!events[0]) return { error: 'EVENT_NOT_FOUND' };
    const [venues] = await this.database.execute(
      'SELECT id, owner_user_id AS ownerUserId, name, timezone, is_active AS isActive FROM venues WHERE id = ?',
      [venueId],
    );
    if (!venues[0] || !venues[0].isActive) return { error: 'VENUE_NOT_FOUND' };
    return {
      event: events[0],
      venue: { ...venues[0], availability: await this.queries.venueAvailability(venueId) },
    };
  }

  async requestVenueBooking(eventId, venueId, organizerUserId, role, buyerBillingProfileId = null) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.queries.requestVenueBookingOnConnection(
        connection,
        eventId,
        venueId,
        organizerUserId,
        role,
        buyerBillingProfileId,
      );
      if (result.error) await connection.rollback();
      else await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async requestVenueBookingOnConnection(
    connection,
    eventId,
    venueId,
    organizerUserId,
    role,
    buyerBillingProfileId = null,
  ) {
    const [events] = await connection.execute(
      'SELECT starts_at AS startsAt, ends_at AS endsAt FROM events WHERE id = ? AND manager_id = ? AND deleted_at IS NULL FOR UPDATE',
      [eventId, organizerUserId],
    );
    const event = events[0];
    if (!event) {
      return { error: 'EVENT_NOT_FOUND' };
    }
    const [venues] = await connection.execute(
      'SELECT id, timezone, price_from AS priceFrom, currency FROM venues WHERE id = ? AND is_active = TRUE FOR UPDATE',
      [venueId],
    );
    if (!venues[0]) {
      return { error: 'VENUE_NOT_FOUND' };
    }
    const [existing] = await connection.execute(
      'SELECT id, status FROM venue_bookings WHERE event_id = ? FOR UPDATE',
      [eventId],
    );
    if (existing[0] && ['requested', 'confirmed'].includes(existing[0].status)) {
      return { error: 'EVENT_ALREADY_BOOKED' };
    }
    const [settingsRows] = await connection.execute(
      'SELECT booking_mode AS bookingMode, buffer_before_minutes AS beforeMinutes, buffer_after_minutes AS afterMinutes, currency, hourly_rate AS hourlyRate, daily_rate AS dailyRate FROM venue_booking_settings WHERE venue_id=?',
      [venueId],
    );
    const settings = settingsRows[0];
    if (!settings) {
      throw new Error(`Missing booking settings for venue ${venueId}`);
    }
    const localStart = zonedDateTime(
      event.startsAt instanceof Date
        ? event.startsAt
        : `${String(event.startsAt).replace(' ', 'T').replace(/Z$/i, '')}Z`,
      venues[0].timezone,
    );
    if (!localStart) {
      return { error: 'INVALID_EVENT_TIME' };
    }
    const bookingType = settings.bookingMode === 'daily' ? 'daily' : 'hourly';
    const occupiedStart = new Date(
      new Date(event.startsAt).getTime() - settings.beforeMinutes * 60 * 1000,
    );
    const occupiedEnd = new Date(
      new Date(event.endsAt).getTime() + settings.afterMinutes * 60 * 1000,
    );
    const conflict = await this.queries.checkBookingConflict(
      {
        venueId,
        bookingType,
        bookingDate: localStart.date,
        occupiedStartAt: occupiedStart,
        occupiedEndAt: occupiedEnd,
        excludeBookingId: existing[0]?.id || null,
      },
      connection,
    );
    if (conflict.conflict) {
      return { error: 'VENUE_UNAVAILABLE' };
    }
    const durationMinutes =
      (new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()) / 60000;
    const configuredRate =
      bookingType === 'daily'
        ? (settings.dailyRate ?? venues[0].priceFrom)
        : (settings.hourlyRate ?? venues[0].priceFrom);
    const rate =
      Number.isFinite(Number(configuredRate)) && Number(configuredRate) >= 0
        ? Number(configuredRate)
        : 0;
    const subtotal =
      bookingType === 'daily' ? rate : Math.round(((rate * durationMinutes) / 60) * 100) / 100;
    const paidBooking = subtotal > 0;
    if (paidBooking) await this.productAccess.requirePaidFeature('paidVenuesEnabled', connection);
    let buyerProfileId = null;
    if (paidBooking) {
      let profileId = Number(buyerBillingProfileId);
      // Existing event editors did not send a billing-profile id with the
      // booking request. Prefer the account's default active profile so a
      // paid venue continues to receive its requested booking; an explicit
      // id remains authoritative when the organizer selected one.
      if (!Number.isInteger(profileId) || profileId < 1) {
        const privileged = ['manager', 'admin'].includes(role);
        const [profiles] = await connection.execute(
          `SELECT p.id FROM billing_profiles p
          LEFT JOIN organization_members member ON member.organization_id=p.owner_organization_id AND member.user_id=?
          WHERE p.is_active=TRUE AND (p.owner_user_id=? OR member.role IN ('owner','admin') OR ${privileged ? 'TRUE' : 'FALSE'})
          ORDER BY p.is_default DESC, p.updated_at DESC LIMIT 1`,
          [organizerUserId, organizerUserId],
        );
        profileId = Number(profiles[0]?.id);
      }
      if (Number.isInteger(profileId) && profileId > 0) {
        const profile = await this.queries.billingProfile(
          profileId,
          organizerUserId,
          role,
          connection,
        );
        if (!profile) return { error: 'BILLING_PROFILE_UNAVAILABLE' };
        buyerProfileId = profile.id;
      }
    }
    // Missing billing details must not hide a request from the venue owner.
    // Approval still requires a complete buyer profile for a paid booking.
    const billingStatus = paidBooking
      ? buyerProfileId
        ? 'complete'
        : 'incomplete'
      : 'not_required';
    let bookingId;
    if (existing[0]) {
      await connection.execute(
        "UPDATE venue_bookings SET venue_id=?, organizer_user_id=?, buyer_billing_profile_id=?, billing_status=?, booking_type=?, status='requested', owner_note=NULL, start_at=?, end_at=?, occupied_start_at=?, occupied_end_at=?, booking_date=?, venue_timezone=?, currency=?, subtotal=?, tax_amount=0, total_amount=? WHERE id=?",
        [
          venueId,
          organizerUserId,
          buyerProfileId,
          billingStatus,
          bookingType,
          event.startsAt,
          event.endsAt,
          occupiedStart,
          occupiedEnd,
          localStart.date,
          venues[0].timezone,
          settings.currency,
          subtotal,
          subtotal,
          existing[0].id,
        ],
      );
      bookingId = existing[0].id;
    } else {
      const [result] = await connection.execute(
        "INSERT INTO venue_bookings (venue_id, event_id, organizer_user_id, buyer_billing_profile_id, billing_status, booking_type, booking_date, start_at, end_at, occupied_start_at, occupied_end_at, venue_timezone, currency, subtotal, tax_amount, total_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'requested')",
        [
          venueId,
          eventId,
          organizerUserId,
          buyerProfileId,
          billingStatus,
          bookingType,
          localStart.date,
          event.startsAt,
          event.endsAt,
          occupiedStart,
          occupiedEnd,
          venues[0].timezone,
          settings.currency,
          subtotal,
          subtotal,
        ],
      );
      bookingId = result.insertId;
    }
    return { id: bookingId, status: 'requested' };
  }

  async eventVenueBooking(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId, b.buyer_billing_profile_id AS buyerBillingProfileId, b.billing_status AS billingStatus, b.booking_type AS bookingType, b.start_at AS startAt, b.end_at AS endAt, b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt, b.venue_timezone AS timezone, b.booking_date AS bookingDate, b.status, b.payment_status AS paymentStatus, b.currency, b.subtotal, b.tax_amount AS taxAmount, b.total_amount AS totalAmount, b.invoice_generation_status AS invoiceGenerationStatus, b.invoice_generation_error AS invoiceGenerationError, b.owner_note AS ownerNote, b.created_at AS createdAt, b.updated_at AS updatedAt,
      v.name AS venueName, v.formatted_address AS venueLocation, v.owner_user_id AS venueOwnerUserId,
      invoice.id AS invoiceId, invoice.invoice_number AS invoiceNumber, invoice.status AS invoiceStatus,
      external.id AS externalInvoiceId, external.status AS externalInvoiceStatus, external.external_invoice_number AS externalInvoiceNumber,
      external.external_invoice_url AS externalInvoiceUrl, external.due_date AS externalInvoiceDueDate
      FROM venue_bookings b JOIN venues v ON v.id = b.venue_id JOIN events e ON e.id = b.event_id
      LEFT JOIN invoices invoice ON invoice.booking_id=b.id LEFT JOIN booking_external_invoices external ON external.booking_id=b.id
      WHERE b.event_id = ? AND (${privileged ? 'TRUE' : 'e.manager_id = ? OR v.owner_user_id = ?'})`,
      privileged ? [eventId] : [eventId, userId, userId],
    );
    return rows[0]
      ? {
          ...rows[0],
          startAt: utcTimestamp(rows[0].startAt),
          endAt: utcTimestamp(rows[0].endAt),
          occupiedStartAt: utcTimestamp(rows[0].occupiedStartAt),
          occupiedEndAt: utcTimestamp(rows[0].occupiedEndAt),
          createdAt: utcTimestamp(rows[0].createdAt),
          updatedAt: utcTimestamp(rows[0].updatedAt),
        }
      : null;
  }

  async venueBookings(venueId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT b.id, b.venue_id AS venueId, b.event_id AS eventId, b.organizer_user_id AS organizerUserId, b.buyer_billing_profile_id AS buyerBillingProfileId, b.booking_type AS bookingType, b.booking_date AS bookingDate, b.venue_timezone AS venueTimezone, b.start_at AS startAt, b.end_at AS endAt, b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt, b.status, b.payment_status AS paymentStatus, b.currency, b.subtotal, b.tax_amount AS taxAmount, b.total_amount AS totalAmount, b.invoice_generation_status AS invoiceGenerationStatus, b.invoice_generation_error AS invoiceGenerationError, b.owner_note AS ownerNote, b.created_at AS createdAt, b.updated_at AS updatedAt,
      e.title AS eventTitle, e.timezone AS eventTimezone, organizer.name AS organizerName, organizer.email AS organizerEmail,
      buyer.legal_name AS buyerLegalName, invoice.id AS invoiceId, invoice.invoice_number AS invoiceNumber, invoice.status AS invoiceStatus,
      external.id AS externalInvoiceId, external.status AS externalInvoiceStatus, external.external_invoice_number AS externalInvoiceNumber,
      external.external_invoice_url AS externalInvoiceUrl, external.due_date AS externalInvoiceDueDate,
      COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode
      FROM venue_bookings b JOIN venues v ON v.id = b.venue_id JOIN events e ON e.id = b.event_id JOIN users organizer ON organizer.id = b.organizer_user_id
      LEFT JOIN billing_profiles buyer ON buyer.id=b.buyer_billing_profile_id LEFT JOIN invoices invoice ON invoice.booking_id=b.id
      LEFT JOIN booking_external_invoices external ON external.booking_id=b.id LEFT JOIN venue_billing_settings finance ON finance.venue_id=v.id
      LEFT JOIN organization_members venue_member ON venue_member.organization_id=v.organization_id AND venue_member.user_id=?
      WHERE b.venue_id = ? AND (${privileged ? 'TRUE' : "v.owner_user_id=? OR venue_member.role IN ('owner','admin','manager')"})
      ORDER BY CASE WHEN b.status = 'requested' THEN 0 ELSE 1 END, b.created_at DESC, b.id DESC`,
      privileged ? [userId, venueId] : [userId, venueId, userId],
    );
    return rows;
  }

  async canAccessVenueBooking(bookingId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT b.id FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
      LEFT JOIN organization_members venue_member ON venue_member.organization_id=v.organization_id AND venue_member.user_id=?
      WHERE b.id=? AND (${privileged ? 'TRUE' : "b.organizer_user_id=? OR v.owner_user_id=? OR venue_member.role IN ('owner','admin','manager')"})`,
      privileged ? [userId, bookingId] : [userId, bookingId, userId, userId],
    );
    return Boolean(rows[0]);
  }

  async updateVenueBookingBuyerBillingProfile(bookingId, userId, role, buyerBillingProfileId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const privileged = ['manager', 'admin'].includes(role);
      const [bookings] = await connection.execute(
        `SELECT booking.id, booking.event_id AS eventId FROM venue_bookings booking
        JOIN events event_row ON event_row.id=booking.event_id
        WHERE booking.id=? AND booking.status='requested' AND (${privileged ? 'TRUE' : 'event_row.manager_id=?'}) FOR UPDATE`,
        privileged ? [bookingId] : [bookingId, userId],
      );
      const booking = bookings[0];
      if (!booking) {
        await connection.rollback();
        return { error: 'BOOKING_NOT_EDITABLE' };
      }
      const profile = await this.queries.billingProfile(
        buyerBillingProfileId,
        userId,
        role,
        connection,
      );
      if (!profile) {
        await connection.rollback();
        return { error: 'BILLING_PROFILE_UNAVAILABLE' };
      }
      const completeness = this.queries.billingProfileCompleteness(profile, 'venue_buyer');
      if (!completeness.complete) {
        await connection.rollback();
        return { error: 'BUYER_PROFILE_INCOMPLETE', missing: completeness.missing };
      }
      await connection.execute(
        "UPDATE venue_bookings SET buyer_billing_profile_id=?, billing_status='complete' WHERE id=?",
        [profile.id, bookingId],
      );
      await connection.commit();
      await this.queries.audit(
        userId,
        'venue_booking_buyer_profile_updated',
        'venue_booking',
        bookingId,
        { buyerBillingProfileId: profile.id },
      );
      return { id: bookingId, eventId: booking.eventId, buyerBillingProfileId: profile.id };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async venueBookingMessages(bookingId, userId, role) {
    if (!(await this.queries.canAccessVenueBooking(bookingId, userId, role))) return null;
    const [rows] = await this.database.execute(
      `SELECT m.id, m.booking_id AS bookingId, m.sender_user_id AS senderUserId,
      sender.name AS senderName, m.body, m.created_at AS createdAt FROM venue_booking_messages m JOIN users sender ON sender.id=m.sender_user_id
      WHERE m.booking_id=? ORDER BY m.created_at ASC, m.id ASC`,
      [bookingId],
    );
    return rows;
  }

  async createVenueBookingMessage(bookingId, userId, role, body) {
    if (!(await this.queries.canAccessVenueBooking(bookingId, userId, role))) return null;
    const [result] = await this.database.execute(
      'INSERT INTO venue_booking_messages (booking_id, sender_user_id, body) VALUES (?, ?, ?)',
      [bookingId, userId, body],
    );
    return { id: result.insertId, bookingId, senderUserId: userId, body };
  }

  async reviewVenueBookingLegacy(bookingId, userId, role, status, ownerNote = null) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT b.venue_id AS venueId, b.organizer_user_id AS organizerUserId, b.buyer_billing_profile_id AS buyerBillingProfileId, b.billing_status AS billingStatus, b.currency, b.subtotal, b.tax_amount AS taxAmount, b.total_amount AS totalAmount,
        b.occupied_start_at AS occupiedStartAt, b.occupied_end_at AS occupiedEndAt, v.organization_id AS sellerOrganizationId, v.owner_user_id AS sellerOwnerUserId,
        v.name AS venueName, v.business_name AS venueBrandName, v.logo_image AS venueLogoImage, v.formatted_address AS venueAddress, b.booking_type AS bookingType, b.booking_date AS bookingDate, b.start_at AS startAt, b.end_at AS endAt, e.title AS eventTitle, settings.hourly_rate AS hourlyRate, settings.daily_rate AS dailyRate,
        seller_profile.id AS sellerBillingProfileId, seller_profile.legal_name AS sellerLegalName, seller_profile.organization_number AS sellerRegistrationNumber,
        seller_profile.vat_number AS sellerVatNumber, seller_profile.address_line_1 AS sellerAddressLine1,
        seller_profile.address_line_2 AS sellerAddressLine2, seller_profile.postal_code AS sellerPostalCode,
        seller_profile.city AS sellerCity, seller_profile.country AS sellerCountry,
        seller_profile.billing_email AS sellerBillingEmail, seller_profile.payment_instructions AS sellerPaymentInstructions,
        seller_profile.invoice_prefix AS invoicePrefix, seller_profile.invoice_due_days AS profileInvoiceDueDays,
        settings.invoice_due_days AS invoiceDueDays FROM venue_bookings b JOIN venues v ON v.id=b.venue_id
        LEFT JOIN events e ON e.id=b.event_id
        JOIN venue_booking_settings settings ON settings.venue_id=v.id LEFT JOIN billing_profiles seller_profile ON seller_profile.id=v.billing_profile_id
        LEFT JOIN organization_members om ON om.organization_id=v.organization_id AND om.user_id=?
        WHERE b.id=? AND b.status = 'requested' AND (${['manager', 'admin'].includes(role) ? 'TRUE' : "v.owner_user_id=? OR om.role IN ('owner','admin','manager')"}) FOR UPDATE`,
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
      let buyerProfile = null;
      const confirmed = status === 'confirmed';
      const durationHours = Math.max(
        0,
        (new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime()) / 3600000,
      );
      const storedSubtotal = Number(booking.subtotal) || 0;
      const rate = Number(booking.bookingType === 'daily' ? booking.dailyRate : booking.hourlyRate);
      const calculatedSubtotal =
        Number.isFinite(rate) && rate > 0
          ? booking.bookingType === 'daily'
            ? rate
            : Math.round(rate * durationHours * 100) / 100
          : 0;
      // Requests created before pricing was added stored a zero total. Apply
      // today's configured rate when they are approved, while preserving an
      // explicitly priced booking (including a genuinely free venue).
      const subtotal =
        storedSubtotal > 0 || calculatedSubtotal === 0 ? storedSubtotal : calculatedSubtotal;
      const taxRate = 0;
      const taxAmount = Math.round(subtotal * taxRate) / 100;
      const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;
      if (status === 'confirmed' && totalAmount > 0) {
        await this.productAccess.requirePaidFeature('paidVenuesEnabled', connection);
        const sellerComplete =
          booking.sellerBillingProfileId &&
          booking.sellerLegalName &&
          booking.sellerAddressLine1 &&
          booking.sellerPostalCode &&
          booking.sellerCity &&
          booking.sellerCountry &&
          booking.sellerBillingEmail;
        if (!sellerComplete) {
          await connection.rollback();
          return { error: 'SELLER_PROFILE_INCOMPLETE' };
        }
        const [buyers] = await connection.execute(
          `SELECT id, profile_type AS profileType, legal_name AS legalName, organization_number AS organizationNumber,
          vat_number AS vatNumber, address_line_1 AS addressLine1, address_line_2 AS addressLine2, postal_code AS postalCode,
          city, country, billing_email AS billingEmail, phone FROM billing_profiles WHERE id=? AND is_active=TRUE FOR UPDATE`,
          [booking.buyerBillingProfileId],
        );
        buyerProfile = buyers[0] || null;
        const buyerComplete =
          booking.billingStatus === 'complete' &&
          buyerProfile &&
          buyerProfile.legalName &&
          buyerProfile.addressLine1 &&
          buyerProfile.postalCode &&
          buyerProfile.city &&
          buyerProfile.country &&
          buyerProfile.billingEmail;
        if (!buyerComplete) {
          await connection.rollback();
          return { error: 'BUYER_PROFILE_INCOMPLETE' };
        }
      }
      if (confirmed && (storedSubtotal === 0 || Number(booking.taxAmount) !== taxAmount)) {
        await connection.execute(
          'UPDATE venue_bookings SET subtotal=?, tax_amount=?, total_amount=? WHERE id=?',
          [subtotal, taxAmount, totalAmount, bookingId],
        );
      }
      await connection.execute(
        'UPDATE venue_bookings SET status=?, owner_note=?, venue_internal_note=?, confirmed_at=CASE WHEN ? THEN NOW() ELSE confirmed_at END, confirmed_by=CASE WHEN ? THEN ? ELSE confirmed_by END WHERE id=?',
        [status, ownerNote, ownerNote, confirmed, confirmed, userId, bookingId],
      );
      let invoiceId = null;
      if (status === 'confirmed' && totalAmount > 0) {
        const [existingInvoice] = await connection.execute(
          'SELECT id FROM invoices WHERE booking_id=? FOR UPDATE',
          [bookingId],
        );
        if (existingInvoice[0]) invoiceId = existingInvoice[0].id;
        else {
          const allocation = await this.queries.allocateInvoiceNumber(
            connection,
            booking.sellerBillingProfileId,
            booking.invoicePrefix,
          );
          const sellerSnapshot = {
            brandName: booking.venueBrandName || booking.venueName,
            logoImage: booking.venueLogoImage || null,
            legalName: booking.sellerLegalName,
            organizationNumber: booking.sellerRegistrationNumber,
            vatNumber: booking.sellerVatNumber || null,
            addressLine1: booking.sellerAddressLine1,
            addressLine2: booking.sellerAddressLine2,
            postalCode: booking.sellerPostalCode,
            city: booking.sellerCity,
            country: booking.sellerCountry,
            billingEmail: booking.sellerBillingEmail,
          };
          const bookingSnapshot = {
            venueName: booking.venueName,
            venueAddress: booking.venueAddress,
            eventTitle: booking.eventTitle,
            startsAt: utcTimestamp(booking.startAt),
            endsAt: utcTimestamp(booking.endAt),
          };
          const taxSnapshot = {
            type: 'not_calculated',
            rate: taxRate,
            taxAmount,
            country: booking.sellerCountry,
          };
          const paymentInstructions = { text: booking.sellerPaymentInstructions };
          const [invoice] = await connection.execute(
            `INSERT INTO invoices (seller_organization_id, seller_billing_profile_id, buyer_user_id, buyer_billing_profile_id, booking_id, context_type, context_id, invoice_series_id, invoice_number, status, issue_date, due_date, currency, subtotal, tax_amount, total_amount, seller_snapshot_json, buyer_snapshot_json, booking_snapshot_json, tax_snapshot_json, payment_instructions_snapshot)
          VALUES (?, ?, ?, ?, ?, 'venue_booking', ?, ?, ?, 'issued', CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              booking.sellerOrganizationId,
              booking.sellerBillingProfileId,
              booking.organizerUserId,
              buyerProfile.id,
              bookingId,
              String(bookingId),
              allocation.seriesId,
              allocation.invoiceNumber,
              booking.profileInvoiceDueDays || booking.invoiceDueDays,
              booking.currency,
              subtotal,
              taxAmount,
              totalAmount,
              JSON.stringify(sellerSnapshot),
              JSON.stringify(buyerProfile),
              JSON.stringify(bookingSnapshot),
              JSON.stringify(taxSnapshot),
              JSON.stringify(paymentInstructions),
            ],
          );
          invoiceId = invoice.insertId;
          const quantity =
            booking.bookingType === 'daily' ? 1 : Math.round(durationHours * 1000) / 1000;
          const unitPrice = quantity > 0 ? Math.round((subtotal / quantity) * 100) / 100 : 0;
          await connection.execute(
            `INSERT INTO invoice_items (invoice_id, description, quantity, unit, unit_price, tax_rate, subtotal, tax_amount, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              invoiceId,
              `Venue rental${booking.venueName ? `: ${booking.venueName}` : ''}`,
              quantity,
              booking.bookingType === 'daily' ? 'day' : 'hour',
              unitPrice,
              taxRate,
              subtotal,
              taxAmount,
              totalAmount,
            ],
          );
          await connection.execute(
            `INSERT INTO invoice_history (invoice_id, action, new_status, performed_by_user_id) VALUES (?, 'issued', 'issued', ?)`,
            [invoiceId, userId],
          );
        }
      }
      await connection.commit();
      return { invoiceId };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
