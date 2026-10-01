import assert from 'node:assert/strict';
import test from 'node:test';
import { Queries } from '../server/queries.js';

test('validates forum scopes before using table names in SQL', () => {
  const queries = new Queries({ execute: async () => [[]] });

  assert.deepEqual(queries.forumTables('group'), { threads: 'group_forum_threads', messages: 'group_forum_messages', owner: 'group_id' });
  assert.deepEqual(queries.forumTables('event'), { threads: 'event_forum_threads', messages: 'event_forum_messages', owner: 'event_id' });
  assert.throws(() => queries.forumTables('community'), /Invalid forum scope/);
  assert.throws(() => queries.forumTables('group; DROP TABLE users'), /Invalid forum scope/);
});

test('paginates public articles and maps stored tag lists to arrays', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 3, title: 'Published', tagSlugs: 'culture,summer' }, { id: 4, title: 'No tags', tagSlugs: null }]];
    },
  });

  const articles = await queries.articles({ categorySlug: 'news', tagSlug: 'culture', page: 2, limit: 999 });

  assert.deepEqual(articles, [
    { id: 3, title: 'Published', tagSlugs: undefined, tags: ['culture', 'summer'] },
    { id: 4, title: 'No tags', tagSlugs: undefined, tags: [] },
  ]);
  assert.match(calls[0].sql, /BINARY a\.status = BINARY 'published'/);
  assert.match(calls[0].sql, /c\.slug = \?/);
  assert.match(calls[0].sql, /filter_t\.slug = \?/);
  assert.deepEqual(calls[0].parameters, ['news', 'culture', 50, 50]);
});

test('publishing an article records the timestamp after creating it', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return calls.length === 1 ? [{ insertId: 28 }] : [{ affectedRows: 1 }];
    },
  });

  const id = await queries.createArticle({ slug: 'hello', authorUserId: 4, categoryId: 2, title: 'Hello', excerpt: 'Short', body: 'Body', status: 'published', isIndexable: true });

  assert.equal(id, 28);
  assert.match(calls[0].sql, /INSERT INTO articles/);
  assert.deepEqual(calls[1].parameters, [28]);
  assert.match(calls[1].sql, /published_at = NOW\(\)/);
});

test('limits non-admin role changes to eligible customer accounts', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  });

  assert.equal(await queries.updateUserRole(8, 'admin', 'manager'), true);
  assert.deepEqual(calls[0].parameters, ['organizer', 8]);
  assert.match(calls[0].sql, /role = 'customer'/);
});

test('gates a draft event cover to its manager and uses binary filename comparisons', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 1, publiclyVisible: 0 }]];
    },
  });

  assert.deepEqual(await queries.eventCoverVisible('event-1-1786906288459.png', 7, 'customer'), { id: 1, publiclyVisible: false });
  assert.match(calls[0].sql, /BINARY e\.cover_image = BINARY \?/);
  assert.match(calls[0].sql, /e\.manager_id = \?/);
  assert.deepEqual(calls[0].parameters, ['event-1-1786906288459.png', 7]);
});

test('lets a site manager reach any event cover without an owner parameter', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 1, publiclyVisible: 1 }]];
    },
  });

  assert.deepEqual(await queries.eventCoverVisible('event-1-1786906288459.png', 99, 'admin'), { id: 1, publiclyVisible: true });
  assert.deepEqual(calls[0].parameters, ['event-1-1786906288459.png']);
});

test('lists invoices only for the buyer or a managing seller member', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 14, status: 'issued', eventTitle: 'Autumn social' }]];
    },
  });

  assert.deepEqual(await queries.invoicesForViewer(7, 'venue_owner'), [{ id: 14, status: 'issued', eventTitle: 'Autumn social' }]);
  assert.match(calls[0].sql, /i\.buyer_user_id=\?/);
  assert.match(calls[0].sql, /seller_member\.role IN \('owner','admin','manager'\)/);
  assert.deepEqual(calls[0].parameters, [7, 7, 7, 7, 7]);
});

test('filters accessible invoices to the selected venue', async () => {
  const calls = [];
  const queries = new Queries({ execute: async (sql, parameters) => { calls.push({ sql, parameters }); return [[]]; } });

  await queries.invoicesForViewer(7, 'venue_owner', { venueId: 12 });

  assert.match(calls[0].sql, /booking\.venue_id=\?/);
  assert.deepEqual(calls[0].parameters, [7, 7, 7, 7, 7, 12]);
});

test('lists venue bookings for organization managers as well as the venue owner', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 22, status: 'requested' }]];
    },
  });

  assert.deepEqual(await queries.venueBookings(7, 15, 'venue_owner'), [{ id: 22, status: 'requested' }]);
  assert.match(calls[0].sql, /LEFT JOIN organization_members venue_member/);
  assert.match(calls[0].sql, /venue_member\.role IN \('owner','admin','manager'\)/);
  assert.match(calls[0].sql, /ORDER BY CASE WHEN b\.status = 'requested' THEN 0 ELSE 1 END, b\.created_at DESC/);
  assert.deepEqual(calls[0].parameters, [15, 7, 15]);
});

test('uses the default billing profile and prorates an hourly venue booking', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, parameters = []) => {
      calls.push({ sql, parameters });
      if (sql.includes('FROM product_configuration')) return [[{ settings: { paidVenuesEnabled: true } }]];
      if (sql.startsWith('SELECT starts_at AS startsAt')) return [[{ startsAt: '2026-10-10T10:00:00Z', endsAt: '2026-10-10T10:30:00Z' }]];
      if (sql.startsWith('SELECT id, timezone, price_from')) return [[{ id: 4, timezone: 'UTC', priceFrom: '1800.00', currency: 'SEK' }]];
      if (sql.startsWith('SELECT id, status FROM venue_bookings')) return [[]];
      if (sql.includes('FROM venue_booking_settings WHERE venue_id=?')) return [[{ bookingMode: 'hourly', beforeMinutes: 0, afterMinutes: 0, currency: 'SEK', hourlyRate: '1800.00', dailyRate: null }]];
      if (sql.includes('FROM billing_profiles p')) return [[{ id: 51, ownerUserId: 7, ownerOrganizationId: null, profileType: 'individual', legalName: 'Anna Example', addressLine1: 'Main 1', postalCode: '111 11', city: 'Stockholm', country: 'Sweden', billingEmail: 'anna@example.test', isDefault: true, isActive: true }]];
      if (sql.startsWith('SELECT timezone FROM venues')) return [[{ timezone: 'UTC' }]];
      if (sql.includes('SELECT id, booking_type AS bookingType')) return [[]];
      if (sql.includes('FROM venue_external_reservations')) return [[]];
      if (sql.startsWith('INSERT INTO venue_bookings')) return [{ insertId: 22 }];
      return [{ affectedRows: 1 }];
    },
  };
  const queries = new Queries({ execute: async () => [[]], getConnection: async () => connection });

  assert.deepEqual(await queries.requestVenueBooking(12, 4, 7, 'organizer'), { id: 22, status: 'requested' });
  assert.ok(calls.some((call) => call.sql.includes('ORDER BY p.is_default DESC')));
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO venue_bookings'));
  assert.match(insert.sql, /subtotal, tax_amount, total_amount/);
  assert.equal(insert.parameters.at(-2), 900);
  assert.equal(insert.parameters.at(-1), 900);
});

test('charges a daily venue once and records a daily booking', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, parameters = []) => {
      calls.push({ sql, parameters });
      if (sql.includes('FROM product_configuration')) return [[{ settings: { paidVenuesEnabled: true } }]];
      if (sql.startsWith('SELECT starts_at AS startsAt')) return [[{ startsAt: '2026-10-10T00:00:00Z', endsAt: '2026-10-11T00:00:00Z' }]];
      if (sql.startsWith('SELECT id, timezone, price_from')) return [[{ id: 4, timezone: 'UTC', priceFrom: '1800.00', currency: 'SEK' }]];
      if (sql.startsWith('SELECT id, status FROM venue_bookings')) return [[]];
      if (sql.includes('FROM venue_booking_settings WHERE venue_id=?')) return [[{ bookingMode: 'daily', beforeMinutes: 0, afterMinutes: 0, currency: 'SEK', hourlyRate: null, dailyRate: '6500.00' }]];
      if (sql.includes('FROM billing_profiles p')) return [[{ id: 51, isDefault: true }]];
      if (sql.startsWith('SELECT timezone FROM venues')) return [[{ timezone: 'UTC' }]];
      if (sql.includes('SELECT id, booking_type AS bookingType')) return [[]];
      if (sql.includes('FROM venue_external_reservations')) return [[]];
      if (sql.startsWith('INSERT INTO venue_bookings')) return [{ insertId: 23 }];
      return [{ affectedRows: 1 }];
    },
  };
  const queries = new Queries({ execute: async () => [[]], getConnection: async () => connection });

  assert.deepEqual(await queries.requestVenueBooking(12, 4, 7, 'organizer'), { id: 23, status: 'requested' });
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO venue_bookings'));
  assert.equal(insert.parameters[5], 'daily');
  assert.equal(insert.parameters.at(-2), 6500);
  assert.equal(insert.parameters.at(-1), 6500);
});

test('uses boolean confirmation flags when reviewing a venue booking', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: async (sql, parameters = []) => {
      calls.push({ sql, parameters });
      if (sql.includes('FROM venue_bookings b JOIN venues')) return [[{ id: 22, venueId: 4, organizerUserId: 9, sellerOrganizationId: null, bookingType: 'hourly', status: 'requested', startAt: '2026-10-10T10:00:00Z', endAt: '2026-10-10T12:00:00Z', occupiedStartAt: '2026-10-10T10:00:00Z', occupiedEndAt: '2026-10-10T12:00:00Z', hourlyRate: 0, currency: 'SEK', invoiceMode: 'ykcircle' }]];
      if (sql.startsWith('SELECT id FROM venues')) return [[{ id: 4 }]];
      if (sql.startsWith('SELECT timezone FROM venues')) return [[{ timezone: 'UTC' }]];
      if (sql.includes('SELECT id, booking_type AS bookingType')) return [[]];
      if (sql.includes('FROM venue_external_reservations')) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const queries = new Queries({ execute: connection.execute, getConnection: async () => connection });

  assert.deepEqual(await queries.reviewVenueBooking(22, 15, 'venue_owner', 'confirmed', 'Approved'), { invoiceId: null, invoiceMode: 'ykcircle', paymentStatus: 'not_required' });
  const update = calls.find((call) => call.sql.startsWith('UPDATE venue_bookings SET status='));
  assert.doesNotMatch(update.sql, /\?='confirmed'/);
  assert.deepEqual(update.parameters, ['confirmed', 'Approved', 'Approved', true, true, 15, true, 22]);
});

test('checks a daily booking when MySQL returns its booking date as a Date', async () => {
  const connection = {
    execute: async (sql) => {
      if (sql.startsWith('SELECT timezone FROM venues')) return [[{ timezone: 'UTC' }]];
      if (sql.includes('SELECT id, booking_type AS bookingType')) return [[]];
      if (sql.includes('FROM venue_external_reservations')) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const queries = new Queries({ execute: connection.execute });

  assert.deepEqual(await queries.checkBookingConflict({
    venueId: 3,
    bookingType: 'daily',
    bookingDate: new Date('2026-09-11T00:00:00.000Z'),
  }, connection), { conflict: false });
});

test('returns booking messages only after verifying conversation access', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT b.id FROM venue_bookings')) return [[{ id: 22 }]];
      return [[{ id: 3, bookingId: 22, senderUserId: 15, senderName: 'Venue owner', body: 'Can we discuss setup?', createdAt: '2026-10-10 10:00:00' }]];
    },
  });

  const messages = await queries.venueBookingMessages(22, 15, 'venue_owner');
  assert.equal(messages[0].body, 'Can we discuss setup?');
  assert.match(calls[0].sql, /organizer_user_id=\?/);
  assert.match(calls[0].sql, /venue_member\.role IN \('owner','admin','manager'\)/);
  assert.deepEqual(calls[0].parameters, [15, 22, 15, 15]);
});

test('keeps rich event location columns and values aligned', async () => {
  const queries = new Queries({ execute: async () => [[]] });
  let insert;
  await queries.insertRichEvent({ query: async (sql, values) => { insert = { sql, values }; return [{ insertId: 1 }]; } }, {
    managerId: 1, title: 'Location test', locationType: 'custom', customFormattedAddress: 'Stockholm, Sweden', customLatitude: 59.3293, customLongitude: 18.0686,
  }, 1);

  assert.equal(insert.values.length, 41);
  assert.equal((insert.sql.match(/\?/g) || []).length, 41);
  assert.match(insert.sql, /venue_id, custom_address_line_1/);
  assert.match(insert.sql, /online_url, online_platform/);
});
