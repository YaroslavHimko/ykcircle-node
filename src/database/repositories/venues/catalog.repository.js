export class VenuesCatalogRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  venueColumns(prefix = 'v') {
    return `${prefix}.id, ${prefix}.organization_id AS organizationId, ${prefix}.billing_profile_id AS billingProfileId, ${prefix}.owner_user_id AS ownerUserId, ${prefix}.name, ${prefix}.slug, ${prefix}.business_name AS businessName, ${prefix}.logo_image AS logoImage, ${prefix}.short_description AS shortDescription, ${prefix}.description, ${prefix}.address_line_1 AS addressLine1, ${prefix}.address_line_2 AS addressLine2, ${prefix}.postal_code AS postalCode, ${prefix}.country, ${prefix}.country_code AS countryCode, ${prefix}.city, ${prefix}.municipality, ${prefix}.region, ${prefix}.latitude, ${prefix}.longitude, ${prefix}.google_place_id AS googlePlaceId, ${prefix}.formatted_address AS formattedAddress, ${prefix}.location_visibility AS locationVisibility, ${prefix}.timezone, ${prefix}.venue_type_id AS venueTypeId, ${prefix}.capacity_min AS capacityMin, ${prefix}.capacity_max AS capacityMax, ${prefix}.standing_capacity AS standingCapacity, ${prefix}.seated_capacity AS seatedCapacity, ${prefix}.dining_capacity AS diningCapacity, ${prefix}.classroom_capacity AS classroomCapacity, ${prefix}.size_sqm AS sizeSqm, ${prefix}.price_from AS priceFrom, ${prefix}.price_unit AS priceUnit, ${prefix}.currency, ${prefix}.pricing_description AS pricingDescription, ${prefix}.minimum_booking_hours AS minimumBookingHours, ${prefix}.website_url AS websiteUrl, ${prefix}.phone, ${prefix}.contact_email AS contactEmail, ${prefix}.availability_type AS availabilityType, ${prefix}.house_rules_text AS houseRulesText, ${prefix}.is_active AS isActive, ${prefix}.is_verified AS isVerified, ${prefix}.is_featured AS isFeatured, ${prefix}.verification_status AS verificationStatus, ${prefix}.moderation_status AS moderationStatus, ${prefix}.published_at AS publishedAt, ${prefix}.created_at AS createdAt, ${prefix}.updated_at AS updatedAt, (SELECT vm.filename FROM venue_media vm WHERE vm.venue_id = ${prefix}.id AND vm.is_cover = TRUE ORDER BY vm.sort_order, vm.id LIMIT 1) AS coverImage`;
  }

  normalizeVenue(venue, { publicView = false } = {}) {
    if (!venue) return null;
    const normalized = {
      ...venue,
      isActive: Boolean(venue.isActive),
      isVerified: Boolean(venue.isVerified),
      isFeatured: Boolean(venue.isFeatured),
      sponsored: Boolean(venue.sponsored),
    };
    for (const key of ['latitude', 'longitude', 'sizeSqm', 'priceFrom', 'minimumBookingHours'])
      if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    for (const key of [
      'capacityMin',
      'capacityMax',
      'standingCapacity',
      'seatedCapacity',
      'diningCapacity',
      'classroomCapacity',
    ])
      if (normalized[key] != null) normalized[key] = Number(normalized[key]);
    normalized.location = {
      visibility: normalized.locationVisibility,
      addressLine1: normalized.addressLine1 || null,
      addressLine2: normalized.addressLine2 || null,
      postalCode: normalized.postalCode || null,
      locality: normalized.city || null,
      municipality: normalized.municipality || null,
      region: normalized.region || null,
      country: normalized.country || null,
      countryCode: normalized.countryCode || null,
      latitude: normalized.latitude ?? null,
      longitude: normalized.longitude ?? null,
      googlePlaceId: normalized.googlePlaceId || null,
      formattedAddress: normalized.formattedAddress || null,
    };
    normalized.capacity = {
      min: normalized.capacityMin ?? null,
      max: normalized.capacityMax ?? null,
      standing: normalized.standingCapacity ?? null,
      seated: normalized.seatedCapacity ?? null,
      dining: normalized.diningCapacity ?? null,
      classroom: normalized.classroomCapacity ?? null,
    };
    normalized.pricing = {
      from: normalized.priceFrom ?? null,
      unit: normalized.priceUnit,
      currency: normalized.currency,
      description: normalized.pricingDescription || null,
    };
    if (publicView && normalized.locationVisibility !== 'exact') {
      normalized.addressLine1 = null;
      normalized.addressLine2 = null;
      normalized.postalCode = null;
      normalized.formattedAddress = null;
      normalized.googlePlaceId = null;
      normalized.location.addressLine1 = null;
      normalized.location.addressLine2 = null;
      normalized.location.postalCode = null;
      normalized.location.formattedAddress = null;
      normalized.location.googlePlaceId = null;
      if (normalized.locationVisibility === 'private') {
        normalized.latitude = null;
        normalized.longitude = null;
        normalized.location.latitude = null;
        normalized.location.longitude = null;
      }
    }
    if (publicView) delete normalized.billingProfileId;
    return normalized;
  }

  async venueRelations(venueId) {
    const [amenities] = await this.database.execute(
      'SELECT a.id, a.slug, a.name, a.category FROM venue_amenity_assignments va JOIN venue_amenities a ON a.id = va.amenity_id WHERE va.venue_id = ? AND a.is_active = TRUE ORDER BY a.category, a.sort_order, a.name',
      [venueId],
    );
    const [eventTypes] = await this.database.execute(
      'SELECT t.id, t.slug, t.name FROM venue_event_type_assignments va JOIN venue_event_types t ON t.id = va.event_type_id WHERE va.venue_id = ? AND t.is_active = TRUE ORDER BY t.sort_order, t.name',
      [venueId],
    );
    return { amenities, suitableEventTypes: eventTypes };
  }

  async decorateVenue(venue, options) {
    return {
      ...this.queries.normalizeVenue(venue, options),
      ...(await this.queries.venueRelations(venue.id)),
    };
  }

  async venueTypes() {
    const [rows] = await this.database.execute(
      'SELECT id, slug, name FROM venue_types WHERE is_active = TRUE ORDER BY sort_order, name',
    );
    return rows;
  }

  async venueEventTypes() {
    const [rows] = await this.database.execute(
      'SELECT id, slug, name FROM venue_event_types WHERE is_active = TRUE ORDER BY sort_order, name',
    );
    return rows;
  }

  async venueAmenities() {
    const [rows] = await this.database.execute(
      'SELECT id, slug, name, category FROM venue_amenities WHERE is_active = TRUE ORDER BY category, sort_order, name',
    );
    return rows;
  }
}
