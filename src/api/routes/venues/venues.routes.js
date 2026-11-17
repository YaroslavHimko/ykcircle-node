export function registerVenuesRoutes(
  app,
  {
    optionalAuthenticate,
    venueSlug,
    ensureTable,
    sendVenueList,
    queries,
    authenticate,
    requireVenueOwner,
    requireRoleManager,
    requireAdmin,
    sendVenue,
    requireVerifiedUser,
    creationGuards,
    venueData,
    parseVenueImage,
    venueFtpService,
    venueImageUrl,
    venueImageToken,
    availabilityRange,
    requestedAvailabilityDate,
    addDateDays,
    bookingSettingsData,
    venueFinancialSettingsData,
    availabilityOverrides,
    venueInterval,
    venueAvailability,
    updateGuards,
    reportReference,
  },
) {
  app.get('/api/venues', optionalAuthenticate, async (req, res) => {
    const number = (value, name) =>
      value == null || value === ''
        ? null
        : Number.isFinite(Number(value)) && Number(value) >= 0
          ? Number(value)
          : name;
    const minCapacity = number(req.query.minCapacity, 'minCapacity');
    const maxCapacity = number(req.query.maxCapacity, 'maxCapacity');
    const maxPrice = number(req.query.maxPrice, 'maxPrice');
    if (
      [minCapacity, maxCapacity, maxPrice].some((value) => typeof value === 'string') ||
      (minCapacity !== null && !Number.isInteger(minCapacity)) ||
      (maxCapacity !== null && !Number.isInteger(maxCapacity))
    )
      return res.status(422).json({
        error:
          'Capacity filters must be whole non-negative numbers and maxPrice must be non-negative.',
      });
    const amenities =
      req.query.amenity == null
        ? []
        : String(req.query.amenity).split(',').map(venueSlug).filter(Boolean);
    try {
      await ensureTable();
      return sendVenueList(
        res,
        await queries.venuesForViewer(req.user?.id ?? null, req.user?.role ?? null, {
          city: req.query.city ? String(req.query.city).trim() : null,
          venueType: req.query.venueType ? venueSlug(req.query.venueType) : null,
          eventType: req.query.eventType ? venueSlug(req.query.eventType) : null,
          amenities,
          minCapacity,
          maxCapacity,
          maxPrice,
          verifiedOnly: req.query.verified === 'true',
        }),
      );
    } catch (error) {
      console.error('Venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venues.' });
    }
  });
  app.get('/api/venues/mine', authenticate, requireVenueOwner, async (req, res) => {
    try {
      await ensureTable();
      return sendVenueList(
        res,
        await queries.venuesForViewer(req.user.id, req.user.role, { managedOnly: true }),
      );
    } catch (error) {
      console.error('Managed venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load your venues.' });
    }
  });
  app.get('/api/my/venues', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return sendVenueList(
        res,
        await queries.venuesForViewer(req.user.id, req.user.role, { ownedOnly: true }),
      );
    } catch (error) {
      console.error('Owned venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load your venues.' });
    }
  });
  app.get('/api/manager/venues', authenticate, requireRoleManager, async (req, res) => {
    try {
      await ensureTable();
      return sendVenueList(
        res,
        await queries.venuesForViewer(req.user.id, req.user.role, { managedOnly: true }),
      );
    } catch (error) {
      console.error('Manager venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venues.' });
    }
  });
  app.get('/api/admin/venues', authenticate, requireAdmin, async (req, res) => {
    try {
      await ensureTable();
      return sendVenueList(
        res,
        await queries.venuesForViewer(req.user.id, req.user.role, { managedOnly: true }),
      );
    } catch (error) {
      console.error('Admin venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venues.' });
    }
  });
  app.patch('/api/admin/venues/:id/moderation', authenticate, requireAdmin, async (req, res) => {
    const venueId = Number(req.params.id);
    const moderationStatus = String(req.body.moderationStatus || '');
    const verificationStatus =
      req.body.verificationStatus == null ? null : String(req.body.verificationStatus);
    const isActive = req.body.isActive == null ? null : req.body.isActive;
    if (
      !Number.isInteger(venueId) ||
      venueId < 1 ||
      !['draft', 'pending', 'approved', 'rejected', 'removed'].includes(moderationStatus) ||
      (verificationStatus !== null &&
        !['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) ||
      (isActive !== null && typeof isActive !== 'boolean')
    )
      return res.status(422).json({ error: 'Venue moderation update is invalid.' });
    try {
      await ensureTable();
      if (!(await queries.moderateVenue(venueId, moderationStatus, verificationStatus, isActive)))
        return res.status(404).json({ error: 'Venue not found.' });
      return sendVenue(res, await queries.venue(venueId, req.user.id, req.user.role));
    } catch (error) {
      console.error('Venue moderation update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update venue moderation.' });
    }
  });
  app.post(
    '/api/venues/:id/submit-for-review',
    authenticate,
    requireVerifiedUser,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1)
        return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        if (!(await queries.canManageVenue(venueId, req.user.id, req.user.role)))
          return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        if (!(await queries.submitVenueForModeration(venueId)))
          return res
            .status(409)
            .json({ error: 'Only draft or rejected venues can be submitted for review.' });
        return sendVenue(res, await queries.venue(venueId, req.user.id, req.user.role));
      } catch (error) {
        console.error('Venue review submission failed:', error.message);
        return res.status(500).json({ error: 'Unable to submit venue for review.' });
      }
    },
  );
  app.post(
    '/api/venues',
    authenticate,
    requireVerifiedUser,
    requireVenueOwner,
    ...creationGuards,
    async (req, res) => {
      const { data, errors } = venueData(req.body);
      if (Object.keys(errors).length)
        return res.status(422).json({ error: 'Venue is invalid.', fields: errors });
      try {
        await ensureTable();
        if (
          data.organizationId &&
          !(await queries.canManageOrganization(data.organizationId, req.user.id, req.user.role))
        )
          return res.status(403).json({ error: 'Organization not found or not managed by you.' });
        const profile =
          data.billingProfileId &&
          (await queries.billingProfile(data.billingProfileId, req.user.id, req.user.role));
        if (
          data.billingProfileId &&
          (!profile || Number(profile.ownerOrganizationId) !== Number(data.organizationId))
        )
          return res
            .status(403)
            .json({ error: 'The seller billing profile must belong to the Venue organization.' });
        const id = await queries.createVenue(req.user.id, data);
        return sendVenue(res, await queries.venue(id, req.user.id, req.user.role), 201);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY')
          return res.status(409).json({ error: 'That venue slug is already in use.' });
        console.error('Venue creation failed:', error.message);
        return res.status(500).json({ error: 'Unable to create venue.' });
      }
    },
  );
  app.post(
    '/api/venues/:id/media',
    authenticate,
    requireVenueOwner,
    parseVenueImage,
    async (req, res) => {
      const venueId = Number(req.params.id);
      const altText = String(req.body.altText || '').trim();
      const caption = req.body.caption == null ? null : String(req.body.caption).trim() || null;
      const isCover = req.body.kind === 'cover';
      if (
        !Number.isInteger(venueId) ||
        venueId < 1 ||
        !req.file ||
        altText.length < 3 ||
        altText.length > 200 ||
        caption?.length > 500 ||
        !['cover', 'gallery'].includes(req.body.kind)
      )
        return res.status(422).json({ error: 'Venue image is invalid.' });
      try {
        await ensureTable();
        if (!(await queries.canManageVenue(venueId, req.user.id, req.user.role)))
          return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        const filename = await venueFtpService.uploadVenueImage(venueId, req.file);
        const id = await queries.addVenueMedia(venueId, filename, altText, caption, isCover);
        return res.status(201).json({
          id,
          filename,
          url: venueImageUrl(filename, venueImageToken(filename)),
          altText,
          caption,
          isCover,
        });
      } catch (error) {
        if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message });
        if (error.code === 'FTP_NOT_CONFIGURED')
          return res.status(503).json({ error: 'Venue image storage is not configured.' });
        console.error('Venue image upload failed:', error.message);
        return res.status(502).json({ error: 'Unable to upload venue image.' });
      }
    },
  );
  app.get('/api/venues/:id/bookings', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      const bookings = await queries.venueBookings(venueId, req.user.id, req.user.role);
      if (!bookings.length && !(await queries.venue(venueId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Venue not found or not managed by you.' });
      return res.json(bookings);
    } catch (error) {
      console.error('Venue bookings lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue bookings.' });
    }
  });
  app.get('/api/venues/:id/availability', optionalAuthenticate, async (req, res) => {
    const venueId = Number(req.params.id);
    const range = availabilityRange(req.query.from, req.query.to);
    if (req.query.from !== undefined || req.query.to !== undefined) {
      if (!Number.isInteger(venueId) || venueId < 1 || !range)
        return res.status(422).json({ error: 'Provide a valid date range of at most 94 days.' });
      try {
        await ensureTable();
        const availability = await queries.calculateVenueAvailability(
          venueId,
          range.from,
          range.to,
        );
        if (!availability)
          return res.status(404).json({ error: 'Venue not found or unavailable.' });
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(availability);
      } catch (error) {
        console.error('Venue availability lookup failed:', error.message);
        return res.status(500).json({ error: 'Unable to load venue availability.' });
      }
    }
    const date = requestedAvailabilityDate(req.query.date);
    if (!Number.isInteger(venueId) || venueId < 1 || !date)
      return res.status(422).json({
        error: 'Provide a valid availability date between today and one year from today.',
      });
    try {
      await ensureTable();
      const availability = await queries.calculateVenueAvailability(venueId, date, date);
      if (!availability) return res.status(404).json({ error: 'Venue not found or unavailable.' });
      const day = availability.dates[0];
      let nextAvailable = null;
      if (!day.availableIntervals.length) {
        const nextDates = await queries.calculateVenueAvailability(
          venueId,
          addDateDays(date, 1),
          addDateDays(date, 14),
        );
        const nextDay = nextDates?.dates.find((item) => item.availableIntervals.length);
        if (nextDay) {
          const interval = nextDay.availableIntervals[0];
          nextAvailable = { date: nextDay.date, startTime: interval.start, endTime: interval.end };
        }
      }
      // Keep the original `slots` shape for existing event editors, but make
      // it represent bookable intervals rather than the venue's opening hours.
      return res.json({
        venueId,
        date,
        timezone: availability.timezone,
        slots: day.availableIntervals.map((slot) => ({ startTime: slot.start, endTime: slot.end })),
        unavailableSlots: (day.unavailableIntervals || []).map((slot) => ({
          startTime: slot.start,
          endTime: slot.end,
        })),
        nextAvailable,
        availabilityStatus: day.availabilityStatus,
        bookingMode: availability.bookingMode,
        slotIncrementMinutes: availability.slotIncrementMinutes,
        minimumBookingMinutes: availability.minimumBookingMinutes,
        maximumBookingMinutes: availability.maximumBookingMinutes,
        bufferBeforeMinutes: availability.bufferBeforeMinutes,
        bufferAfterMinutes: availability.bufferAfterMinutes,
      });
    } catch (error) {
      console.error('Venue availability lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue availability.' });
    }
  });
  app.get('/api/venues/:id/calendar', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    const range = availabilityRange(
      req.query.from ?? req.query.startDate,
      req.query.to ?? req.query.endDate,
    );
    if (!Number.isInteger(venueId) || venueId < 1 || !range)
      return res.status(422).json({ error: 'Provide a valid date range of at most 94 days.' });
    try {
      await ensureTable();
      const calendar = await queries.venueCalendar(
        venueId,
        req.user.id,
        req.user.role,
        range.from,
        range.to,
      );
      if (!calendar) return res.status(403).json({ error: 'Venue manager access is required.' });
      res.set('Cache-Control', 'private, no-store');
      return res.json(calendar);
    } catch (error) {
      console.error('Venue calendar lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue calendar.' });
    }
  });
  app.get('/api/venues/:id/booking-settings', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      if (!(await queries.canManageVenue(venueId, req.user.id, req.user.role)))
        return res.status(403).json({ error: 'Venue manager access is required.' });
      return res.json(await queries.venueBookingSettings(venueId));
    } catch (error) {
      console.error('Booking settings lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load booking settings.' });
    }
  });
  app.put('/api/venues/:id/booking-settings', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      const existing = await queries.venueBookingSettings(venueId);
      const { data, errors } = bookingSettingsData(req.body, existing || {});
      if (Object.keys(errors).length)
        return res.status(422).json({ error: 'Booking settings are invalid.', fields: errors });
      if (!(await queries.updateVenueBookingSettings(venueId, req.user.id, req.user.role, data)))
        return res.status(403).json({ error: 'Venue manager access is required.' });
      return res.json(data);
    } catch (error) {
      console.error('Booking settings update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update booking settings.' });
    }
  });
  app.get(
    '/api/venues/:id/financial-settings',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1)
        return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        const settings = await queries.venueFinancialSettings(venueId, req.user.id, req.user.role);
        return settings
          ? res.json(settings)
          : res.status(403).json({ error: 'Venue billing access is required.' });
      } catch (error) {
        console.error('Venue financial settings lookup failed:', error.message);
        return res.status(500).json({ error: 'Unable to load Venue billing settings.' });
      }
    },
  );
  app.put(
    '/api/venues/:id/financial-settings',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1)
        return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        const existing = await queries.venueFinancialSettings(venueId, req.user.id, req.user.role);
        if (!existing) return res.status(403).json({ error: 'Venue billing access is required.' });
        const { data, errors } = venueFinancialSettingsData(req.body, existing);
        if (Object.keys(errors).length)
          return res
            .status(422)
            .json({ error: 'Venue billing settings are invalid.', fields: errors });
        const result = await queries.saveVenueFinancialSettings(
          venueId,
          req.user.id,
          req.user.role,
          data,
        );
        if (result?.error === 'SELLER_PROFILE_ORGANIZATION_MISMATCH')
          return res.status(422).json({
            code: result.error,
            error:
              'Choose an active organization Billing Profile owned by this Venue organization.',
          });
        if (result?.error)
          return res
            .status(result.error === 'NOT_FOUND' ? 404 : 403)
            .json({ code: result.error, error: 'Venue billing settings could not be saved.' });
        return res.json(result);
      } catch (error) {
        console.error('Venue financial settings update failed:', error.message);
        return res.status(500).json({ error: 'Unable to save Venue billing settings.' });
      }
    },
  );
  app.get(
    '/api/venues/:id/financial-readiness',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1)
        return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        const readiness = await queries.getVenueFinancialReadiness(
          venueId,
          req.user.id,
          req.user.role,
        );
        return readiness
          ? res.json(readiness)
          : res.status(403).json({ error: 'Venue billing access is required.' });
      } catch (error) {
        console.error('Venue financial readiness lookup failed:', error.message);
        return res.status(500).json({ error: 'Unable to check Venue financial readiness.' });
      }
    },
  );
  app.put(
    '/api/venues/:id/availability-overrides',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      const validated = availabilityOverrides(req.body.overrides);
      if (!Number.isInteger(venueId) || venueId < 1 || validated.error)
        return res.status(422).json({ error: validated.error || 'A valid venue id is required.' });
      try {
        await ensureTable();
        if (
          !(await queries.replaceVenueAvailabilityOverrides(
            venueId,
            req.user.id,
            req.user.role,
            validated.overrides,
          ))
        )
          return res.status(403).json({ error: 'Venue manager access is required.' });
        return res.json({ venueId, overrides: validated.overrides });
      } catch (error) {
        console.error('Availability override update failed:', error.message);
        return res.status(500).json({ error: 'Unable to update availability overrides.' });
      }
    },
  );
  app.post(
    '/api/venues/:id/availability-blocks',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      const interval = await venueInterval(venueId, req.body);
      const startAt = interval?.startAt;
      const endAt = interval?.endAt;
      const reason = req.body.reason == null ? null : String(req.body.reason).trim() || null;
      if (
        !Number.isInteger(venueId) ||
        venueId < 1 ||
        !startAt ||
        !endAt ||
        startAt >= endAt ||
        reason?.length > 5000
      )
        return res.status(422).json({ error: 'A valid future block interval is required.' });
      try {
        await ensureTable();
        const id = await queries.createVenueAvailabilityBlock(venueId, req.user.id, req.user.role, {
          startAt,
          endAt,
          reason,
        });
        if (!id) return res.status(403).json({ error: 'Venue manager access is required.' });
        return res.status(201).json({ id, venueId, startAt, endAt });
      } catch (error) {
        console.error('Availability block creation failed:', error.message);
        return res.status(500).json({ error: 'Unable to create availability block.' });
      }
    },
  );
  app.post('/api/venues/:id/blocks', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    const interval = await venueInterval(venueId, req.body);
    const startAt = interval?.startAt;
    const endAt = interval?.endAt;
    const reason = req.body.reason == null ? null : String(req.body.reason).trim() || null;
    if (
      !Number.isInteger(venueId) ||
      venueId < 1 ||
      !startAt ||
      !endAt ||
      startAt >= endAt ||
      reason?.length > 5000
    )
      return res.status(422).json({ error: 'A valid future block interval is required.' });
    try {
      await ensureTable();
      const id = await queries.createVenueAvailabilityBlock(venueId, req.user.id, req.user.role, {
        startAt,
        endAt,
        reason,
      });
      if (!id) return res.status(403).json({ error: 'Venue manager access is required.' });
      return res.status(201).json({ id, venueId, startAt, endAt });
    } catch (error) {
      console.error('Availability block creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to create availability block.' });
    }
  });
  app.delete(
    '/api/venues/:id/availability-blocks/:blockId',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      const blockId = Number(req.params.blockId);
      if (!Number.isInteger(venueId) || !Number.isInteger(blockId))
        return res.status(422).json({ error: 'Valid venue and block ids are required.' });
      try {
        await ensureTable();
        if (
          !(await queries.deleteVenueAvailabilityBlock(
            venueId,
            blockId,
            req.user.id,
            req.user.role,
          ))
        )
          return res.status(404).json({ error: 'Block not found or not managed by you.' });
        return res.status(204).send();
      } catch (error) {
        console.error('Availability block deletion failed:', error.message);
        return res.status(500).json({ error: 'Unable to delete availability block.' });
      }
    },
  );
  app.post(
    '/api/venues/:id/external-reservations',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      const interval = await venueInterval(venueId, req.body);
      const startAt = interval?.startAt;
      const endAt = interval?.endAt;
      const source = String(req.body.source || 'external');
      const title = req.body.title == null ? null : String(req.body.title).trim() || null;
      const notes = req.body.notes == null ? null : String(req.body.notes).trim() || null;
      if (
        !Number.isInteger(venueId) ||
        venueId < 1 ||
        !startAt ||
        !endAt ||
        startAt >= endAt ||
        !['external', 'internal', 'phone', 'email', 'other_platform', 'other'].includes(source) ||
        title?.length > 255 ||
        notes?.length > 5000
      )
        return res.status(422).json({ error: 'External reservation is invalid.' });
      try {
        await ensureTable();
        const result = await queries.createExternalReservation(
          venueId,
          req.user.id,
          req.user.role,
          { startAt, endAt, source, title, notes },
        );
        if (result.error === 'CONFLICT')
          return res.status(409).json({ error: 'The venue is already occupied for this time.' });
        if (result.error)
          return res
            .status(result.error === 'FORBIDDEN' ? 403 : 404)
            .json({ error: 'Venue not found or not managed by you.' });
        return res.status(201).json({ id: result.id, venueId, startAt, endAt, source, title });
      } catch (error) {
        console.error('External reservation creation failed:', error.message);
        return res.status(500).json({ error: 'Unable to create external reservation.' });
      }
    },
  );
  app.post('/api/venues/:id/reservations', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    const interval = await venueInterval(venueId, req.body);
    const startAt = interval?.startAt;
    const endAt = interval?.endAt;
    const source = String(req.body.source || 'external');
    const title = req.body.title == null ? null : String(req.body.title).trim() || null;
    const notes = req.body.notes == null ? null : String(req.body.notes).trim() || null;
    if (
      !Number.isInteger(venueId) ||
      venueId < 1 ||
      !startAt ||
      !endAt ||
      startAt >= endAt ||
      !['external', 'internal', 'phone', 'email', 'other_platform', 'other'].includes(source) ||
      title?.length > 255 ||
      notes?.length > 5000
    )
      return res.status(422).json({ error: 'External reservation is invalid.' });
    try {
      await ensureTable();
      const result = await queries.createExternalReservation(venueId, req.user.id, req.user.role, {
        startAt,
        endAt,
        source,
        title,
        notes,
      });
      if (result.error === 'CONFLICT')
        return res.status(409).json({ error: 'The venue is already occupied for this time.' });
      if (result.error)
        return res
          .status(result.error === 'FORBIDDEN' ? 403 : 404)
          .json({ error: 'Venue not found or not managed by you.' });
      return res.status(201).json({ id: result.id, venueId, startAt, endAt, source, title });
    } catch (error) {
      console.error('External reservation creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to create external reservation.' });
    }
  });
  app.post(
    '/api/venues/:id/external-reservations/:reservationId/cancel',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.id);
      const reservationId = Number(req.params.reservationId);
      if (!Number.isInteger(venueId) || !Number.isInteger(reservationId))
        return res.status(422).json({ error: 'Valid venue and reservation ids are required.' });
      try {
        await ensureTable();
        if (
          !(await queries.cancelExternalReservation(
            venueId,
            reservationId,
            req.user.id,
            req.user.role,
          ))
        )
          return res
            .status(404)
            .json({ error: 'Future external reservation not found or not managed by you.' });
        return res.status(204).send();
      } catch (error) {
        console.error('External reservation cancellation failed:', error.message);
        return res.status(500).json({ error: 'Unable to cancel external reservation.' });
      }
    },
  );
  app.put('/api/venues/:id/availability', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    const validated = venueAvailability(req.body.availability);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    if (validated.error) return res.status(422).json({ error: validated.error });
    if (validated.errors)
      return res.status(422).json({ error: 'Availability is invalid.', fields: validated.errors });
    try {
      await ensureTable();
      if (
        !(await queries.replaceVenueAvailability(
          venueId,
          req.user.id,
          req.user.role,
          validated.slots,
        ))
      )
        return res.status(404).json({ error: 'Venue not found or not managed by you.' });
      return res.json({ venueId, availability: await queries.venueAvailability(venueId) });
    } catch (error) {
      console.error('Venue availability update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update venue availability.' });
    }
  });
  app.patch(
    '/api/venues/:id',
    authenticate,
    requireVenueOwner,
    ...updateGuards,
    async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1)
        return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        const existing = await queries.venue(venueId, req.user.id, req.user.role);
        if (!existing)
          return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        const { data, errors } = venueData(req.body, existing);
        if (Object.keys(errors).length)
          return res.status(422).json({ error: 'Venue is invalid.', fields: errors });
        if (
          data.organizationId &&
          !(await queries.canManageOrganization(data.organizationId, req.user.id, req.user.role))
        )
          return res.status(403).json({ error: 'Organization not found or not managed by you.' });
        const profile =
          data.billingProfileId &&
          (await queries.billingProfile(data.billingProfileId, req.user.id, req.user.role));
        if (
          data.billingProfileId &&
          (!profile || Number(profile.ownerOrganizationId) !== Number(data.organizationId))
        )
          return res
            .status(403)
            .json({ error: 'The seller billing profile must belong to the Venue organization.' });
        if (!(await queries.updateVenue(venueId, req.user.id, req.user.role, data)))
          return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        return sendVenue(res, await queries.venue(venueId, req.user.id, req.user.role));
      } catch (error) {
        console.error('Venue update failed:', error.message);
        return res.status(500).json({ error: 'Unable to update venue.' });
      }
    },
  );
  app.delete('/api/venues/:id', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      if (!(await queries.deleteVenue(venueId, req.user.id, req.user.role)))
        return res.status(404).json({ error: 'Venue not found or not managed by you.' });
      return res.status(204).send();
    } catch (error) {
      console.error('Venue deletion failed:', error.message);
      return res.status(500).json({ error: 'Unable to delete venue.' });
    }
  });
  app.post('/api/venues/:id/inquiries', authenticate, requireVerifiedUser, async (req, res) => {
    const venueId = Number(req.params.id);
    const body = req.body;
    const data = {
      eventId: body.eventId == null || body.eventId === '' ? null : Number(body.eventId),
      eventName: String(body.eventName || '').trim(),
      eventType: body.eventType == null ? null : venueSlug(body.eventType),
      requestedDate: body.requestedDate || null,
      startTime: body.startTime || null,
      endTime: body.endTime || null,
      expectedGuests:
        body.expectedGuests == null || body.expectedGuests === ''
          ? null
          : Number(body.expectedGuests),
      budget: body.budget == null || body.budget === '' ? null : Number(body.budget),
      message: String(body.message || '').trim(),
    };
    if (
      !Number.isInteger(venueId) ||
      venueId < 1 ||
      data.eventName.length < 2 ||
      data.eventName.length > 200 ||
      !data.message ||
      data.message.length > 5000 ||
      (data.eventId !== null && (!Number.isInteger(data.eventId) || data.eventId < 1)) ||
      (data.expectedGuests !== null &&
        (!Number.isInteger(data.expectedGuests) || data.expectedGuests < 1)) ||
      (data.budget !== null && (!Number.isFinite(data.budget) || data.budget < 0)) ||
      (data.requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.requestedDate)) ||
      (data.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.startTime)) ||
      (data.endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.endTime)) ||
      (data.startTime && data.endTime && data.endTime <= data.startTime)
    )
      return res.status(422).json({ error: 'Venue inquiry is invalid.' });
    try {
      await ensureTable();
      const venue = await queries.venue(venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      if (
        data.eventId &&
        !(await queries.eventForVenueInquiry(data.eventId, req.user.id, req.user.role))
      )
        return res.status(404).json({ error: 'Event not found or not managed by you.' });
      const id = await queries.createVenueInquiry(venueId, req.user.id, data);
      return res.status(201).json({ id, venueId, status: 'new' });
    } catch (error) {
      console.error('Venue inquiry creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to send venue request.' });
    }
  });
  app.get('/api/venues/:id/inquiries', authenticate, requireVenueOwner, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      const inquiries = await queries.venueInquiries(venueId, req.user.id, req.user.role);
      return inquiries === null
        ? res.status(403).json({ error: 'Venue manager access is required.' })
        : res.json(inquiries);
    } catch (error) {
      console.error('Venue inquiry lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue requests.' });
    }
  });
  app.patch(
    '/api/venues/:venueId/inquiries/:id',
    authenticate,
    requireVenueOwner,
    async (req, res) => {
      const venueId = Number(req.params.venueId);
      const inquiryId = Number(req.params.id);
      const status = String(req.body.status || '');
      if (
        !Number.isInteger(venueId) ||
        !Number.isInteger(inquiryId) ||
        !['new', 'viewed', 'responded', 'accepted', 'declined', 'cancelled'].includes(status)
      )
        return res.status(422).json({ error: 'A valid inquiry id and status are required.' });
      try {
        await ensureTable();
        if (
          !(await queries.updateVenueInquiryStatus(
            inquiryId,
            venueId,
            req.user.id,
            req.user.role,
            status,
          ))
        )
          return res.status(404).json({ error: 'Venue request not found or not managed by you.' });
        return res.json({ id: inquiryId, venueId, status });
      } catch (error) {
        console.error('Venue inquiry update failed:', error.message);
        return res.status(500).json({ error: 'Unable to update venue request.' });
      }
    },
  );
  app.post('/api/venues/:id/save', authenticate, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      const saved = await queries.saveVenue(venueId, req.user.id);
      return saved
        ? res.status(201).json({ venueId, saved: true })
        : res.status(404).json({ error: 'Venue not found or unavailable.' });
    } catch (error) {
      console.error('Venue save failed:', error.message);
      return res.status(500).json({ error: 'Unable to save venue.' });
    }
  });
  app.delete('/api/venues/:id/save', authenticate, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      await queries.unsaveVenue(venueId, req.user.id);
      return res.status(204).send();
    } catch (error) {
      console.error('Venue unsave failed:', error.message);
      return res.status(500).json({ error: 'Unable to remove saved venue.' });
    }
  });
  app.post('/api/venues/:id/reports', optionalAuthenticate, async (req, res) => {
    const venueId = Number(req.params.id);
    const reason = String(req.body.reason || '').trim();
    const description = String(req.body.description || '').trim();
    const reporterEmail =
      req.user?.email ||
      (req.body.reporterEmail == null
        ? null
        : String(req.body.reporterEmail).trim().toLowerCase() || null);
    if (
      !Number.isInteger(venueId) ||
      venueId < 1 ||
      ![
        'fake_listing',
        'incorrect_information',
        'scam_fraud',
        'illegal_activity',
        'unsafe_venue',
        'inappropriate_content',
        'privacy',
        'intellectual_property',
        'other',
      ].includes(reason) ||
      !description ||
      description.length > 5000 ||
      !reporterEmail
    )
      return res
        .status(422)
        .json({ error: 'A valid report reason, explanation, and email are required.' });
    try {
      await ensureTable();
      if (!(await queries.venue(venueId)))
        return res.status(404).json({ error: 'Venue not found.' });
      const reference = reportReference();
      const id = await queries.createContentReport({
        reference,
        reporterUserId: req.user?.id || null,
        reporterEmail,
        entityType: 'venue',
        entityId: String(venueId),
        contentUrl: null,
        reasonCode:
          reason === 'scam_fraud'
            ? 'scam_fraud'
            : reason === 'privacy'
              ? 'privacy'
              : reason === 'intellectual_property'
                ? 'intellectual_property'
                : 'other',
        description,
        supportingDetails: `Venue report reason: ${reason}`,
        allegedIllegal: reason === 'illegal_activity' || reason === 'scam_fraud',
      });
      return res.status(201).json({ id, reference, status: 'submitted' });
    } catch (error) {
      console.error('Venue report submission failed:', error.message);
      return res.status(500).json({ error: 'Unable to submit venue report.' });
    }
  });
  app.get('/api/my/saved-venues', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return sendVenueList(res, await queries.savedVenues(req.user.id));
    } catch (error) {
      console.error('Saved venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load saved venues.' });
    }
  });
  app.get('/api/venues/:id/similar', optionalAuthenticate, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      const venues = await queries.similarVenues(
        venueId,
        req.user?.id ?? null,
        req.user?.role ?? null,
      );
      return venues === null
        ? res.status(404).json({ error: 'Venue not found.' })
        : sendVenueList(res, venues);
    } catch (error) {
      console.error('Similar venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load similar venues.' });
    }
  });
  app.get('/api/venues/slug/:slug', optionalAuthenticate, async (req, res) => {
    const slug = venueSlug(req.params.slug);
    if (!slug) return res.status(422).json({ error: 'A valid venue slug is required.' });
    try {
      await ensureTable();
      const venue = await queries.venueBySlug(slug, req.user?.id ?? null, req.user?.role ?? null);
      return venue ? sendVenue(res, venue) : res.status(404).json({ error: 'Venue not found.' });
    } catch (error) {
      console.error('Venue slug lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue.' });
    }
  });
  app.get('/api/venues/:id', optionalAuthenticate, async (req, res) => {
    const venueId = Number(req.params.id);
    if (!Number.isInteger(venueId) || venueId < 1)
      return res.status(422).json({ error: 'A valid venue id is required.' });
    try {
      await ensureTable();
      const venue = await queries.venue(venueId, req.user?.id ?? null, req.user?.role ?? null);
      return venue ? sendVenue(res, venue) : res.status(404).json({ error: 'Venue not found.' });
    } catch (error) {
      console.error('Venue lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue.' });
    }
  });
}
