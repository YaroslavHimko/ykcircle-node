import assert from 'node:assert/strict';
import test from 'node:test';
import { Queries } from '../server/queries.js';

test('public venue listing selects active venues without an anonymous owner parameter', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 7, isActive: 1 }]];
    },
  });

  const venues = await queries.venuesForViewer();

  assert.equal(venues.length, 1);
  assert.match(calls[0].sql, /COALESCE\(v\.is_active, TRUE\) = TRUE/);
  assert.deepEqual(calls[0].parameters, []);
});

test('a customer sees active venues and their own inactive venues', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(42, 'customer');

  assert.match(calls[0].sql, /COALESCE\(v\.is_active, TRUE\) = TRUE OR v\.owner_user_id = \?/);
  assert.deepEqual(calls[0].parameters, [42]);
});

test('a venue owner can limit the listing to venues they manage', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(42, 'venue_owner', { managedOnly: true });

  assert.match(calls[0].sql, /WHERE \(v\.owner_user_id = \? OR EXISTS \(SELECT 1 FROM organization_members managed_member/);
  assert.deepEqual(calls[0].parameters, [42, 42]);
});

test('a manager can see every venue, including inactive and managed listings', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(9, 'manager');
  await queries.venuesForViewer(9, 'manager', { managedOnly: true });

  assert.match(calls[0].sql, /WHERE TRUE ORDER BY/);
  assert.match(calls[1].sql, /WHERE TRUE ORDER BY/);
  assert.deepEqual(calls[0].parameters, []);
  assert.deepEqual(calls[1].parameters, []);
});

test('only exposes active venues publicly and labels active promotions as sponsored', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(null, null, { city: 'Stockholm', venueType: 'event-space', minCapacity: 50, maxPrice: 5000, verifiedOnly: true });

  assert.match(calls[0].sql, /COALESCE\(v\.is_active, TRUE\) = TRUE/);
  assert.doesNotMatch(calls[0].sql, /moderation_status = 'approved'/);
  assert.match(calls[0].sql, /type\.slug = \?/);
  assert.match(calls[0].sql, /COALESCE\(v\.capacity_max, v\.standing_capacity, v\.seated_capacity, 0\) >= \?/);
  assert.match(calls[0].sql, /v\.verification_status = 'verified'/);
  assert.match(calls[0].sql, /AS sponsored/);
  assert.deepEqual(calls[0].parameters, ['Stockholm', 'Stockholm', 'event-space', 50, 5000]);
});

test('normalizes venue booleans and withholds private location data from public views', () => {
  const queries = new Queries({ execute: async () => [[]] });
  const venue = queries.normalizeVenue({ id: 7, isActive: 1, isVerified: 0, isFeatured: 1, sponsored: 1, locationVisibility: 'private', addressLine1: 'Private Street 1', postalCode: '111 22', latitude: '59.3', longitude: '18.0', city: 'Stockholm', country: 'Sweden', capacityMax: '80', priceFrom: '650.00', priceUnit: 'hour', currency: 'SEK' }, { publicView: true });

  assert.equal(venue.isActive, true);
  assert.equal(venue.isVerified, false);
  assert.equal(venue.sponsored, true);
  assert.equal(venue.addressLine1, null);
  assert.equal(venue.postalCode, null);
  assert.equal(venue.location.latitude, null);
  assert.deepEqual(venue.capacity, { min: null, max: 80, standing: null, seated: null, dining: null, classroom: null });
});

test('normalizes each event location source without leaking private venue details', () => {
  const queries = new Queries({ execute: async () => [[]] });
  const venueEvent = queries.normalizeRichEventLocation({ id: 3, locationType: 'venue', venueId: 8, venueName: 'Private loft', venueAddressLine1: 'Secret 1', venuePostalCode: '111 22', venueLatitude: '59.3', venueLongitude: '18.0', venueLocationVisibility: 'private' }, { publicView: true });
  assert.equal(venueEvent.location, null);
  assert.equal(venueEvent.venue.location.visibility, 'private');
  assert.equal(venueEvent.venue.location.addressLine1, null);
  assert.equal(venueEvent.venue.location.latitude, null);

  const customEvent = queries.normalizeRichEventLocation({ id: 4, locationType: 'custom', customFormattedAddress: 'Sergels torg, Stockholm', customLatitude: '59.332', customLongitude: '18.064', customCountryCode: 'SE' }, { publicView: true });
  assert.equal(customEvent.location.latitude, 59.332);
  assert.equal(customEvent.location.longitude, 18.064);
  assert.equal(customEvent.location.formattedAddress, 'Sergels torg, Stockholm');

  const onlineEvent = queries.normalizeRichEventLocation({ id: 5, locationType: 'online', onlineUrl: 'https://meeting.example/private' }, { publicView: true });
  assert.equal(onlineEvent.location, null);
  assert.equal(onlineEvent.venue, null);
  assert.equal(onlineEvent.onlineUrl, null);
});

test('creates an expanded venue with matching columns, values, and parameters', async () => {
  const calls = [];
  const queries = new Queries({ execute: async (sql, parameters) => { calls.push({ sql, parameters }); return [{ insertId: 9 }]; } });
  queries.replaceVenueRelations = async () => {};
  const data = { organizationId: 4, billingProfileId: 5, name: 'Demo', slug: 'demo', businessName: null, shortDescription: null, description: null, addressLine1: null, addressLine2: null, postalCode: null, country: 'Sweden', countryCode: 'SE', city: 'Nacka', municipality: null, region: null, latitude: null, longitude: null, googlePlaceId: null, formattedAddress: null, locationVisibility: 'exact', timezone: 'UTC', venueType: 'studio', capacityMin: null, capacityMax: 60, standingCapacity: 60, seatedCapacity: 30, diningCapacity: null, classroomCapacity: null, sizeSqm: 220, priceFrom: 1800, priceUnit: 'hour', currency: 'SEK', pricingDescription: null, minimumBookingHours: 2, websiteUrl: null, phone: null, contactEmail: null, availabilityType: 'calendar', houseRulesText: null, isActive: true, amenitySlugs: [], suitableEventTypeSlugs: [] };
  assert.equal(await queries.createVenue(1, data), 9);
  assert.equal(calls[0].parameters.length, 41);
  assert.equal((calls[0].sql.match(/\?/g) || []).length, 41);
});

test('returns only the recurring venue hours for one requested date', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return calls.length === 1
        ? [[{ id: 7, timezone: 'Europe/Stockholm' }]]
        : [[{ startTime: '09:00', endTime: '17:00' }]];
    },
  });

  const result = await queries.venueAvailabilityForDate(7, '2026-08-31');

  assert.deepEqual(result, { venueId: 7, date: '2026-08-31', timezone: 'Europe/Stockholm', slots: [{ startTime: '09:00', endTime: '17:00' }] });
  assert.match(calls[0].sql, /is_active = TRUE/);
  assert.match(calls[0].sql, /moderation_status = 'approved'/);
  assert.match(calls[1].sql, /day_of_week = \?/);
  assert.deepEqual(calls[1].parameters, [7, 1]);
});

test('venue image visibility admits managers of an unapproved venue without widening it publicly', async () => {
  const calls = [];
  const stub = (row) => new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [row ? [row] : []];
    },
  });
  const filename = 'venue-4-1788107654373-s044wf1o.png';

  // An anonymous visitor keeps the approved-and-active predicate, and binds
  // NULL for both membership and ownership so neither can match.
  const anonymous = await stub({ id: 1, publiclyVisible: 1 }).venueImageVisible(filename);
  assert.deepEqual(anonymous, { id: 1, publiclyVisible: true });
  assert.match(calls[0].sql, /v\.is_active = TRUE AND v\.moderation_status = 'approved'/);
  assert.deepEqual(calls[0].parameters, [null, filename, null]);

  // An owner or organisation manager reaches a draft venue's image, and the
  // owner id is bound after the filename to match the predicate order.
  const owner = await stub({ id: 1, publiclyVisible: 0 }).venueImageVisible(filename, 12, 'venue_owner');
  assert.deepEqual(owner, { id: 1, publiclyVisible: false });
  assert.match(calls[1].sql, /v\.owner_user_id = \?/);
  assert.match(calls[1].sql, /om\.role IN \('owner','admin','manager'\)/);
  assert.deepEqual(calls[1].parameters, [12, filename, 12]);

  // A platform manager bypasses the predicate entirely and binds one id only.
  const privileged = await stub({ id: 1, publiclyVisible: 0 }).venueImageVisible(filename, 3, 'manager');
  assert.equal(privileged.publiclyVisible, false);
  assert.match(calls[2].sql, /WHERE m\.filename = \? AND \(TRUE\)/);
  assert.deepEqual(calls[2].parameters, [3, filename]);

  assert.equal(await stub(null).venueImageVisible(filename, 99, 'customer'), null);
});

test('venue moderation compares statuses without blending parameter and column collations', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  });

  assert.equal(await queries.moderateVenue(5, 'approved', null, null), true);

  const { sql, parameters } = calls[0];
  // Comparing a bound parameter with a SQL string literal is what MySQL
  // rejects: the driver's collation and the literal's are both COERCIBLE, so
  // neither takes precedence. Status comparisons must happen in JavaScript.
  assert.doesNotMatch(sql, /\?\s*=\s*'/);
  assert.doesNotMatch(sql, /'[^']*'\s*=\s*\?/);
  assert.doesNotMatch(sql, /COALESCE\(\?, verification_status\)\s*=/);
  // Column-versus-literal is safe and still carries the derivation.
  assert.match(sql, /THEN verification_status = 'verified'/);
  // Placeholders and parameters must stay aligned as branches are added.
  assert.equal((sql.match(/\?/g) || []).length, parameters.length);
  assert.deepEqual(parameters, ['approved', null, null, false, null, true, 5]);

  await queries.moderateVenue(5, 'pending', 'verified', true);
  assert.deepEqual(calls[1].parameters, ['pending', 'verified', 'verified', true, true, false, 5]);
});

test('venue owners can submit only draft or rejected listings for moderation', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  });

  assert.equal(await queries.submitVenueForModeration(7), true);
  assert.match(calls[0].sql, /SET moderation_status = 'pending'/);
  assert.match(calls[0].sql, /moderation_status IN \('draft', 'rejected'\)/);
  assert.deepEqual(calls[0].parameters, [7]);
});
