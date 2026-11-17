import {
  addDays,
  calculateAvailability,
  isDateOnly,
  localDateTimeToUtc,
} from '../../../domain/venues/venue-availability.js';
import { venueFinancialReadiness as evaluateVenueFinancialReadiness } from '../../../domain/venues/venue-finance.js';
import { dateOnly, jsonValue } from '../../../utils/serialization.js';
export class VenuesAvailabilityRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async canManageVenue(id, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(
      `SELECT v.id FROM venues v LEFT JOIN organization_members om ON om.organization_id = v.organization_id AND om.user_id = ? WHERE v.id = ? AND (v.owner_user_id = ? OR om.role IN ('owner','admin','manager'))`,
      [userId, id, userId],
    );
    return Boolean(rows[0]);
  }

  async canManageVenueBilling(id, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(
      `SELECT v.id FROM venues v
      LEFT JOIN organization_members member ON member.organization_id=v.organization_id AND member.user_id=?
      WHERE v.id=? AND (member.role IN ('owner','admin') OR (v.organization_id IS NULL AND v.owner_user_id=?))`,
      [userId, id, userId],
    );
    return Boolean(rows[0]);
  }

  async venueAvailability(venueId) {
    const [rows] = await this.database.execute(
      "SELECT id, venue_id AS venueId, day_of_week AS weekday, TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime FROM venue_availability_rules WHERE venue_id = ? AND is_active = TRUE ORDER BY day_of_week, start_time",
      [venueId],
    );
    return rows;
  }

  async venueTimezone(venueId) {
    const [rows] = await this.database.execute('SELECT timezone FROM venues WHERE id = ?', [
      venueId,
    ]);
    return rows[0] || null;
  }

  async venueAvailabilityForDate(venueId, date) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    const [venues] = await this.database.execute(
      "SELECT id, timezone FROM venues WHERE id = ? AND is_active = TRUE AND moderation_status = 'approved'",
      [venueId],
    );
    if (!venues[0]) return null;
    const [slots] = await this.database.execute(
      "SELECT TIME_FORMAT(start_time, '%H:%i') AS startTime, TIME_FORMAT(end_time, '%H:%i') AS endTime FROM venue_availability_rules WHERE venue_id = ? AND day_of_week = ? AND is_active = TRUE ORDER BY start_time",
      [venueId, weekday],
    );
    return { venueId, date, timezone: venues[0].timezone, slots };
  }

  async venueBookingSettings(venueId) {
    const [rows] = await this.database.execute(
      `SELECT venue_id AS venueId, booking_mode AS bookingMode,
      slot_increment_minutes AS slotIncrementMinutes, minimum_booking_minutes AS minimumBookingMinutes,
      maximum_booking_minutes AS maximumBookingMinutes, buffer_before_minutes AS bufferBeforeMinutes,
      buffer_after_minutes AS bufferAfterMinutes, minimum_notice_hours AS minimumNoticeHours,
      maximum_advance_days AS maximumAdvanceDays, currency, hourly_rate AS hourlyRate,
      daily_rate AS dailyRate, invoice_due_days AS invoiceDueDays FROM venue_booking_settings WHERE venue_id = ?`,
      [venueId],
    );
    return rows[0] || null;
  }

  async venueFinancialSettings(venueId, userId = null, role = null) {
    if (userId !== null && !(await this.queries.canManageVenueBilling(venueId, userId, role)))
      return null;
    const [rows] = await this.database.execute(
      `SELECT v.id AS venueId, v.organization_id AS organizationId,
      COALESCE(finance.invoice_mode, 'ykcircle') AS invoiceMode,
      COALESCE(finance.seller_billing_profile_id, v.billing_profile_id, organization.default_billing_profile_id) AS sellerBillingProfileId,
      COALESCE(finance.payment_terms_days, booking.invoice_due_days, 30) AS paymentTermsDays,
      COALESCE(finance.tax_mode, 'no_tax') AS taxMode, finance.default_tax_rate AS defaultTaxRate,
      COALESCE(finance.prices_include_tax, FALSE) AS pricesIncludeTax,
      COALESCE(finance.confirmation_policy, 'on_owner_approval') AS confirmationPolicy,
      finance.accepted_terms_version AS acceptedTermsVersion, finance.accepted_at AS acceptedAt,
      finance.accepted_by_user_id AS acceptedByUserId,
      payment.methods_json AS methods, payment.bankgiro, payment.plusgiro, payment.iban, payment.bic,
      payment.swish_number AS swishNumber, payment.bank_name AS bankName,
      payment.account_details_text AS accountDetailsText, payment.additional_instructions AS additionalInstructions,
      COALESCE(payment.payment_reference_mode, 'invoice_number') AS paymentReferenceMode
      FROM venues v LEFT JOIN organizations organization ON organization.id=v.organization_id
      LEFT JOIN venue_booking_settings booking ON booking.venue_id=v.id
      LEFT JOIN venue_billing_settings finance ON finance.venue_id=v.id
      LEFT JOIN venue_payment_settings payment ON payment.venue_id=v.id WHERE v.id=?`,
      [venueId],
    );
    if (!rows[0]) return null;
    return {
      ...rows[0],
      methods: jsonValue(rows[0].methods) || [],
      pricesIncludeTax: Boolean(rows[0].pricesIncludeTax),
    };
  }

  async saveVenueFinancialSettings(venueId, userId, role, settings) {
    if (!(await this.queries.canManageVenueBilling(venueId, userId, role)))
      return { error: 'FORBIDDEN' };
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [venues] = await connection.execute(
        `SELECT venue.organization_id AS organizationId, finance.invoice_mode AS existingInvoiceMode,
        finance.accepted_terms_version AS existingTermsVersion, finance.accepted_at AS existingAcceptedAt,
        finance.accepted_by_user_id AS existingAcceptedByUserId FROM venues venue
        LEFT JOIN venue_billing_settings finance ON finance.venue_id=venue.id WHERE venue.id=? FOR UPDATE`,
        [venueId],
      );
      const venue = venues[0];
      if (!venue) {
        await connection.rollback();
        return { error: 'NOT_FOUND' };
      }
      if (settings.sellerBillingProfileId) {
        const [profiles] = await connection.execute(
          `SELECT id, owner_organization_id AS ownerOrganizationId, profile_type AS profileType
          FROM billing_profiles WHERE id=? AND is_active=TRUE FOR UPDATE`,
          [settings.sellerBillingProfileId],
        );
        const seller = profiles[0];
        if (
          !seller ||
          seller.profileType !== 'organization' ||
          Number(seller.ownerOrganizationId) !== Number(venue.organizationId)
        ) {
          await connection.rollback();
          return { error: 'SELLER_PROFILE_ORGANIZATION_MISMATCH' };
        }
      }
      const accepted =
        settings.acceptInvoiceAuthorization === true && settings.invoiceMode === 'ykcircle';
      const preserveAcceptance =
        !accepted &&
        settings.invoiceMode === 'ykcircle' &&
        venue.existingInvoiceMode === 'ykcircle';
      const acceptedTermsVersion = accepted
        ? settings.termsVersion
        : preserveAcceptance
          ? venue.existingTermsVersion
          : null;
      const acceptedAt = accepted
        ? new Date()
        : preserveAcceptance
          ? venue.existingAcceptedAt
          : null;
      const acceptedByUserId = accepted
        ? userId
        : preserveAcceptance
          ? venue.existingAcceptedByUserId
          : null;
      await connection.execute(
        `INSERT INTO venue_billing_settings
        (venue_id, invoice_mode, seller_billing_profile_id, payment_terms_days, tax_mode, default_tax_rate, prices_include_tax, confirmation_policy,
         accepted_terms_version, accepted_at, accepted_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE invoice_mode=VALUES(invoice_mode), seller_billing_profile_id=VALUES(seller_billing_profile_id),
        payment_terms_days=VALUES(payment_terms_days), tax_mode=VALUES(tax_mode), default_tax_rate=VALUES(default_tax_rate),
        prices_include_tax=VALUES(prices_include_tax), confirmation_policy=VALUES(confirmation_policy),
        accepted_terms_version=VALUES(accepted_terms_version), accepted_at=VALUES(accepted_at), accepted_by_user_id=VALUES(accepted_by_user_id)`,
        [
          venueId,
          settings.invoiceMode,
          settings.sellerBillingProfileId,
          settings.paymentTermsDays,
          settings.taxMode,
          settings.defaultTaxRate,
          settings.pricesIncludeTax,
          settings.confirmationPolicy,
          acceptedTermsVersion,
          acceptedAt,
          acceptedByUserId,
        ],
      );
      await connection.execute(
        `INSERT INTO venue_payment_settings
        (venue_id, methods_json, bankgiro, plusgiro, iban, bic, swish_number, bank_name, account_details_text, additional_instructions, payment_reference_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE methods_json=VALUES(methods_json), bankgiro=VALUES(bankgiro), plusgiro=VALUES(plusgiro), iban=VALUES(iban),
        bic=VALUES(bic), swish_number=VALUES(swish_number), bank_name=VALUES(bank_name), account_details_text=VALUES(account_details_text),
        additional_instructions=VALUES(additional_instructions), payment_reference_mode=VALUES(payment_reference_mode)`,
        [
          venueId,
          JSON.stringify(settings.methods),
          settings.bankgiro,
          settings.plusgiro,
          settings.iban,
          settings.bic,
          settings.swishNumber,
          settings.bankName,
          settings.accountDetailsText,
          settings.additionalInstructions,
          settings.paymentReferenceMode,
        ],
      );
      await connection.execute('UPDATE venues SET billing_profile_id=? WHERE id=?', [
        settings.sellerBillingProfileId,
        venueId,
      ]);
      await connection.commit();
      await this.queries.audit(userId, 'venue_financial_settings_changed', 'venue', venueId, {
        invoiceMode: settings.invoiceMode,
        sellerBillingProfileId: settings.sellerBillingProfileId,
        methods: settings.methods,
      });
      return this.queries.venueFinancialSettings(venueId, userId, role);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getVenueFinancialReadiness(venueId, userId = null, role = null) {
    const settings = await this.queries.venueFinancialSettings(venueId, userId, role);
    if (!settings) return null;
    let seller = null;
    if (settings.sellerBillingProfileId) {
      const [profiles] = await this.database.execute(
        `SELECT ${this.queries.billingProfileColumns('p')} FROM billing_profiles p WHERE p.id=?`,
        [settings.sellerBillingProfileId],
      );
      seller = profiles[0] ? { ...profiles[0], isActive: Boolean(profiles[0].isActive) } : null;
      if (seller && Number(seller.ownerOrganizationId) !== Number(settings.organizationId))
        seller = null;
    }
    return { venueId, ...evaluateVenueFinancialReadiness(settings, seller, settings) };
  }

  async updateVenueBookingSettings(venueId, userId, role, settings) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return false;
    const [result] = await this.database.execute(
      `INSERT INTO venue_booking_settings (venue_id, booking_mode, slot_increment_minutes, minimum_booking_minutes,
      maximum_booking_minutes, buffer_before_minutes, buffer_after_minutes, minimum_notice_hours, maximum_advance_days, currency, hourly_rate, daily_rate, invoice_due_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE booking_mode=VALUES(booking_mode),
      slot_increment_minutes=VALUES(slot_increment_minutes), minimum_booking_minutes=VALUES(minimum_booking_minutes), maximum_booking_minutes=VALUES(maximum_booking_minutes),
      buffer_before_minutes=VALUES(buffer_before_minutes), buffer_after_minutes=VALUES(buffer_after_minutes), minimum_notice_hours=VALUES(minimum_notice_hours),
      maximum_advance_days=VALUES(maximum_advance_days), currency=VALUES(currency), hourly_rate=VALUES(hourly_rate), daily_rate=VALUES(daily_rate), invoice_due_days=VALUES(invoice_due_days)`,
      [
        venueId,
        settings.bookingMode,
        settings.slotIncrementMinutes,
        settings.minimumBookingMinutes,
        settings.maximumBookingMinutes,
        settings.bufferBeforeMinutes,
        settings.bufferAfterMinutes,
        settings.minimumNoticeHours,
        settings.maximumAdvanceDays,
        settings.currency,
        settings.hourlyRate,
        settings.dailyRate,
        settings.invoiceDueDays,
      ],
    );
    return result.affectedRows > 0;
  }

  async venueAvailabilityData(venueId, from, to) {
    const [venues] = await this.database.execute(
      'SELECT id, timezone, is_active AS isActive, moderation_status AS moderationStatus FROM venues WHERE id = ?',
      [venueId],
    );
    if (!venues[0]) return null;
    const venue = venues[0];
    // Database DATETIME values are UTC instants. Query with venue-local day
    // bounds converted to UTC, otherwise a booking near midnight is loaded
    // for the wrong calendar day (or not loaded at all).
    const rangeStart = localDateTimeToUtc(from, '00:00', venue.timezone, 'start');
    const rangeEnd = localDateTimeToUtc(addDays(to, 1), '00:00', venue.timezone, 'start');
    if (!rangeStart || !rangeEnd) return null;
    const rangeStartUtc = rangeStart.toISOString().slice(0, 19).replace('T', ' ');
    const rangeEndUtc = rangeEnd.toISOString().slice(0, 19).replace('T', ' ');
    const [rules] = await this.database.execute(
      `SELECT day_of_week AS weekday, TIME_FORMAT(start_time, '%H:%i') AS startTime,
      TIME_FORMAT(end_time, '%H:%i') AS endTime, is_active AS isActive FROM venue_availability_rules WHERE venue_id = ? ORDER BY day_of_week, start_time`,
      [venueId],
    );
    const [overrideRows] = await this.database.execute(
      `SELECT o.id, o.date, o.override_type AS overrideType,
      TIME_FORMAT(w.start_time, '%H:%i') AS startTime, TIME_FORMAT(w.end_time, '%H:%i') AS endTime
      FROM venue_availability_overrides o LEFT JOIN venue_availability_override_windows w ON w.override_id=o.id
      WHERE o.venue_id=? AND o.date BETWEEN ? AND ? ORDER BY o.date, w.start_time`,
      [venueId, from, to],
    );
    const overrides = [
      ...overrideRows
        .reduce((map, row) => {
          if (!map.has(row.id))
            map.set(row.id, {
              id: row.id,
              date: row.date,
              overrideType: row.overrideType,
              windows: [],
            });
          if (row.startTime)
            map.get(row.id).windows.push({ startTime: row.startTime, endTime: row.endTime });
          return map;
        }, new Map())
        .values(),
    ];
    const [blocks] = await this.database.execute(
      `SELECT start_at AS startAt, end_at AS endAt FROM venue_availability_blocks
      WHERE venue_id=? AND start_at < ? AND end_at > ?`,
      [venueId, rangeEndUtc, rangeStartUtc],
    );
    const [externalReservations] = await this.database.execute(
      `SELECT start_at AS startAt, end_at AS endAt FROM venue_external_reservations
      WHERE venue_id=? AND cancelled_at IS NULL AND start_at < ? AND end_at > ?`,
      [venueId, rangeEndUtc, rangeStartUtc],
    );
    const [bookingRows] = await this.database.execute(
      `SELECT booking_type AS bookingType, booking_date AS bookingDate, venue_timezone AS venueTimezone,
      occupied_start_at AS startAt, occupied_end_at AS endAt, status FROM venue_bookings
      WHERE venue_id=? AND status IN ('requested', 'confirmed') AND ((booking_type='daily' AND booking_date BETWEEN ? AND ?) OR
      (booking_type='hourly' AND occupied_start_at < ? AND occupied_end_at > ?))`,
      [venueId, from, to, rangeEndUtc, rangeStartUtc],
    );
    const bookings = bookingRows.flatMap((booking) => {
      if (booking.bookingType !== 'daily') return [booking];
      const date =
        booking.bookingDate instanceof Date
          ? booking.bookingDate.toISOString().slice(0, 10)
          : String(booking.bookingDate).slice(0, 10);
      const bookingTimezone = booking.venueTimezone || venue.timezone;
      const startAt = localDateTimeToUtc(date, '00:00', bookingTimezone, 'start');
      const endAt = localDateTimeToUtc(addDays(date, 1), '00:00', bookingTimezone, 'start');
      return startAt && endAt ? [{ ...booking, startAt, endAt }] : [];
    });
    return {
      venue,
      rules: rules.map((rule) => ({ ...rule, isActive: Boolean(rule.isActive) })),
      overrides,
      blocks,
      externalReservations,
      bookings,
    };
  }

  async calculateVenueAvailability(venueId, from, to, { publicOnly = true } = {}) {
    if (!isDateOnly(from) || !isDateOnly(to) || from > to) return null;
    const data = await this.queries.venueAvailabilityData(venueId, from, to);
    if (
      !data ||
      (publicOnly && (!data.venue.isActive || data.venue.moderationStatus !== 'approved'))
    )
      return null;
    const settings = await this.queries.venueBookingSettings(venueId);
    return {
      venueId,
      timezone: data.venue.timezone,
      bookingMode: settings.bookingMode,
      slotIncrementMinutes: settings.slotIncrementMinutes,
      minimumBookingMinutes: settings.minimumBookingMinutes,
      maximumBookingMinutes: settings.maximumBookingMinutes,
      bufferBeforeMinutes: settings.bufferBeforeMinutes,
      bufferAfterMinutes: settings.bufferAfterMinutes,
      currency: settings.currency,
      hourlyRate: settings.hourlyRate,
      dailyRate: settings.dailyRate,
      dates: calculateAvailability({ from, to, timezone: data.venue.timezone, ...data }),
    };
  }

  async replaceVenueAvailabilityOverrides(venueId, userId, role, overrides) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return false;
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [venueId]);
      await connection.execute('DELETE FROM venue_availability_overrides WHERE venue_id=?', [
        venueId,
      ]);
      for (const override of overrides) {
        const [result] = await connection.execute(
          'INSERT INTO venue_availability_overrides (venue_id, date, override_type) VALUES (?, ?, ?)',
          [venueId, override.date, override.overrideType],
        );
        for (const window of override.windows || [])
          await connection.execute(
            'INSERT INTO venue_availability_override_windows (override_id, start_time, end_time) VALUES (?, ?, ?)',
            [result.insertId, window.startTime, window.endTime],
          );
      }
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async venueCalendar(venueId, userId, role, from, to) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return null;
    const availability = await this.queries.calculateVenueAvailability(venueId, from, to, {
      publicOnly: false,
    });
    if (!availability) return null;
    const rangeStart = localDateTimeToUtc(from, '00:00', availability.timezone, 'start');
    const rangeEnd = localDateTimeToUtc(addDays(to, 1), '00:00', availability.timezone, 'start');
    if (!rangeStart || !rangeEnd) return null;
    const rangeStartUtc = rangeStart.toISOString().slice(0, 19).replace('T', ' ');
    const rangeEndUtc = rangeEnd.toISOString().slice(0, 19).replace('T', ' ');
    const [overrides] = await this.database.execute(
      'SELECT id, date, override_type AS overrideType FROM venue_availability_overrides WHERE venue_id=? AND date BETWEEN ? AND ? ORDER BY date',
      [venueId, from, to],
    );
    const [blocks] = await this.database.execute(
      'SELECT id, start_at AS startAt, end_at AS endAt, reason, created_by_user_id AS createdByUserId FROM venue_availability_blocks WHERE venue_id=? AND start_at < ? AND end_at > ?',
      [venueId, rangeEndUtc, rangeStartUtc],
    );
    const [externalReservations] = await this.database.execute(
      'SELECT id, start_at AS startAt, end_at AS endAt, source, title, notes, cancelled_at AS cancelledAt FROM venue_external_reservations WHERE venue_id=? AND start_at < ? AND end_at > ?',
      [venueId, rangeEndUtc, rangeStartUtc],
    );
    const [bookings] = await this.database.execute(
      `SELECT id, organizer_user_id AS organizerUserId, booking_type AS bookingType, booking_date AS bookingDate, venue_timezone AS venueTimezone, start_at AS startAt, end_at AS endAt, status, organizer_message AS organizerMessage FROM venue_bookings WHERE venue_id=? AND ((booking_type='daily' AND booking_date BETWEEN ? AND ?) OR (booking_type='hourly' AND start_at < ? AND end_at > ?))`,
      [venueId, from, to, rangeEndUtc, rangeStartUtc],
    );
    return {
      timezone: availability.timezone,
      range: { from, to },
      availability: availability.dates,
      overrides,
      blocks,
      bookingRequests: bookings.filter((booking) => booking.status === 'requested'),
      confirmedBookings: bookings.filter((booking) => booking.status === 'confirmed'),
      externalReservations,
    };
  }

  async checkBookingConflict(
    {
      venueId,
      bookingType = 'hourly',
      bookingDate = null,
      occupiedStartAt = null,
      occupiedEndAt = null,
      excludeBookingId = null,
      excludeExternalReservationId = null,
    },
    executor = this.database,
  ) {
    const [venues] = await executor.execute('SELECT timezone FROM venues WHERE id=?', [venueId]);
    if (!venues[0]) return { conflict: true, reason: 'VENUE_NOT_FOUND' };
    const timezone = venues[0].timezone;
    let start = occupiedStartAt ? new Date(occupiedStartAt) : null;
    let end = occupiedEndAt ? new Date(occupiedEndAt) : null;
    if (bookingType === 'daily') {
      const dailyDate = dateOnly(bookingDate);
      if (!dailyDate) return { conflict: true, reason: 'INVALID_INTERVAL' };
      start = localDateTimeToUtc(dailyDate, '00:00', timezone, 'start');
      end = localDateTimeToUtc(addDays(dailyDate, 1), '00:00', timezone, 'start');
    }
    if (
      !start ||
      !end ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start >= end
    )
      return { conflict: true, reason: 'INVALID_INTERVAL' };
    const [bookings] = await executor.execute(
      `SELECT id, booking_type AS bookingType, booking_date AS bookingDate, venue_timezone AS venueTimezone,
      occupied_start_at AS startAt, occupied_end_at AS endAt FROM venue_bookings
      WHERE venue_id=? AND status IN ('requested', 'confirmed')${excludeBookingId ? ' AND id <> ?' : ''} FOR UPDATE`,
      excludeBookingId ? [venueId, excludeBookingId] : [venueId],
    );
    const [reservations] = await executor.execute(
      `SELECT id, start_at AS startAt, end_at AS endAt FROM venue_external_reservations
      WHERE venue_id=? AND cancelled_at IS NULL${excludeExternalReservationId ? ' AND id <> ?' : ''} FOR UPDATE`,
      excludeExternalReservationId ? [venueId, excludeExternalReservationId] : [venueId],
    );
    const occupied = [
      ...reservations,
      ...bookings.flatMap((booking) => {
        if (booking.bookingType !== 'daily') return [booking];
        const date = dateOnly(booking.bookingDate);
        if (!date) return [];
        const bookingTimezone = booking.venueTimezone || timezone;
        const startAt = localDateTimeToUtc(date, '00:00', bookingTimezone, 'start');
        const endAt = localDateTimeToUtc(addDays(date, 1), '00:00', bookingTimezone, 'start');
        return startAt && endAt ? [{ ...booking, startAt, endAt }] : [];
      }),
    ];
    return {
      conflict: occupied.some(
        (item) => start < new Date(item.endAt) && end > new Date(item.startAt),
      ),
    };
  }

  async createVenueAvailabilityBlock(venueId, userId, role, block) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return null;
    const [result] = await this.database.execute(
      'INSERT INTO venue_availability_blocks (venue_id, start_at, end_at, reason, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
      [venueId, block.startAt, block.endAt, block.reason, userId],
    );
    return result.insertId;
  }

  async deleteVenueAvailabilityBlock(venueId, blockId, userId, role) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return false;
    const [result] = await this.database.execute(
      'DELETE FROM venue_availability_blocks WHERE id=? AND venue_id=?',
      [blockId, venueId],
    );
    return result.affectedRows > 0;
  }

  async createExternalReservation(venueId, userId, role, reservation) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return { error: 'FORBIDDEN' };
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [venues] = await connection.execute('SELECT id FROM venues WHERE id=? FOR UPDATE', [
        venueId,
      ]);
      if (!venues[0]) {
        await connection.rollback();
        return { error: 'NOT_FOUND' };
      }
      const checked = await this.queries.checkBookingConflict(
        { venueId, occupiedStartAt: reservation.startAt, occupiedEndAt: reservation.endAt },
        connection,
      );
      if (checked.conflict) {
        await connection.rollback();
        return { error: checked.reason || 'CONFLICT' };
      }
      const [result] = await connection.execute(
        `INSERT INTO venue_external_reservations (venue_id, start_at, end_at, source, title, notes, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          venueId,
          reservation.startAt,
          reservation.endAt,
          reservation.source,
          reservation.title,
          reservation.notes,
          userId,
        ],
      );
      await connection.commit();
      return { id: result.insertId };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async cancelExternalReservation(venueId, reservationId, userId, role) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return false;
    const [result] = await this.database.execute(
      'UPDATE venue_external_reservations SET cancelled_at=NOW() WHERE id=? AND venue_id=? AND cancelled_at IS NULL AND start_at > NOW()',
      [reservationId, venueId],
    );
    return result.affectedRows > 0;
  }
}
