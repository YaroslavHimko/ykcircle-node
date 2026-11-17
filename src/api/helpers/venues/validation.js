import { validateBranding } from '../../../utils/branding.js';
import {
  isValidIanaTimezone,
  localDateTimeToUtc,
  mysqlUtc,
  zonedDateTime,
} from '../../../utils/time.js';

export function createVenuesValidation({ queries }) {
  const supportedTimezone = isValidIanaTimezone;
  const venueSlug = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const venueData = (body, existing = {}) => {
    const nullableNumber = (value, fallback = null) =>
      value === '' || value === null ? null : value === undefined ? fallback : Number(value);
    const list = (value, fallback = []) =>
      value === undefined
        ? fallback
        : Array.isArray(value)
          ? [...new Set(value.map(venueSlug).filter(Boolean))]
          : null;
    const data = {
      organizationId: nullableNumber(body.organizationId, existing.organizationId ?? null),
      billingProfileId: nullableNumber(body.billingProfileId, existing.billingProfileId ?? null),
      name: String(body.name ?? existing.name ?? '').trim(),
      slug: venueSlug(body.slug ?? existing.slug ?? body.name ?? existing.name),
      logoImage: body.logoImage === undefined ? existing.logoImage || null : body.logoImage || null,
      businessName: String(body.businessName ?? existing.businessName ?? '').trim() || null,
      shortDescription:
        String(body.shortDescription ?? existing.shortDescription ?? '').trim() || null,
      description: String(body.description ?? existing.description ?? '').trim() || null,
      country: String(body.country ?? existing.country ?? '').trim() || null,
      city: String(body.city ?? existing.city ?? '').trim() || null,
      municipality: String(body.municipality ?? existing.municipality ?? '').trim() || null,
      region: String(body.region ?? existing.region ?? '').trim() || null,
      addressLine1: String(body.addressLine1 ?? existing.addressLine1 ?? '').trim() || null,
      addressLine2: String(body.addressLine2 ?? existing.addressLine2 ?? '').trim() || null,
      postalCode: String(body.postalCode ?? existing.postalCode ?? '').trim() || null,
      countryCode:
        String(body.countryCode ?? existing.countryCode ?? '')
          .trim()
          .toUpperCase() || null,
      googlePlaceId: String(body.googlePlaceId ?? existing.googlePlaceId ?? '').trim() || null,
      formattedAddress:
        String(body.formattedAddress ?? existing.formattedAddress ?? '').trim() || null,
      latitude: nullableNumber(body.latitude, existing.latitude ?? null),
      longitude: nullableNumber(body.longitude, existing.longitude ?? null),
      locationVisibility: String(body.locationVisibility ?? existing.locationVisibility ?? 'exact'),
      timezone: String(body.timezone ?? existing.timezone ?? 'UTC'),
      venueType: venueSlug(body.venueType ?? existing.venueType),
      capacityMin: nullableNumber(body.capacityMin, existing.capacityMin ?? null),
      capacityMax: nullableNumber(body.capacityMax, existing.capacityMax ?? null),
      standingCapacity: nullableNumber(body.standingCapacity, existing.standingCapacity ?? null),
      seatedCapacity: nullableNumber(body.seatedCapacity, existing.seatedCapacity ?? null),
      diningCapacity: nullableNumber(body.diningCapacity, existing.diningCapacity ?? null),
      classroomCapacity: nullableNumber(body.classroomCapacity, existing.classroomCapacity ?? null),
      sizeSqm: nullableNumber(body.sizeSqm, existing.sizeSqm ?? null),
      priceFrom: nullableNumber(body.priceFrom, existing.priceFrom ?? null),
      priceUnit: String(body.priceUnit ?? existing.priceUnit ?? 'contact'),
      currency: String(body.currency ?? existing.currency ?? 'SEK')
        .trim()
        .toUpperCase(),
      pricingDescription:
        String(body.pricingDescription ?? existing.pricingDescription ?? '').trim() || null,
      minimumBookingHours: nullableNumber(
        body.minimumBookingHours,
        existing.minimumBookingHours ?? null,
      ),
      websiteUrl: String(body.websiteUrl ?? existing.websiteUrl ?? '').trim() || null,
      phone: String(body.phone ?? existing.phone ?? '').trim() || null,
      contactEmail:
        String(body.contactEmail ?? existing.contactEmail ?? '')
          .trim()
          .toLowerCase() || null,
      availabilityType: String(body.availabilityType ?? existing.availabilityType ?? 'calendar'),
      availability:
        body.availability === undefined ? (existing.availability ?? []) : body.availability,
      houseRulesText: String(body.houseRulesText ?? existing.houseRulesText ?? '').trim() || null,
      amenitySlugs: list(
        body.amenities,
        (existing.amenities || []).map((item) => item.slug),
      ),
      suitableEventTypeSlugs: list(
        body.suitableEventTypes,
        (existing.suitableEventTypes || []).map((item) => item.slug),
      ),
      isActive: body.isActive ?? (existing.isActive == null ? true : Boolean(existing.isActive)),
    };
    const errors = {};
    if (
      data.organizationId !== null &&
      (!Number.isInteger(data.organizationId) || data.organizationId < 1)
    )
      errors.organizationId = 'A valid organization is required.';
    if (
      data.billingProfileId !== null &&
      (!Number.isInteger(data.billingProfileId) || data.billingProfileId < 1)
    )
      errors.billingProfileId = 'A valid billing profile is required.';
    validateBranding(data, errors);
    if (data.name.length < 2 || data.name.length > 160)
      errors.name = 'Venue name must be between 2 and 160 characters.';
    if (!data.slug || data.slug.length > 180)
      errors.slug = 'Venue slug must contain letters or numbers and be at most 180 characters.';
    if (!data.formattedAddress || data.formattedAddress.length > 500)
      errors.formattedAddress = 'A formatted address of up to 500 characters is required.';
    if (data.businessName?.length > 160)
      errors.businessName = 'Business name must not exceed 160 characters.';
    if (data.shortDescription?.length > 400)
      errors.shortDescription = 'Short description must not exceed 400 characters.';
    if (
      data.latitude !== null &&
      (!Number.isFinite(Number(data.latitude)) ||
        Number(data.latitude) < -90 ||
        Number(data.latitude) > 90)
    )
      errors.latitude = 'Latitude must be between -90 and 90.';
    if (
      data.longitude !== null &&
      (!Number.isFinite(Number(data.longitude)) ||
        Number(data.longitude) < -180 ||
        Number(data.longitude) > 180)
    )
      errors.longitude = 'Longitude must be between -180 and 180.';
    if (data.countryCode && !/^[A-Z]{2}$/.test(data.countryCode))
      errors.countryCode = 'Country code must be a two-letter ISO code.';
    if (data.googlePlaceId?.length > 255)
      errors.googlePlaceId = 'Google Place ID must not exceed 255 characters.';
    if (data.formattedAddress?.length > 500)
      errors.formattedAddress = 'Formatted address must not exceed 500 characters.';
    if (!['exact', 'approximate', 'private'].includes(data.locationVisibility))
      errors.locationVisibility = 'Invalid location visibility.';
    if (!data.venueType) errors.venueType = 'A venue type is required.';
    for (const key of [
      'capacityMin',
      'capacityMax',
      'standingCapacity',
      'seatedCapacity',
      'diningCapacity',
      'classroomCapacity',
    ])
      if (data[key] !== null && (!Number.isInteger(data[key]) || data[key] < 1))
        errors[key] = 'Capacity must be a positive whole number.';
    if (
      data.capacityMin !== null &&
      data.capacityMax !== null &&
      data.capacityMin > data.capacityMax
    )
      errors.capacityMax = 'Maximum capacity must be at least the minimum capacity.';
    if (data.sizeSqm !== null && (!Number.isFinite(data.sizeSqm) || data.sizeSqm <= 0))
      errors.sizeSqm = 'Size must be positive.';
    if (data.priceFrom !== null && (!Number.isFinite(data.priceFrom) || data.priceFrom < 0))
      errors.priceFrom = 'Price must be zero or positive.';
    if (
      !['hour', 'half_day', 'day', 'evening', 'person', 'event', 'contact'].includes(data.priceUnit)
    )
      errors.priceUnit = 'Invalid price unit.';
    if (!/^[A-Z]{3}$/.test(data.currency))
      errors.currency = 'Currency must be a three-letter ISO code.';
    if (
      data.minimumBookingHours !== null &&
      (!Number.isFinite(data.minimumBookingHours) || data.minimumBookingHours <= 0)
    )
      errors.minimumBookingHours = 'Minimum booking hours must be positive.';
    if (data.websiteUrl && !/^https:\/\//i.test(data.websiteUrl))
      errors.websiteUrl = 'Website URL must use HTTPS.';
    if (data.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail))
      errors.contactEmail = 'A valid contact email is required.';
    if (!['contact', 'calendar', 'always_open'].includes(data.availabilityType))
      errors.availabilityType = 'Invalid availability type.';
    const schedule = venueAvailability(data.availability);
    if (schedule.error) errors.availability = schedule.error;
    else if (schedule.errors) Object.assign(errors, schedule.errors);
    else data.availability = schedule.slots;
    if (!existing.id && !data.availability?.length)
      errors.availability = 'Add at least one weekly availability period.';
    if (!Array.isArray(data.amenitySlugs))
      errors.amenities = 'amenities must be an array of amenity slugs.';
    if (!Array.isArray(data.suitableEventTypeSlugs))
      errors.suitableEventTypes = 'suitableEventTypes must be an array of event-type slugs.';
    if (!supportedTimezone(data.timezone))
      errors.timezone = 'Select a timezone returned by GET /api/timezones.';
    if (typeof data.isActive !== 'boolean') errors.isActive = 'isActive must be a boolean.';
    return { data, errors };
  };
  const venueAvailability = (slots) => {
    if (!Array.isArray(slots))
      return { error: 'availability must be an array of weekly time slots.' };
    if (slots.length > 56)
      return { error: 'availability can contain at most 56 weekly time slots.' };
    const errors = {};
    const normalized = slots.map((slot, index) => {
      const weekday = Number(slot?.weekday);
      const startTime = String(slot?.startTime || '');
      const endTime = String(slot?.endTime || '');
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
        errors[`availability.${index}.weekday`] =
          'weekday must be an integer from 0 (Sunday) to 6 (Saturday).';
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime))
        errors[`availability.${index}.startTime`] = 'startTime must use HH:mm.';
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime))
        errors[`availability.${index}.endTime`] = 'endTime must use HH:mm.';
      if (startTime && endTime && startTime >= endTime)
        errors[`availability.${index}.endTime`] =
          'endTime must be after startTime; overnight slots are not supported.';
      return { weekday, startTime, endTime };
    });
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      const days = normalized
        .filter((slot) => slot.weekday === weekday)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (let index = 1; index < days.length; index += 1)
        if (days[index].startTime < days[index - 1].endTime)
          errors.availability = 'Availability slots on the same day must not overlap.';
    }
    return Object.keys(errors).length ? { errors } : { slots: normalized };
  };
  const requestedAvailabilityDate = (value) => {
    const date = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)))
      return null;
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const requestedUtc = Date.parse(`${date}T12:00:00Z`);
    const daysAhead = Math.floor((requestedUtc - todayUtc) / (24 * 60 * 60 * 1000));
    return daysAhead >= 0 && daysAhead <= 366 ? date : null;
  };
  const availabilityRange = (from, to) => {
    const valid = (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
    if (!valid(from) || !valid(to) || from > to) return null;
    const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;
    return days <= 93 ? { from, to } : null;
  };
  const addDateDays = (date, days) => {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const utcDateTime = mysqlUtc;
  const venueInterval = async (venueId, body) => {
    const directStart = utcDateTime(body.startAt);
    const directEnd = utcDateTime(body.endAt);
    if (directStart && directEnd) return { startAt: directStart, endAt: directEnd };
    const date = String(body.date || '');
    const venue = await queries.venueTimezone(venueId);
    if (!venue || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const startTime = body.allDay ? '00:00' : String(body.startTime || '');
    const endDate = body.allDay ? addDateDays(date, 1) : date;
    const endTime = body.allDay ? '00:00' : String(body.endTime || '');
    const start = localDateTimeToUtc(date, startTime, venue.timezone, 'start');
    const end = localDateTimeToUtc(endDate, endTime, venue.timezone, 'end');
    return start && end
      ? { startAt: mysqlUtc(start), endAt: mysqlUtc(end), timezone: venue.timezone }
      : null;
  };
  const bookingSettingsData = (body, existing = {}) => {
    const number = (key, fallback, nullable = false) =>
      body[key] === undefined
        ? fallback
        : body[key] === null || body[key] === ''
          ? nullable
            ? null
            : NaN
          : Number(body[key]);
    const data = {
      bookingMode: String(body.bookingMode ?? existing.bookingMode ?? 'hourly'),
      slotIncrementMinutes: number('slotIncrementMinutes', existing.slotIncrementMinutes ?? 30),
      minimumBookingMinutes: number('minimumBookingMinutes', existing.minimumBookingMinutes ?? 30),
      maximumBookingMinutes: number(
        'maximumBookingMinutes',
        existing.maximumBookingMinutes ?? null,
        true,
      ),
      bufferBeforeMinutes: number('bufferBeforeMinutes', existing.bufferBeforeMinutes ?? 0),
      bufferAfterMinutes: number('bufferAfterMinutes', existing.bufferAfterMinutes ?? 0),
      minimumNoticeHours: number('minimumNoticeHours', existing.minimumNoticeHours ?? 0),
      maximumAdvanceDays: number('maximumAdvanceDays', existing.maximumAdvanceDays ?? 365),
      currency: String(body.currency ?? existing.currency ?? 'SEK').toUpperCase(),
      hourlyRate: number('hourlyRate', existing.hourlyRate ?? null, true),
      dailyRate: number('dailyRate', existing.dailyRate ?? null, true),
      invoiceDueDays: number('invoiceDueDays', existing.invoiceDueDays ?? 30),
    };
    const errors = {};
    if (!['hourly', 'daily', 'both', 'inquiry_only'].includes(data.bookingMode))
      errors.bookingMode = 'Invalid booking mode.';
    for (const key of [
      'slotIncrementMinutes',
      'minimumBookingMinutes',
      'bufferBeforeMinutes',
      'bufferAfterMinutes',
      'minimumNoticeHours',
      'maximumAdvanceDays',
      'invoiceDueDays',
    ])
      if (!Number.isInteger(data[key]) || data[key] < 0)
        errors[key] = 'Must be a non-negative whole number.';
    if (data.slotIncrementMinutes < 1 || 1440 % data.slotIncrementMinutes)
      errors.slotIncrementMinutes = 'Slot increment must divide a day.';
    if (data.minimumBookingMinutes < 1)
      errors.minimumBookingMinutes = 'Minimum booking duration must be positive.';
    if (
      data.maximumBookingMinutes !== null &&
      (!Number.isInteger(data.maximumBookingMinutes) ||
        data.maximumBookingMinutes < data.minimumBookingMinutes)
    )
      errors.maximumBookingMinutes = 'Maximum booking duration must be at least the minimum.';
    for (const key of ['hourlyRate', 'dailyRate'])
      if (data[key] !== null && (!Number.isFinite(data[key]) || data[key] < 0))
        errors[key] = 'Rate must be zero or positive.';
    if (!/^[A-Z]{3}$/.test(data.currency))
      errors.currency = 'Currency must be a three-letter ISO code.';
    return { data, errors };
  };
  const venueFinancialSettingsData = (body, existing = {}) => {
    const nullableText = (key, max = 255) =>
      body[key] == null || body[key] === '' ? null : String(body[key]).trim().slice(0, max) || null;
    const sellerBillingProfileId =
      body.sellerBillingProfileId == null || body.sellerBillingProfileId === ''
        ? null
        : Number(body.sellerBillingProfileId);
    const methods = Array.isArray(body.methods)
      ? [...new Set(body.methods.map(String))]
      : existing.methods || [];
    const data = {
      invoiceMode: String(body.invoiceMode ?? existing.invoiceMode ?? 'ykcircle'),
      sellerBillingProfileId,
      paymentTermsDays: Number(body.paymentTermsDays ?? existing.paymentTermsDays ?? 30),
      taxMode: String(body.taxMode ?? existing.taxMode ?? 'no_tax'),
      defaultTaxRate:
        body.defaultTaxRate == null || body.defaultTaxRate === ''
          ? null
          : Number(body.defaultTaxRate),
      pricesIncludeTax: body.pricesIncludeTax === true,
      confirmationPolicy: String(
        body.confirmationPolicy ?? existing.confirmationPolicy ?? 'on_owner_approval',
      ),
      methods,
      bankgiro: nullableText('bankgiro', 80),
      plusgiro: nullableText('plusgiro', 80),
      iban: nullableText('iban', 80),
      bic: nullableText('bic', 32),
      swishNumber: nullableText('swishNumber', 80),
      bankName: nullableText('bankName', 160),
      accountDetailsText: nullableText('accountDetailsText', 5000),
      additionalInstructions: nullableText('additionalInstructions', 5000),
      paymentReferenceMode: String(
        body.paymentReferenceMode ?? existing.paymentReferenceMode ?? 'invoice_number',
      ),
      acceptInvoiceAuthorization: body.acceptInvoiceAuthorization === true,
      termsVersion: nullableText('termsVersion', 64),
    };
    const errors = {};
    if (!['ykcircle', 'external'].includes(data.invoiceMode))
      errors.invoiceMode = 'Invoice mode must be ykcircle or external.';
    if (
      data.sellerBillingProfileId !== null &&
      (!Number.isInteger(data.sellerBillingProfileId) || data.sellerBillingProfileId < 1)
    )
      errors.sellerBillingProfileId = 'Choose a valid seller billing profile.';
    if (
      !Number.isInteger(data.paymentTermsDays) ||
      data.paymentTermsDays < 0 ||
      data.paymentTermsDays > 365
    )
      errors.paymentTermsDays = 'Payment terms must be 0-365 days.';
    if (!['no_tax', 'configured'].includes(data.taxMode))
      errors.taxMode = 'Choose no tax or a configured tax rate.';
    if (
      data.taxMode === 'configured' &&
      (!Number.isFinite(data.defaultTaxRate) ||
        data.defaultTaxRate < 0 ||
        data.defaultTaxRate > 100)
    )
      errors.defaultTaxRate = 'Tax rate must be between 0 and 100.';
    if (!['on_owner_approval', 'after_payment'].includes(data.confirmationPolicy))
      errors.confirmationPolicy = 'Invalid confirmation policy.';
    const allowedMethods = new Set([
      'bank_transfer',
      'bankgiro',
      'plusgiro',
      'swish',
      'cash',
      'other',
    ]);
    if (methods.length > 6 || methods.some((method) => !allowedMethods.has(method)))
      errors.methods = 'Choose supported payment methods only.';
    if (!['invoice_number', 'custom'].includes(data.paymentReferenceMode))
      errors.paymentReferenceMode = 'Invalid payment reference mode.';
    if (data.invoiceMode === 'ykcircle' && data.acceptInvoiceAuthorization && !data.termsVersion)
      errors.termsVersion = 'The invoicing terms version is required when accepting authorization.';
    return { data, errors };
  };
  const availabilityOverrides = (value) => {
    if (!Array.isArray(value) || value.length > 366)
      return { error: 'overrides must contain at most 366 dates.' };
    const seen = new Set();
    const overrides = [];
    for (const item of value) {
      const date = String(item?.date || '');
      const overrideType = String(item?.overrideType || '');
      const windows = Array.isArray(item?.windows)
        ? item.windows.map((window) => ({
            startTime: String(window?.startTime || ''),
            endTime: String(window?.endTime || ''),
          }))
        : [];
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ||
        seen.has(date) ||
        !['closed', 'custom'].includes(overrideType) ||
        (overrideType === 'closed' && windows.length) ||
        (overrideType === 'custom' && !windows.length)
      )
        return {
          error: 'Each override must be a unique closed date or a custom date with valid windows.',
        };
      const checked = venueAvailability(windows.map((window) => ({ weekday: 0, ...window })));
      if (checked.error || checked.errors)
        return { error: 'Override windows must be non-overlapping HH:mm intervals.' };
      seen.add(date);
      overrides.push({ date, overrideType, windows });
    }
    return { overrides };
  };
  const asStoredUtcDate = (value) =>
    value instanceof Date
      ? value
      : new Date(`${String(value).replace(' ', 'T').replace(/Z$/i, '')}Z`);
  const eventFitsVenueAvailability = async (event, venue) => {
    if (!event.startsAt || !event.endsAt)
      return { error: 'The event must have both a start and end time before it can be booked.' };
    const start = asStoredUtcDate(event.startsAt);
    const end = asStoredUtcDate(event.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start)
      return { error: 'The event has an invalid booking time.' };
    const starts = zonedDateTime(start, venue.timezone);
    const ends = zonedDateTime(end, venue.timezone);
    if (!starts || !ends) return { error: 'The venue timezone is invalid.' };
    const startTime = starts.time;
    const endTime = ends.time;
    if (starts.seconds !== '00' || ends.seconds !== '00')
      return { error: 'Venue bookings must start and end on a whole minute.' };
    const date = starts.date;
    const availability = await queries.calculateVenueAvailability(venue.id, date, date);
    if (!availability) return { error: 'This venue is not available for booking.' };
    if (availability.bookingMode === 'daily') {
      const fullDay =
        (ends.date === addDateDays(date, 1) && endTime === '00:00') ||
        (ends.date === date && endTime === '23:59');
      if (startTime !== '00:00' || !fullDay)
        return { error: 'This venue can only be booked for a full local day.' };
      return availability.dates[0]?.availableIntervals.length
        ? {}
        : { error: 'The venue is not available on this date.', unavailable: true };
    }
    if (starts.date !== ends.date)
      return { error: 'The event must start and end on the same local day at this venue.' };
    if (!availability || !['hourly', 'both'].includes(availability.bookingMode))
      return { error: 'This venue does not accept hourly bookings.' };
    const durationMinutes = (end.getTime() - start.getTime()) / 60000;
    if (durationMinutes < availability.minimumBookingMinutes)
      return {
        error: `This venue requires bookings of at least ${availability.minimumBookingMinutes} minutes.`,
      };
    if (
      availability.maximumBookingMinutes !== null &&
      durationMinutes > availability.maximumBookingMinutes
    )
      return {
        error: `This venue allows bookings of at most ${availability.maximumBookingMinutes} minutes.`,
      };
    const localStartMinutes = Number(starts.hour) * 60 + Number(starts.minute);
    if (
      durationMinutes % availability.slotIncrementMinutes ||
      localStartMinutes % availability.slotIncrementMinutes
    )
      return { error: `Bookings must use ${availability.slotIncrementMinutes}-minute time slots.` };
    const available = availability.dates[0]?.availableIntervals.some(
      (slot) => slot.start <= startTime && slot.end >= endTime,
    );
    return available
      ? {}
      : { error: 'The venue is not available for the full event time.', unavailable: true };
  };
  return {
    venueSlug,
    venueData,
    venueAvailability,
    requestedAvailabilityDate,
    availabilityRange,
    addDateDays,
    utcDateTime,
    venueInterval,
    bookingSettingsData,
    venueFinancialSettingsData,
    availabilityOverrides,
    asStoredUtcDate,
    eventFitsVenueAvailability,
  };
}
