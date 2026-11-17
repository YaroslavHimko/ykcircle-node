import { accessError } from '../../../domain/subscriptions/product-access.js';
import { validateBranding } from '../../../utils/branding.js';
import { mysqlUtc, parseUtcInstant } from '../../../utils/time.js';

export function createEventsValidation({
  queries,
  emailService,
  ensureTable,
  subscriptions,
  decorateEventImage,
}) {
  const parseEventRecurrence = (body) => {
    if (body.recurrence == null || body.recurrence === false)
      return { recurrence: { frequency: 'none', interval: 1, count: 1 } };
    if (typeof body.recurrence !== 'object' || Array.isArray(body.recurrence))
      return { error: 'recurrence must be an object.' };
    const frequency = String(body.recurrence.frequency || 'none').toLowerCase();
    if (frequency === 'none') return { recurrence: { frequency: 'none', interval: 1, count: 1 } };
    const interval = Number(body.recurrence.interval ?? 1);
    const count = Number(body.recurrence.count);
    if (!['daily', 'weekly', 'monthly'].includes(frequency))
      return { error: 'recurrence.frequency must be daily, weekly, monthly, or none.' };
    if (!Number.isInteger(interval) || interval < 1 || interval > 52)
      return { error: 'recurrence.interval must be an integer between 1 and 52.' };
    if (!Number.isInteger(count) || count < 2 || count > 100)
      return { error: 'recurrence.count must be an integer between 2 and 100.' };
    return { recurrence: { frequency, interval, count } };
  };
  const validateRichEvent = async (body, { publishing = false } = {}) => {
    const title = String(body.title || '').trim();
    const startsAt = body.startsAtUtc || body.startsAt;
    const endsAt = body.endsAtUtc || body.endsAt || null;
    const errors = {};
    validateBranding(body, errors);
    if (
      body.foodOptions != null &&
      (!Array.isArray(body.foodOptions) ||
        body.foodOptions.length > 12 ||
        body.foodOptions.some(
          (option) => typeof option !== 'string' || !option.trim() || option.trim().length > 100,
        ))
    ) {
      errors.foodOptions = 'Add up to 12 food options, each between 1 and 100 characters.';
    }
    const recurrenceResult = parseEventRecurrence(body);
    if (recurrenceResult.error) errors.recurrence = recurrenceResult.error;
    if (publishing || title) {
      if (title.length < 5 || title.length > 100)
        errors.title = 'Title must be between 5 and 100 characters.';
    }
    if (publishing || body.categoryId) {
      if (!Number.isInteger(Number(body.categoryId)))
        errors.categoryId = 'A valid category is required.';
    }
    if (publishing || body.typeId) {
      if (!Number.isInteger(Number(body.typeId))) errors.typeId = 'A valid event type is required.';
    }
    const startInstant = parseUtcInstant(startsAt);
    const endInstant = endsAt ? parseUtcInstant(endsAt) : null;
    if (publishing || startsAt) {
      if (!startInstant) errors.startsAt = 'A start timestamp with UTC Z or an offset is required.';
    }
    if (recurrenceResult.recurrence?.frequency !== 'none' && !startInstant)
      errors.recurrence = 'Recurring events require a UTC start timestamp.';
    if (endsAt && !endInstant) errors.endsAt = 'End must be a timestamp with UTC Z or an offset.';
    if (startInstant && endInstant && endInstant <= startInstant)
      errors.endsAt = 'End must be after start.';
    const pricingType = body.pricingType || (Number(body.fee || 0) > 0 ? 'paid' : 'free');
    if (!['free', 'paid'].includes(pricingType))
      errors.pricingType = 'Pricing type must be free or paid.';
    if (pricingType === 'paid' && Number(body.fee || 0) <= 0)
      errors.fee = 'Paid events require a positive price.';
    if (pricingType === 'free' && Number(body.fee || 0) !== 0)
      errors.fee = 'Free events cannot have a price.';
    if (!['Public', 'Private', 'Members', 'Unlisted'].includes(body.visibility || 'Public'))
      errors.visibility = 'Invalid visibility.';
    const locationType = body.locationType || 'custom';
    // Draft reads expose the canonical structured location object. Publishing
    // validates that stored representation, whereas create/update requests
    // provide the equivalent explicit custom* fields.
    const locationField = (name) =>
      body[`custom${name[0].toUpperCase()}${name.slice(1)}`] ?? body.location?.[name];
    const customLatitude = locationField('latitude');
    const customLongitude = locationField('longitude');
    const customFormattedAddress = locationField('formattedAddress');
    if (!['venue', 'custom', 'online'].includes(locationType))
      errors.locationType = 'Location type must be venue, custom, or online.';
    let selectedVenue = null;
    if (locationType === 'venue') {
      if (startsAt || endsAt) {
        if (!startInstant) errors.startsAt = 'Choose and apply a venue booking start time.';
        if (!endInstant) errors.endsAt = 'Choose and apply a venue booking end time.';
      }
      const venueId = Number(body.venueId ?? body.venue?.id);
      if (!Number.isInteger(venueId) || venueId < 1) errors.venueId = 'A valid venue is required.';
      else {
        selectedVenue = await queries.eventLocationVenue(venueId);
        if (!selectedVenue) errors.venueId = 'The selected venue is unavailable.';
      }
    }
    if (locationType === 'custom') {
      if (!customFormattedAddress || String(customFormattedAddress).trim().length > 500)
        errors.formattedAddress = 'A formatted address of up to 500 characters is required.';
      if (
        !Number.isFinite(Number(customLatitude)) ||
        Number(customLatitude) < -90 ||
        Number(customLatitude) > 90
      )
        errors.latitude = 'Latitude must be between -90 and 90.';
      if (
        !Number.isFinite(Number(customLongitude)) ||
        Number(customLongitude) < -180 ||
        Number(customLongitude) > 180
      )
        errors.longitude = 'Longitude must be between -180 and 180.';
      if (publishing && !locationField('country'))
        errors.country = 'A country is required before publication.';
    }
    if (locationType === 'online') {
      const onlineUrl = body.onlineUrl == null ? '' : String(body.onlineUrl).trim();
      if (onlineUrl && (!/^https:\/\//i.test(onlineUrl) || onlineUrl.length > 1024))
        errors.onlineUrl = 'Online URL must be an HTTPS URL of up to 1,024 characters.';
    }
    for (const [field, max] of Object.entries({
      addressLine1: 255,
      addressLine2: 255,
      postalCode: 32,
      locality: 120,
      municipality: 120,
      region: 120,
      country: 120,
      countryCode: 2,
      googlePlaceId: 255,
    })) {
      const value = locationField(field);
      if (value != null && String(value).trim().length > max)
        errors[field] = `Must not exceed ${max} characters.`;
    }
    const countryCode = locationField('countryCode');
    if (countryCode && !/^[A-Za-z]{2}$/.test(String(countryCode).trim()))
      errors.countryCode = 'Country code must be a two-letter ISO code.';
    if (publishing && !body.description?.trim())
      errors.description = 'Description is required before publication.';
    // A venue owns booking/event wall time. A client-provided timezone is
    // ignored for venue events so a travelling organizer cannot shift it.
    const timezone = selectedVenue?.timezone || body.timezone || 'UTC';
    if (
      typeof Intl.supportedValuesOf !== 'function' ||
      (timezone !== 'UTC' && !Intl.supportedValuesOf('timeZone').includes(timezone))
    )
      errors.timezone = 'Select a timezone returned by GET /api/timezones.';
    return {
      errors,
      title,
      startsAt,
      endsAt,
      pricingType,
      timezone,
      locationType,
      recurrence: recurrenceResult.recurrence || { frequency: 'none', interval: 1, count: 1 },
    };
  };
  const richEventData = (body, userId, validation) => {
    const locationField = (name) => body[`custom${name[0].toUpperCase()}${name.slice(1)}`];
    const text = (value, max) =>
      value == null ? null : String(value).trim().slice(0, max) || null;
    // A cover image is managed by the event media endpoint. Store only its
    // filename, never an environment-specific URL supplied by a client.
    const coverImage = (value) => {
      const source = text(value, 1024);
      if (!source) return null;
      const filename = source.split(/[?#]/, 1)[0].split('/').pop();
      try {
        return filename ? decodeURIComponent(filename) : null;
      } catch {
        return filename || null;
      }
    };
    const isCustom = validation.locationType === 'custom';
    const custom = isCustom
      ? {
          addressLine1: text(locationField('addressLine1'), 255),
          addressLine2: text(locationField('addressLine2'), 255),
          postalCode: text(locationField('postalCode'), 32),
          locality: text(locationField('locality'), 120),
          municipality: text(locationField('municipality'), 120),
          region: text(locationField('region'), 120),
          country: text(locationField('country'), 120),
          countryCode: text(locationField('countryCode'), 2)?.toUpperCase() || null,
          latitude: Number(locationField('latitude')),
          longitude: Number(locationField('longitude')),
          googlePlaceId: text(locationField('googlePlaceId'), 255),
          formattedAddress: text(locationField('formattedAddress'), 500),
        }
      : {};
    return {
      managerId: userId,
      title: validation.title,
      brandName: body.brandName === undefined ? undefined : String(body.brandName || '').trim(),
      logoImage: body.logoImage === undefined ? undefined : body.logoImage || '',
      shortDescription: body.shortDescription?.trim() || null,
      description: body.description?.trim() || null,
      foodOptions:
        body.foodOptions === undefined
          ? undefined
          : (body.foodOptions || []).map((option) => option.trim()),
      coverImage: coverImage(body.coverImage),
      categoryId: body.categoryId ? Number(body.categoryId) : null,
      typeId: body.typeId ? Number(body.typeId) : null,
      locationType: validation.locationType,
      locationVisibility: body.locationVisibility || 'public',
      startsAt: mysqlUtc(validation.startsAt),
      endsAt: validation.endsAt ? mysqlUtc(validation.endsAt) : null,
      timezone: validation.timezone,
      cancellationPolicy: body.cancellationPolicy || null,
      pricingType: validation.pricingType,
      fee: validation.pricingType === 'free' ? 0 : Number(body.fee || 0),
      currency: body.currency || 'SEK',
      registrationType: body.registrationType || 'yaroko',
      externalRegistrationUrl: body.externalRegistrationUrl || null,
      visibility: body.visibility || 'Public',
      groupId: body.groupId ? Number(body.groupId) : null,
      recurrence: validation.recurrence,
      venueId: validation.locationType === 'venue' ? Number(body.venueId ?? body.venue?.id) : null,
      customAddressLine1: custom.addressLine1 || null,
      customAddressLine2: custom.addressLine2 || null,
      customPostalCode: custom.postalCode || null,
      customLocality: custom.locality || null,
      customMunicipality: custom.municipality || null,
      customRegion: custom.region || null,
      customCountry: custom.country || null,
      customCountryCode: custom.countryCode || null,
      customLatitude: custom.latitude ?? null,
      customLongitude: custom.longitude ?? null,
      customGooglePlaceId: custom.googlePlaceId || null,
      customFormattedAddress: custom.formattedAddress || null,
      onlineUrl: validation.locationType === 'online' ? text(body.onlineUrl, 1024) : null,
      onlinePlatform: validation.locationType === 'online' ? text(body.onlinePlatform, 120) : null,
    };
  };
  const notifyGroupEventMembers = async (eventId) => {
    const members = await queries.pendingGroupEventNotifications(eventId);
    await Promise.all(
      members.map(async (member) => {
        if (!(await queries.claimGroupEventNotification(eventId, member.userId))) return;
        try {
          await emailService.sendGroupEventNotification(
            member.email,
            member.name,
            { id: member.groupId, name: member.groupName },
            member,
          );
        } catch (emailError) {
          try {
            await queries.releaseGroupEventNotification(eventId, member.userId);
          } catch (releaseError) {
            console.error(
              `Unable to release group event notification for ${member.email}:`,
              releaseError.message,
            );
          }
          console.error(`Group event notification failed for ${member.email}:`, emailError.message);
        }
      }),
    );
  };
  const bookingFailure = (res, error) => {
    const failures = {
      VENUE_UNAVAILABLE: [409, 'The venue is already booked for this time. Choose another time.'],
      EVENT_ALREADY_BOOKED: [
        409,
        'Cancel the active booking before changing the venue or booking time.',
      ],
      BILLING_PROFILE_UNAVAILABLE: [
        422,
        'This billing profile is no longer available to your account.',
      ],
      INVALID_EVENT_TIME: [422, 'Choose a valid venue booking start and end time.'],
      VENUE_NOT_FOUND: [404, 'The selected venue is unavailable.'],
      EVENT_NOT_FOUND: [404, 'Event not found or not managed by you.'],
    };
    const failure = failures[error.code];
    return failure ? res.status(failure[0]).json({ code: error.code, error: failure[1] }) : null;
  };
  const createRichDraft = async (req, res, groupId = req.body.groupId) => {
    try {
      await ensureTable();
      if (
        groupId &&
        (!Number.isInteger(Number(groupId)) ||
          !(await queries.canManageGroup(Number(groupId), req.user.id, req.user.role)))
      )
        return res.status(403).json({ error: 'You can only post events in groups you manage.' });
      const validation = await validateRichEvent(req.body);
      if (Object.keys(validation.errors).length)
        return res
          .status(422)
          .json({ error: 'Event draft is invalid.', fields: validation.errors });
      const draft = richEventData({ ...req.body, groupId }, req.user.id, validation);
      const organizationId = req.body.organizerOrganizationId;
      if (organizationId != null && organizationId !== '') {
        if (!Number.isSafeInteger(Number(organizationId)) || Number(organizationId) < 1)
          throw accessError('INVALID_OWNER', 'Choose a valid organizer.', 422);
        await subscriptions.access.authorizeOwner(
          { type: 'organization', id: Number(organizationId) },
          req.user.id,
        );
        draft.organizerOrganizationId = Number(organizationId);
      }
      const series = await queries.createRichEventSeries(draft, {
        bookVenue: true,
        role: req.user.role,
        buyerBillingProfileId: req.body.buyerBillingProfileId,
      });
      const event = await queries.richEvent(series.eventIds[0], req.user.id, req.user.role);
      const booking =
        draft.venueId && draft.startsAt && draft.endsAt
          ? await queries.eventVenueBooking(series.eventIds[0], req.user.id, req.user.role)
          : null;
      return res.status(201).json({
        ...decorateEventImage(event, { userId: req.user.id, role: req.user.role }),
        venueBooking: booking,
        seriesId: series.seriesId,
        occurrenceIds: series.eventIds,
      });
    } catch (error) {
      if (error.status && error.code)
        return res.status(error.status).json({
          code: error.code,
          error: error.message,
          owner: error.owner,
          subscribeUrl: error.subscribeUrl,
        });
      if (bookingFailure(res, error)) return;
      console.error('Rich event creation failed:', error);
      return res.status(500).json({ error: 'Unable to create event draft.' });
    }
  };
  return {
    validateRichEvent,
    richEventData,
    notifyGroupEventMembers,
    bookingFailure,
    createRichDraft,
  };
}
