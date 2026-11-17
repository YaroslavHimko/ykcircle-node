export class VenuesRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async venueMedia(venueId) {
    const [rows] = await this.database.execute(
      'SELECT id, filename, alt_text AS altText, caption, is_cover AS isCover, sort_order AS sortOrder, created_at AS createdAt FROM venue_media WHERE venue_id = ? ORDER BY is_cover DESC, sort_order, id',
      [venueId],
    );
    return rows.map((item) => ({ ...item, isCover: Boolean(item.isCover) }));
  }

  async addVenueMedia(venueId, filename, altText, caption, isCover) {
    if (isCover)
      await this.database.execute('UPDATE venue_media SET is_cover = FALSE WHERE venue_id = ?', [
        venueId,
      ]);
    const [order] = await this.database.execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM venue_media WHERE venue_id = ?',
      [venueId],
    );
    const [result] = await this.database.execute(
      'INSERT INTO venue_media (venue_id, filename, alt_text, caption, is_cover, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [venueId, filename, altText, caption, isCover, order[0].nextOrder],
    );
    return result.insertId;
  }

  async venueImageVisible(filename, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const visibility = privileged
      ? 'TRUE'
      : "(v.is_active = TRUE AND v.moderation_status = 'approved') OR v.owner_user_id = ? OR om.role IN ('owner','admin','manager')";
    // publiclyVisible drives the proxy's cache header: an image readable only
    // because the viewer manages the venue must never enter a shared cache.
    const [rows] = await this.database.execute(
      `SELECT m.id, (v.is_active = TRUE AND v.moderation_status = 'approved') AS publiclyVisible FROM venue_media m JOIN venues v ON v.id = m.venue_id LEFT JOIN organization_members om ON om.organization_id = v.organization_id AND om.user_id = ? WHERE m.filename = ? AND (${visibility})`,
      privileged ? [userId, filename] : [userId, filename, userId],
    );
    return rows[0] ? { ...rows[0], publiclyVisible: Boolean(rows[0].publiclyVisible) } : null;
  }

  async venue(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT ${this.queries.venueColumns()}, owner.name AS ownerName, organization.name AS organizationName, organization.slug AS organizationSlug, member.role AS membershipRole, type.slug AS venueType, type.name AS venueTypeName FROM venues v JOIN users owner ON owner.id = v.owner_user_id LEFT JOIN organizations organization ON organization.id = v.organization_id LEFT JOIN organization_members member ON member.organization_id = v.organization_id AND member.user_id = ? LEFT JOIN venue_types type ON type.id = v.venue_type_id WHERE v.id = ? AND (${privileged ? 'TRUE' : 'COALESCE(v.is_active, TRUE) = TRUE OR v.owner_user_id = ? OR member.user_id IS NOT NULL'})`,
      privileged ? [userId, id] : [userId, id, userId],
    );
    if (!rows[0]) return null;
    const managed = privileged || rows[0].ownerUserId === userId || Boolean(rows[0].membershipRole);
    // canManage travels with the payload so the API can decide whether image
    // URLs need a signed token, without repeating the membership lookup.
    return {
      ...(await this.queries.decorateVenue(rows[0], { publicView: !managed })),
      canManage: managed,
      availability: await this.queries.venueAvailability(id),
      images: await this.queries.venueMedia(id),
    };
  }

  async venueBySlug(slug, userId = null, role = null) {
    const [rows] = await this.database.execute('SELECT id FROM venues WHERE slug = ?', [slug]);
    return rows[0] ? this.queries.venue(rows[0].id, userId, role) : null;
  }

  async venuesForViewer(
    userId = null,
    role = null,
    {
      managedOnly = false,
      ownedOnly = false,
      city = null,
      venueType = null,
      eventType = null,
      amenities = [],
      minCapacity = null,
      maxCapacity = null,
      maxPrice = null,
      verifiedOnly = false,
    } = {},
  ) {
    const privileged = ['manager', 'admin'].includes(role);
    // Do not add an owner predicate for an anonymous visitor.  Besides making
    // the public intent unambiguous, this avoids relying on a NULL-bound
    // placeholder in the public listing query.  COALESCE keeps venues made
    // before the NOT NULL default was introduced visible until their row is
    // active venues are always represented by the current schema contract.
    let filter = 'TRUE';
    let parameters = [];
    if (ownedOnly) {
      filter = 'v.owner_user_id = ?';
      parameters = [userId];
    } else if (managedOnly) {
      if (!privileged) {
        filter =
          "(v.owner_user_id = ? OR EXISTS (SELECT 1 FROM organization_members managed_member WHERE managed_member.organization_id = v.organization_id AND managed_member.user_id = ? AND managed_member.role IN ('owner','admin','manager')))";
        parameters = [userId, userId];
      }
    } else if (!privileged) {
      filter = 'COALESCE(v.is_active, TRUE) = TRUE';
      if (userId !== null) {
        filter = `(${filter} OR v.owner_user_id = ?)`;
        parameters = [userId];
      }
    }
    if (city) {
      filter += ' AND (v.city = ? OR v.municipality = ?)';
      parameters.push(city, city);
    }
    if (venueType) {
      filter +=
        ' AND EXISTS (SELECT 1 FROM venue_types type WHERE type.id = v.venue_type_id AND type.slug = ?)';
      parameters.push(venueType);
    }
    if (eventType) {
      filter +=
        ' AND EXISTS (SELECT 1 FROM venue_event_type_assignments veta JOIN venue_event_types vet ON vet.id = veta.event_type_id WHERE veta.venue_id = v.id AND vet.slug = ?)';
      parameters.push(eventType);
    }
    for (const amenity of amenities) {
      filter +=
        ' AND EXISTS (SELECT 1 FROM venue_amenity_assignments va JOIN venue_amenities a ON a.id = va.amenity_id WHERE va.venue_id = v.id AND a.slug = ?)';
      parameters.push(amenity);
    }
    if (minCapacity != null) {
      filter += ' AND COALESCE(v.capacity_max, v.standing_capacity, v.seated_capacity, 0) >= ?';
      parameters.push(minCapacity);
    }
    if (maxCapacity != null) {
      filter += ' AND COALESCE(v.capacity_min, 0) <= ?';
      parameters.push(maxCapacity);
    }
    if (maxPrice != null) {
      filter += " AND (v.price_unit = 'contact' OR v.price_from IS NULL OR v.price_from <= ?)";
      parameters.push(maxPrice);
    }
    if (verifiedOnly) filter += " AND v.verification_status = 'verified'";
    const [rows] = await this.database.execute(
      `SELECT ${this.queries.venueColumns()}, owner.name AS ownerName, organization.name AS organizationName, organization.slug AS organizationSlug, type.slug AS venueType, type.name AS venueTypeName, EXISTS (SELECT 1 FROM venue_promotions p WHERE p.venue_id = v.id AND p.status = 'active' AND p.starts_at <= NOW() AND p.ends_at > NOW()) AS sponsored FROM venues v JOIN users owner ON owner.id = v.owner_user_id LEFT JOIN organizations organization ON organization.id = v.organization_id LEFT JOIN venue_types type ON type.id = v.venue_type_id WHERE ${filter} ORDER BY sponsored DESC, v.is_featured DESC, v.created_at DESC`,
      parameters,
    );
    // A managedOnly listing is already filtered to venues the viewer manages.
    // The public listing only surfaces an inactive venue through the owner
    // predicate above, so an owner check is sufficient to flag it there.
    return Promise.all(
      rows.map(async (venue) => ({
        ...(await this.queries.decorateVenue(venue, {
          publicView: !ownedOnly && !managedOnly && !privileged,
        })),
        canManage:
          ownedOnly ||
          managedOnly ||
          privileged ||
          (userId !== null && venue.ownerUserId === userId),
      })),
    );
  }

  async createVenue(ownerUserId, data) {
    const [result] = await this.database.execute(
      `INSERT INTO venues (organization_id, billing_profile_id, owner_user_id, name, slug, business_name, logo_image, short_description, description, address_line_1, address_line_2, postal_code, country, country_code, city, municipality, region, latitude, longitude, google_place_id, formatted_address, location_visibility, timezone, venue_type_id, capacity_min, capacity_max, standing_capacity, seated_capacity, dining_capacity, classroom_capacity, size_sqm, price_from, price_unit, currency, pricing_description, minimum_booking_hours, website_url, phone, contact_email, availability_type, house_rules_text, is_active, moderation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM venue_types WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        data.organizationId,
        data.billingProfileId,
        ownerUserId,
        data.name,
        data.slug,
        data.businessName,
        data.logoImage,
        data.shortDescription,
        data.description,
        data.addressLine1,
        data.addressLine2,
        data.postalCode,
        data.country,
        data.countryCode,
        data.city,
        data.municipality,
        data.region,
        data.latitude,
        data.longitude,
        data.googlePlaceId,
        data.formattedAddress,
        data.locationVisibility,
        data.timezone,
        data.venueType,
        data.capacityMin,
        data.capacityMax,
        data.standingCapacity,
        data.seatedCapacity,
        data.diningCapacity,
        data.classroomCapacity,
        data.sizeSqm,
        data.priceFrom,
        data.priceUnit,
        data.currency,
        data.pricingDescription,
        data.minimumBookingHours,
        data.websiteUrl,
        data.phone,
        data.contactEmail,
        data.availabilityType,
        data.houseRulesText,
        data.isActive,
      ],
    );
    await this.database.execute(
      'INSERT INTO venue_booking_settings (venue_id, currency, hourly_rate) VALUES (?, ?, ?)',
      [result.insertId, data.currency, data.priceFrom],
    );
    await this.queries.replaceVenueRelations(
      result.insertId,
      data.amenitySlugs,
      data.suitableEventTypeSlugs,
    );
    await this.queries.replaceVenueAvailabilitySlots(result.insertId, data.availability || []);
    return result.insertId;
  }

  async replaceVenueRelations(venueId, amenitySlugs = [], eventTypeSlugs = []) {
    await this.database.execute('DELETE FROM venue_amenity_assignments WHERE venue_id = ?', [
      venueId,
    ]);
    await this.database.execute('DELETE FROM venue_event_type_assignments WHERE venue_id = ?', [
      venueId,
    ]);
    for (const slug of amenitySlugs)
      await this.database.execute(
        'INSERT INTO venue_amenity_assignments (venue_id, amenity_id) SELECT ?, id FROM venue_amenities WHERE slug = ?',
        [venueId, slug],
      );
    for (const slug of eventTypeSlugs)
      await this.database.execute(
        'INSERT INTO venue_event_type_assignments (venue_id, event_type_id) SELECT ?, id FROM venue_event_types WHERE slug = ?',
        [venueId, slug],
      );
  }

  async updateVenue(id, userId, role, data) {
    if (!(await this.queries.canManageVenue(id, userId, role))) return false;
    const [result] = await this.database.execute(
      'UPDATE venues SET organization_id=?, billing_profile_id=?, name=?, slug=?, business_name=?, logo_image=?, short_description=?, description=?, address_line_1=?, address_line_2=?, postal_code=?, country=?, country_code=?, city=?, municipality=?, region=?, latitude=?, longitude=?, google_place_id=?, formatted_address=?, location_visibility=?, timezone=?, venue_type_id=(SELECT id FROM venue_types WHERE slug=?), capacity_min=?, capacity_max=?, standing_capacity=?, seated_capacity=?, dining_capacity=?, classroom_capacity=?, size_sqm=?, price_from=?, price_unit=?, currency=?, pricing_description=?, minimum_booking_hours=?, website_url=?, phone=?, contact_email=?, availability_type=?, house_rules_text=?, is_active=? WHERE id=?',
      [
        data.organizationId,
        data.billingProfileId,
        data.name,
        data.slug,
        data.businessName,
        data.logoImage,
        data.shortDescription,
        data.description,
        data.addressLine1,
        data.addressLine2,
        data.postalCode,
        data.country,
        data.countryCode,
        data.city,
        data.municipality,
        data.region,
        data.latitude,
        data.longitude,
        data.googlePlaceId,
        data.formattedAddress,
        data.locationVisibility,
        data.timezone,
        data.venueType,
        data.capacityMin,
        data.capacityMax,
        data.standingCapacity,
        data.seatedCapacity,
        data.diningCapacity,
        data.classroomCapacity,
        data.sizeSqm,
        data.priceFrom,
        data.priceUnit,
        data.currency,
        data.pricingDescription,
        data.minimumBookingHours,
        data.websiteUrl,
        data.phone,
        data.contactEmail,
        data.availabilityType,
        data.houseRulesText,
        data.isActive,
        id,
      ],
    );
    if (!result.affectedRows) return false;
    await this.queries.replaceVenueRelations(id, data.amenitySlugs, data.suitableEventTypeSlugs);
    await this.queries.replaceVenueAvailabilitySlots(id, data.availability || []);
    return true;
  }

  async deleteVenue(id, userId, role) {
    if (!(await this.queries.canManageVenue(id, userId, role))) return false;
    const [result] = await this.database.execute('DELETE FROM venues WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async createVenueInquiry(venueId, organizerUserId, data) {
    const [result] = await this.database.execute(
      `INSERT INTO venue_inquiries (venue_id, organizer_user_id, event_id, event_name, event_type, requested_date, start_time, end_time, expected_guests, budget, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        venueId,
        organizerUserId,
        data.eventId,
        data.eventName,
        data.eventType,
        data.requestedDate,
        data.startTime,
        data.endTime,
        data.expectedGuests,
        data.budget,
        data.message,
      ],
    );
    return result.insertId;
  }

  async eventForVenueInquiry(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`,
      privileged ? [eventId] : [eventId, userId],
    );
    return rows[0] || null;
  }

  async venueInquiries(venueId, userId, role) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return null;
    const [rows] = await this.database.execute(
      `SELECT i.id, i.venue_id AS venueId, i.organizer_user_id AS organizerUserId, i.event_id AS eventId, i.event_name AS eventName, i.event_type AS eventType, i.requested_date AS requestedDate, TIME_FORMAT(i.start_time, '%H:%i') AS startTime, TIME_FORMAT(i.end_time, '%H:%i') AS endTime, i.expected_guests AS expectedGuests, i.budget, i.message, i.status, i.created_at AS createdAt, i.updated_at AS updatedAt, u.name AS organizerName FROM venue_inquiries i JOIN users u ON u.id = i.organizer_user_id WHERE i.venue_id = ? ORDER BY i.created_at DESC`,
      [venueId],
    );
    return rows;
  }

  async updateVenueInquiryStatus(inquiryId, venueId, userId, role, status) {
    if (!(await this.queries.canManageVenue(venueId, userId, role))) return false;
    const [result] = await this.database.execute(
      'UPDATE venue_inquiries SET status = ? WHERE id = ? AND venue_id = ?',
      [status, inquiryId, venueId],
    );
    return result.affectedRows > 0;
  }

  async moderateVenue(venueId, moderationStatus, verificationStatus = null, isActive = null) {
    // Never compare a bound parameter with a SQL string literal. The driver
    // tags parameters with its own collation, so such a comparison can leave
    // MySQL with two COERCIBLE operands and no precedence rule to pick between
    // them ("Illegal mix of collations"). Status strings are therefore compared
    // in JavaScript and bound as booleans. Column-versus-literal stays in SQL
    // because a column's collation takes precedence over a literal's, and it
    // reads the same value whichever order MySQL evaluates the assignments in:
    // an omitted status leaves the column unchanged.
    const [result] = await this.database.execute(
      `UPDATE venues SET moderation_status = ?, verification_status = COALESCE(?, verification_status), is_verified = CASE WHEN ? IS NULL THEN verification_status = 'verified' ELSE ? END, is_active = COALESCE(?, is_active), published_at = CASE WHEN ? AND published_at IS NULL THEN NOW() ELSE published_at END WHERE id = ?`,
      [
        moderationStatus,
        verificationStatus,
        verificationStatus,
        verificationStatus === 'verified',
        isActive,
        moderationStatus === 'approved',
        venueId,
      ],
    );
    return result.affectedRows > 0;
  }

  async submitVenueForModeration(venueId) {
    // Submission is deliberately a narrow state transition. Owners may ask
    // for review, but only an administrator can approve, reject, or remove a
    // listing. Keeping both status literals in SQL also avoids comparing a
    // bound string parameter with a literal under incompatible collations.
    const [result] = await this.database.execute(
      "UPDATE venues SET moderation_status = 'pending' WHERE id = ? AND moderation_status IN ('draft', 'rejected')",
      [venueId],
    );
    return result.affectedRows > 0;
  }

  async saveVenue(venueId, userId) {
    const [result] = await this.database.execute(
      'INSERT IGNORE INTO saved_venues (user_id, venue_id) SELECT ?, id FROM venues WHERE id = ? AND is_active = TRUE',
      [userId, venueId],
    );
    return result.affectedRows > 0;
  }

  async unsaveVenue(venueId, userId) {
    const [result] = await this.database.execute(
      'DELETE FROM saved_venues WHERE venue_id = ? AND user_id = ?',
      [venueId, userId],
    );
    return result.affectedRows > 0;
  }

  async savedVenues(userId) {
    const [rows] = await this.database.execute(
      `SELECT ${this.queries.venueColumns()}, owner.name AS ownerName, organization.name AS organizationName, organization.slug AS organizationSlug, type.slug AS venueType, type.name AS venueTypeName, FALSE AS sponsored FROM saved_venues saved JOIN venues v ON v.id = saved.venue_id JOIN users owner ON owner.id = v.owner_user_id LEFT JOIN organizations organization ON organization.id = v.organization_id LEFT JOIN venue_types type ON type.id = v.venue_type_id WHERE saved.user_id = ? AND v.is_active = TRUE ORDER BY saved.created_at DESC`,
      [userId],
    );
    return Promise.all(
      rows.map((venue) => this.queries.decorateVenue(venue, { publicView: true })),
    );
  }

  async similarVenues(venueId, userId = null, role = null) {
    const venue = await this.queries.venue(venueId, userId, role);
    if (!venue) return null;
    return this.queries
      .venuesForViewer(userId, role, { city: venue.city, venueType: venue.venueType })
      .then((venues) => venues.filter((item) => item.id !== venueId).slice(0, 6));
  }
}
