import { localDateTimeToUtc } from '../../../domain/venues/venue-availability.js';
import { zonedDateTime } from '../../../utils/time.js';
import { utcTimestamp, jsonValue } from '../../../utils/serialization.js';
export class EventsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async eventCategories() {
    const [rows] = await this.database.execute(
      'SELECT id, name, slug, description, icon, sort_order AS sortOrder FROM event_categories WHERE is_active = TRUE ORDER BY sort_order, name',
    );
    return rows;
  }

  async eventTypes() {
    const [rows] = await this.database.execute(
      'SELECT id, name, slug, description FROM event_types WHERE is_active = TRUE ORDER BY name',
    );
    return rows;
  }

  async taxonomyExists(categoryId, typeId) {
    const [categories] = await this.database.execute(
      'SELECT id FROM event_categories WHERE id = ? AND is_active = TRUE',
      [categoryId],
    );
    const [types] = await this.database.execute(
      'SELECT id FROM event_types WHERE id = ? AND is_active = TRUE',
      [typeId],
    );
    return categories.length > 0 && types.length > 0;
  }

  async eventLocationVenue(id) {
    const [rows] = await this.database.execute(
      "SELECT id, timezone FROM venues WHERE id = ? AND COALESCE(is_active, TRUE) = TRUE AND moderation_status = 'approved'",
      [id],
    );
    return rows[0] || null;
  }

  richEventInsertValues(data, occurrenceNumber = 1) {
    const recurrence = data.recurrence || { frequency: 'none', interval: 1, count: 1 };
    const values = [
      data.managerId,
      data.title,
      data.brandName,
      data.logoImage,
      data.shortDescription,
      data.description,
      JSON.stringify(data.foodOptions || []),
      data.coverImage,
      data.categoryId,
      data.typeId,
      data.locationType,
      data.locationVisibility,
      data.startsAt,
      data.endsAt,
      data.timezone,
      data.cancellationPolicy,
      data.pricingType,
      data.fee,
      data.currency,
      data.registrationType,
      data.externalRegistrationUrl,
      data.visibility,
      data.groupId,
      recurrence.frequency,
      recurrence.interval,
      recurrence.count,
      occurrenceNumber,
      data.venueId,
      data.customAddressLine1,
      data.customAddressLine2,
      data.customPostalCode,
      data.customLocality,
      data.customMunicipality,
      data.customRegion,
      data.customCountry,
      data.customCountryCode,
      data.customLatitude,
      data.customLongitude,
      data.customGooglePlaceId,
      data.customFormattedAddress,
      data.onlineUrl,
      data.onlinePlatform,
    ];
    return values.map((value) =>
      value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : value,
    );
  }

  async insertRichEvent(connection, data, occurrenceNumber) {
    const values = this.queries.richEventInsertValues(data, occurrenceNumber);
    if (values.length !== 42)
      throw new Error(
        `Rich event parameter contract failed: expected 42 values, received ${values.length}.`,
      );
    const placeholders = values.map(() => '?').join(', ');
    const [result] = await connection.query(
      `INSERT INTO events
      (manager_id, title, brand_name, logo_image, short_description, description, food_options, cover_image, category_id, type_id, location_type, location_visibility, starts_at, ends_at, timezone, cancellation_policy, pricing_type, participation_fee, currency,
       registration_type, external_registration_url, visibility, group_id, recurrence_frequency, recurrence_interval, recurrence_count, occurrence_number,
       venue_id, custom_address_line_1, custom_address_line_2, custom_postal_code, custom_locality, custom_municipality, custom_region,
       custom_country, custom_country_code, custom_latitude, custom_longitude, custom_google_place_id, custom_formatted_address, online_url, online_platform, status)
      VALUES (${placeholders}, 'Draft')`,
      values,
    );
    if (data.organizerOrganizationId)
      await connection.execute('UPDATE events SET organizer_organization_id=? WHERE id=?', [
        data.organizerOrganizationId,
        result.insertId,
      ]);
    return result.insertId;
  }

  recurringDate(date, frequency, interval) {
    const next = new Date(date);
    if (frequency === 'daily') next.setUTCDate(next.getUTCDate() + interval);
    else if (frequency === 'weekly') next.setUTCDate(next.getUTCDate() + interval * 7);
    else {
      const day = next.getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + interval);
      const lastDay = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      next.setUTCDate(Math.min(day, lastDay));
    }
    return next;
  }

  async createRichEventSeries(data, { bookVenue = false, role, buyerBillingProfileId } = {}) {
    const recurrence = data.recurrence || { frequency: 'none', interval: 1, count: 1 };
    const count = recurrence.frequency === 'none' ? 1 : recurrence.count;
    const connection = await this.database.getConnection();
    const requestBookings = async (eventIds) => {
      if (!bookVenue || !data.venueId || !data.startsAt || !data.endsAt) return;
      for (const eventId of eventIds) {
        const result = await this.queries.requestVenueBookingOnConnection(
          connection,
          eventId,
          data.venueId,
          data.managerId,
          role,
          buyerBillingProfileId,
        );
        if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
      }
    };
    try {
      await connection.beginTransaction();
      if (count === 1) {
        const eventId = await this.queries.insertRichEvent(connection, data, 1);
        await requestBookings([eventId]);
        await connection.commit();
        return { seriesId: null, eventIds: [eventId] };
      }
      if (!data.startsAt) throw new Error('Recurring events require a start date.');
      const startsAt = new Date(`${data.startsAt.replace(' ', 'T')}Z`);
      const endsAt = data.endsAt ? new Date(`${data.endsAt.replace(' ', 'T')}Z`) : null;
      const duration = endsAt ? endsAt.getTime() - startsAt.getTime() : null;
      const localStart = zonedDateTime(startsAt, data.timezone);
      if (!localStart) throw new Error('Recurring event requires a valid IANA timezone.');
      const eventIds = [];
      for (let occurrenceNumber = 1; occurrenceNumber <= count; occurrenceNumber += 1) {
        const occurrenceDate =
          occurrenceNumber === 1
            ? localStart.date
            : this.queries
                .recurringDate(
                  new Date(`${localStart.date}T12:00:00Z`),
                  recurrence.frequency,
                  recurrence.interval * (occurrenceNumber - 1),
                )
                .toISOString()
                .slice(0, 10);
        const occurrenceStart =
          occurrenceNumber === 1
            ? startsAt
            : localDateTimeToUtc(occurrenceDate, localStart.time, data.timezone, 'start');
        if (!occurrenceStart)
          throw new Error(
            'A recurring event falls on a non-existent local time due to daylight saving time.',
          );
        const occurrence = {
          ...data,
          startsAt: occurrenceStart.toISOString().slice(0, 19).replace('T', ' '),
          endsAt:
            duration === null
              ? null
              : new Date(occurrenceStart.getTime() + duration)
                  .toISOString()
                  .slice(0, 19)
                  .replace('T', ' '),
        };
        eventIds.push(await this.queries.insertRichEvent(connection, occurrence, occurrenceNumber));
      }
      const seriesId = count > 1 ? eventIds[0] : null;
      if (seriesId)
        await connection.query(
          `UPDATE events SET series_id = ? WHERE id IN (${eventIds.map(() => '?').join(', ')})`,
          [seriesId, ...eventIds],
        );
      await requestBookings(eventIds);
      await connection.commit();
      return { seriesId, eventIds };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createRichEvent(data) {
    return (await this.queries.createRichEventSeries(data)).eventIds[0];
  }

  async updateRichEventAndBooking(id, userId, role, data, buyerBillingProfileId) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const privileged = ['manager', 'admin'].includes(role);
      const [events] = await connection.execute(
        `SELECT manager_id AS managerId FROM events WHERE id=? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id=?'} FOR UPDATE`,
        privileged ? [id] : [id, userId],
      );
      if (!events[0]) {
        await connection.rollback();
        return false;
      }
      const [bookings] = await connection.execute(
        'SELECT venue_id AS venueId, start_at AS startAt, end_at AS endAt, status FROM venue_bookings WHERE event_id=? FOR UPDATE',
        [id],
      );
      const booking = bookings[0];
      if (
        booking &&
        ['requested', 'confirmed'].includes(booking.status) &&
        (Number(booking.venueId) !== Number(data.venueId) ||
          utcTimestamp(booking.startAt) !== utcTimestamp(data.startsAt) ||
          utcTimestamp(booking.endAt) !== utcTimestamp(data.endsAt))
      ) {
        throw Object.assign(
          new Error('Cancel the active booking before changing the venue or booking time.'),
          { code: 'EVENT_ALREADY_BOOKED' },
        );
      }
      if (!(await this.queries.updateRichEvent(id, userId, role, data, connection))) {
        await connection.rollback();
        return false;
      }
      // Saving a previously untimed draft (or an older draft whose request
      // failed) must create the missing booking. Preserve existing decisions.
      if (!booking && data.venueId && data.startsAt && data.endsAt) {
        const result = await this.queries.requestVenueBookingOnConnection(
          connection,
          id,
          data.venueId,
          events[0].managerId,
          role,
          buyerBillingProfileId,
        );
        if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
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

  async updateRichEvent(id, managerId, role, data, executor = this.database) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?';
    const params = [
      data.title,
      data.brandName,
      data.logoImage,
      data.shortDescription,
      data.description,
      data.foodOptions === undefined ? null : JSON.stringify(data.foodOptions),
      data.coverImage,
      data.categoryId,
      data.typeId,
      data.locationType,
      data.locationVisibility,
      data.startsAt,
      data.endsAt,
      data.timezone,
      data.cancellationPolicy,
      data.pricingType,
      data.fee,
      data.currency,
      data.registrationType,
      data.externalRegistrationUrl,
      data.visibility,
      data.venueId,
      data.customAddressLine1,
      data.customAddressLine2,
      data.customPostalCode,
      data.customLocality,
      data.customMunicipality,
      data.customRegion,
      data.customCountry,
      data.customCountryCode,
      data.customLatitude,
      data.customLongitude,
      data.customGooglePlaceId,
      data.customFormattedAddress,
      data.onlineUrl,
      data.onlinePlatform,
      id,
    ].map((value) =>
      value === undefined || (typeof value === 'number' && Number.isNaN(value)) ? null : value,
    );
    if (!['manager', 'admin'].includes(role)) params.push(managerId);
    const [result] = await executor.query(
      `UPDATE events SET title=?, brand_name=COALESCE(?,brand_name), logo_image=COALESCE(?,logo_image), short_description=?, description=?, food_options=COALESCE(?,food_options), cover_image=?, category_id=?, type_id=?, location_type=?, location_visibility=?, starts_at=?, ends_at=?, timezone=?, cancellation_policy=?, pricing_type=?, participation_fee=?, currency=?, registration_type=?, external_registration_url=?, visibility=?, venue_id=?, custom_address_line_1=?, custom_address_line_2=?, custom_postal_code=?, custom_locality=?, custom_municipality=?, custom_region=?, custom_country=?, custom_country_code=?, custom_latitude=?, custom_longitude=?, custom_google_place_id=?, custom_formatted_address=?, online_url=?, online_platform=? WHERE id=? AND deleted_at IS NULL${scope}`,
      params,
    );
    return result.affectedRows > 0;
  }

  async updateEventSchedule(id, managerId, role, { startsAt, endsAt, venueId, timezone }) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id = ?';
    const params = [startsAt, endsAt, timezone, venueId, id];
    if (!['manager', 'admin'].includes(role)) params.push(managerId);
    const [result] = await this.database.execute(
      `UPDATE events SET starts_at=?, ends_at=?, timezone=?, venue_id=?, location_type='venue'
      WHERE id=? AND deleted_at IS NULL${scope}`,
      params,
    );
    return result.affectedRows > 0;
  }

  async setEventCover(id, managerId, role, coverImage) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(
      `SELECT COALESCE(series_id, id) AS seriesId FROM events WHERE id = ? AND deleted_at IS NULL${globalAccess ? '' : ' AND manager_id = ?'}`,
      globalAccess ? [id] : [id, managerId],
    );
    if (!events[0]) return false;
    const [result] = await this.database.execute(
      'UPDATE events SET cover_image = ? WHERE id = ? OR series_id = ?',
      [coverImage, events[0].seriesId, events[0].seriesId],
    );
    return result.affectedRows > 0;
  }

  async eventCoverVisible(filename, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const visibility = privileged
      ? 'TRUE'
      : "(e.status = 'Published' AND e.visibility = 'Public') OR e.manager_id = ?";
    const [rows] = await this.database.execute(
      `SELECT e.id, (e.status = 'Published' AND e.visibility = 'Public') AS publiclyVisible FROM events e WHERE BINARY e.cover_image = BINARY ? AND e.deleted_at IS NULL AND (${visibility}) LIMIT 1`,
      privileged ? [filename] : [filename, userId],
    );
    return rows[0] ? { ...rows[0], publiclyVisible: Boolean(rows[0].publiclyVisible) } : null;
  }

  normalizeRichEventLocation(event, { publicView = false } = {}) {
    if (!event) return null;
    const normalized = { ...event };
    const foodOptions = jsonValue(normalized.foodOptions);
    normalized.foodOptions = Array.isArray(foodOptions) ? foodOptions : [];
    // All occurrence fields exposed by the API are unambiguous UTC instants.
    // The event timezone remains the canonical local-time context.
    for (const key of ['startsAt', 'endsAt', 'publishedAt', 'createdAt', 'updatedAt'])
      normalized[key] = utcTimestamp(normalized[key]);
    for (const key of ['customLatitude', 'customLongitude'])
      if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    const customLocation = {
      addressLine1: normalized.customAddressLine1 || null,
      addressLine2: normalized.customAddressLine2 || null,
      postalCode: normalized.customPostalCode || null,
      locality: normalized.customLocality || null,
      municipality: normalized.customMunicipality || null,
      region: normalized.customRegion || null,
      country: normalized.customCountry || null,
      countryCode: normalized.customCountryCode || null,
      latitude: normalized.customLatitude ?? null,
      longitude: normalized.customLongitude ?? null,
      googlePlaceId: normalized.customGooglePlaceId || null,
      formattedAddress: normalized.customFormattedAddress || null,
    };
    if (normalized.locationType === 'venue') {
      const venue = this.queries.normalizeVenue(
        {
          id: normalized.venueId,
          name: normalized.venueName,
          addressLine1: normalized.venueAddressLine1,
          addressLine2: normalized.venueAddressLine2,
          postalCode: normalized.venuePostalCode,
          city: normalized.venueCity,
          municipality: normalized.venueMunicipality,
          region: normalized.venueRegion,
          country: normalized.venueCountry,
          countryCode: normalized.venueCountryCode,
          latitude: normalized.venueLatitude,
          longitude: normalized.venueLongitude,
          googlePlaceId: normalized.venueGooglePlaceId,
          formattedAddress: normalized.venueFormattedAddress,
          locationVisibility: normalized.venueLocationVisibility,
          timezone: normalized.venueTimezone,
        },
        { publicView },
      );
      normalized.venue = venue?.id
        ? { id: venue.id, name: venue.name, location: venue.location, timezone: venue.timezone }
        : null;
      normalized.location = null;
    } else if (normalized.locationType === 'online') {
      normalized.venue = null;
      normalized.location = null;
      normalized.onlineUrl = publicView ? null : normalized.onlineUrl || null;
    } else {
      normalized.venue = null;
      normalized.location = customLocation;
    }
    for (const key of [
      'customAddressLine1',
      'customAddressLine2',
      'customPostalCode',
      'customLocality',
      'customMunicipality',
      'customRegion',
      'customCountry',
      'customCountryCode',
      'customLatitude',
      'customLongitude',
      'customGooglePlaceId',
      'customFormattedAddress',
      'venueId',
      'venueName',
      'venueBusinessName',
      'venueLocation',
      'venueAddressLine1',
      'venueAddressLine2',
      'venuePostalCode',
      'venueCity',
      'venueMunicipality',
      'venueRegion',
      'venueCountry',
      'venueCountryCode',
      'venueLatitude',
      'venueLongitude',
      'venueGooglePlaceId',
      'venueFormattedAddress',
      'venueLocationVisibility',
      'venueTimezone',
    ])
      delete normalized[key];
    return normalized;
  }

  async richEvent(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.query(
      `SELECT e.id, e.manager_id AS managerId, e.organizer_organization_id AS organizerOrganizationId, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.short_description AS shortDescription, e.description, e.food_options AS foodOptions, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl,
      e.category_id AS categoryId, c.name AS categoryName, e.type_id AS typeId, t.name AS typeName,
      e.location_type AS locationType, e.location_visibility AS locationVisibility, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone,
      e.cancellation_policy AS cancellationPolicy,
      e.pricing_type AS pricingType, e.participation_fee AS fee, e.currency, e.registration_type AS registrationType, e.external_registration_url AS externalRegistrationUrl,
      e.visibility, e.status, e.published_at AS publishedAt, e.created_at AS createdAt, e.updated_at AS updatedAt, u.name AS managerName,
      e.group_id AS groupId, g.name AS groupName, g.slug AS groupSlug, e.series_id AS seriesId, e.recurrence_frequency AS recurrenceFrequency, e.recurrence_interval AS recurrenceInterval, e.recurrence_count AS recurrenceCount, e.occurrence_number AS occurrenceNumber,
      e.venue_id AS venueId, v.timezone AS venueTimezone, e.custom_address_line_1 AS customAddressLine1, e.custom_address_line_2 AS customAddressLine2, e.custom_postal_code AS customPostalCode, e.custom_locality AS customLocality, e.custom_municipality AS customMunicipality, e.custom_region AS customRegion, e.custom_country AS customCountry, e.custom_country_code AS customCountryCode, e.custom_latitude AS customLatitude, e.custom_longitude AS customLongitude, e.custom_google_place_id AS customGooglePlaceId, e.custom_formatted_address AS customFormattedAddress, e.online_url AS onlineUrl, e.online_platform AS onlinePlatform,
      vb.id AS venueBookingId, vb.status AS venueBookingStatus, v.name AS venueName, v.business_name AS venueBusinessName, v.formatted_address AS venueLocation, v.address_line_1 AS venueAddressLine1, v.address_line_2 AS venueAddressLine2, v.postal_code AS venuePostalCode, v.city AS venueCity, v.municipality AS venueMunicipality, v.region AS venueRegion, v.country AS venueCountry, v.country_code AS venueCountryCode, v.latitude AS venueLatitude, v.longitude AS venueLongitude, v.google_place_id AS venueGooglePlaceId, v.formatted_address AS venueFormattedAddress, v.location_visibility AS venueLocationVisibility,
      (SELECT ROUND(AVG(rating), 2) FROM event_ratings WHERE event_id = e.id) AS ratingAverage, (SELECT COUNT(*) FROM event_ratings WHERE event_id = e.id) AS ratingCount,
      (SELECT rating FROM event_ratings WHERE event_id = e.id AND user_id = ?) AS myRating
      FROM events e JOIN users u ON u.id=e.manager_id LEFT JOIN event_categories c ON c.id=e.category_id LEFT JOIN event_types t ON t.id=e.type_id LEFT JOIN event_groups g ON g.id=e.group_id LEFT JOIN venue_bookings vb ON vb.event_id = e.id LEFT JOIN venues v ON v.id = e.venue_id
      WHERE e.id=? AND e.deleted_at IS NULL AND (${privileged ? 'TRUE' : "e.visibility = 'Public' AND e.status = 'Published'"}${userId && !privileged ? ' OR e.manager_id = ?' : ''})`,
      userId && !privileged ? [userId, id, userId] : [userId, id],
    );
    return this.queries.normalizeRichEventLocation(rows[0], {
      publicView: !privileged && (!userId || rows[0]?.managerId !== userId),
    });
  }

  async publishRichEvent(id, managerId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [events] = await this.database.execute(
      `SELECT COALESCE(series_id, id) AS seriesId FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`,
      privileged ? [id] : [id, managerId],
    );
    if (!events[0]) return false;
    const [result] = await this.database.execute(
      'UPDATE events SET status = ?, published_at = COALESCE(published_at, NOW()) WHERE deleted_at IS NULL AND (id = ? OR series_id = ?)',
      ['Published', events[0].seriesId, events[0].seriesId],
    );
    return result.affectedRows > 0;
  }

  async updateEventStatus(id, userId, status, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const ownership = globalAccess ? '' : ' AND manager_id = ?';
    const params = globalAccess ? [status, id] : [status, id, userId];
    const [result] = await this.database.execute(
      `UPDATE events SET status = ? WHERE id = ? AND status <> 'Completed'${ownership}`,
      params,
    );
    return result.affectedRows > 0;
  }

  async finishEvent(id, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(
      `UPDATE events SET status = 'Completed' WHERE id = ? AND status = 'Published' AND COALESCE(ends_at, starts_at) <= UTC_TIMESTAMP() AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`,
      privileged ? [id] : [id, userId],
    );
    return result.affectedRows > 0;
  }
}
