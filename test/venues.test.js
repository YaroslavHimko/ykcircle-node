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

  assert.match(calls[0].sql, /COALESCE\(v\.is_active, TRUE\) = TRUE AND v\.moderation_status = 'approved' OR v\.owner_user_id = \?/);
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

test('only exposes approved venues publicly and labels active promotions as sponsored', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(null, null, { city: 'Stockholm', venueType: 'event-space', minCapacity: 50, maxPrice: 5000, verifiedOnly: true });

  assert.match(calls[0].sql, /v\.is_active, TRUE\) = TRUE AND v\.moderation_status = 'approved'/);
  assert.match(calls[0].sql, /type\.slug = \?/);
  assert.match(calls[0].sql, /COALESCE\(v\.capacity_max, v\.standing_capacity, v\.seated_capacity, 0\) >= \?/);
  assert.match(calls[0].sql, /v\.verification_status = 'verified'/);
  assert.match(calls[0].sql, /AS sponsored/);
  assert.deepEqual(calls[0].parameters, ['Stockholm', 'Stockholm', 'event-space', 50, 5000]);
});

test('normalizes venue booleans and withholds private location data from public views', () => {
  const queries = new Queries({ execute: async () => [[]] });
  const venue = queries.normalizeVenue({ id: 7, isActive: 1, isVerified: 0, isFeatured: 1, sponsored: 1, locationVisibility: 'private_until_booking', addressLine1: 'Private Street 1', postalCode: '111 22', latitude: '59.3', longitude: '18.0', city: 'Stockholm', country: 'Sweden', capacityMax: '80', priceFrom: '650.00', priceUnit: 'hour', currency: 'SEK' }, { publicView: true });

  assert.equal(venue.isActive, true);
  assert.equal(venue.isVerified, false);
  assert.equal(venue.sponsored, true);
  assert.equal(venue.addressLine1, null);
  assert.equal(venue.postalCode, null);
  assert.equal(venue.location.latitude, null);
  assert.deepEqual(venue.capacity, { min: null, max: 80, standing: null, seated: null, dining: null, classroom: null });
});
