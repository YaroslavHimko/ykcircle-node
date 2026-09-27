import test from 'node:test';
import assert from 'node:assert/strict';
import { Queries } from '../server/queries.js';

const draft = {
  managerId: 7, title: 'Venue event', locationType: 'venue', venueId: 4,
  startsAt: '2026-10-10 10:00:00', endsAt: '2026-10-10 12:00:00', timezone: 'UTC',
};

function fixture({ existingBooking = null, conflictAt = 0, profile = null, owner = 7 } = {}) {
  const calls = [];
  let nextId = 11;
  let conflictsChecked = 0;
  const connection = {
    beginTransaction: async () => calls.push({ action: 'begin' }),
    commit: async () => calls.push({ action: 'commit' }),
    rollback: async () => calls.push({ action: 'rollback' }),
    release: () => calls.push({ action: 'release' }),
    query: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ insertId: ++nextId, affectedRows: 1 }];
    },
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      if (sql.startsWith('SELECT manager_id AS managerId')) return [[{ managerId: owner }]];
      if (sql.startsWith('SELECT venue_id AS venueId') || sql.startsWith('SELECT id, status FROM venue_bookings')) return [existingBooking ? [existingBooking] : []];
      if (sql.startsWith('SELECT starts_at AS startsAt')) return [[{ startsAt: new Date('2026-10-10T10:00:00Z'), endsAt: new Date('2026-10-10T12:00:00Z') }]];
      if (sql.startsWith('SELECT id, timezone, price_from')) return [[{ id: 4, timezone: 'UTC', priceFrom: 100, currency: 'SEK' }]];
      if (sql.includes('FROM venue_booking_settings')) return [[{ bookingMode: 'hourly', beforeMinutes: 0, afterMinutes: 0, currency: 'SEK', hourlyRate: 100 }]];
      if (sql.includes('FROM billing_profiles p')) return [profile ? [profile] : []];
      if (sql.startsWith('INSERT INTO venue_bookings')) return [{ insertId: 22 }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const queries = new Queries({ execute: connection.execute, getConnection: async () => connection });
  queries.checkBookingConflict = async () => ({ conflict: ++conflictsChecked === conflictAt });
  return { queries, calls };
}

test('a paid venue request is committed with the draft even without a billing profile', async () => {
  const { queries, calls } = fixture();
  assert.deepEqual(await queries.createRichEventSeries(draft, { bookVenue: true, role: 'organizer' }), { seriesId: null, eventIds: [12] });
  const insertIndex = calls.findIndex(({ sql }) => sql?.startsWith('INSERT INTO venue_bookings'));
  assert.ok(insertIndex > 0);
  assert.deepEqual(calls[insertIndex].parameters.slice(0, 6), [4, 12, 7, null, 'incomplete', 'hourly']);
  assert.match(calls[insertIndex].sql, /'requested'/);
  assert.equal(calls[insertIndex].parameters.at(-1), 200);
  assert.ok(calls.findIndex(({ action }) => action === 'commit') > insertIndex);
  assert.equal(calls.filter(({ action }) => action === 'begin').length, 1);
  assert.equal(calls.some(({ action }) => action === 'rollback'), false);
});

test('a conflict rolls back event creation instead of silently saving an unbooked draft', async () => {
  const { queries, calls } = fixture({ conflictAt: 1 });
  await assert.rejects(queries.createRichEventSeries(draft, { bookVenue: true }), { code: 'VENUE_UNAVAILABLE' });
  assert.equal(calls.some(({ action }) => action === 'commit'), false);
  assert.deepEqual(calls.filter(({ action }) => action).map(({ action }) => action), ['begin', 'rollback', 'release']);
});

test('a conflict in a later recurrence rolls back the entire event and booking series', async () => {
  const { queries, calls } = fixture({ conflictAt: 2 });
  await assert.rejects(queries.createRichEventSeries({ ...draft, recurrence: { frequency: 'weekly', interval: 1, count: 3 } }, { bookVenue: true }), { code: 'VENUE_UNAVAILABLE' });
  assert.equal(calls.filter(({ sql }) => sql?.startsWith('INSERT INTO events')).length, 3);
  assert.equal(calls.filter(({ sql }) => sql?.startsWith('INSERT INTO venue_bookings')).length, 1);
  assert.equal(calls.some(({ action }) => action === 'commit'), false);
  assert.equal(calls.some(({ action }) => action === 'rollback'), true);
});

test('an unavailable explicitly selected billing profile still rejects the request', async () => {
  const { queries, calls } = fixture();
  assert.deepEqual(await queries.requestVenueBooking(12, 4, 7, 'organizer', 51), { error: 'BILLING_PROFILE_UNAVAILABLE' });
  assert.equal(calls.some(({ sql }) => sql?.startsWith('INSERT INTO venue_bookings')), false);
  assert.equal(calls.some(({ action }) => action === 'rollback'), true);
});

test('saving an existing draft creates its missing booking for the original organizer', async () => {
  const { queries, calls } = fixture({ owner: 7 });
  assert.equal(await queries.updateRichEventAndBooking(12, 99, 'admin', draft), true);
  const insert = calls.find(({ sql }) => sql?.startsWith('INSERT INTO venue_bookings'));
  assert.deepEqual(insert.parameters.slice(0, 3), [4, 12, 7]);
  assert.equal(calls.some(({ action }) => action === 'commit'), true);
});

test('a booking conflict while saving a draft rolls back the event update', async () => {
  const { queries, calls } = fixture({ conflictAt: 1 });
  await assert.rejects(queries.updateRichEventAndBooking(12, 7, 'organizer', draft), { code: 'VENUE_UNAVAILABLE' });
  assert.equal(calls.some(({ sql }) => sql?.startsWith('UPDATE events')), true);
  assert.equal(calls.some(({ action }) => action === 'commit'), false);
  assert.equal(calls.some(({ action }) => action === 'rollback'), true);
});

for (const status of ['requested', 'confirmed', 'declined', 'cancelled']) {
  test(`saving a draft preserves its existing ${status} booking`, async () => {
    const { queries, calls } = fixture({ existingBooking: { venueId: 4, startAt: '2026-10-10T10:00:00Z', endAt: '2026-10-10T12:00:00Z', status } });
    assert.equal(await queries.updateRichEventAndBooking(12, 7, 'organizer', draft), true);
    assert.equal(calls.some(({ sql }) => sql?.startsWith('INSERT INTO venue_bookings')), false);
  });
}

test('changing an active booking time fails without changing the event or booking', async () => {
  const { queries, calls } = fixture({ existingBooking: { venueId: 4, startAt: draft.startsAt, endAt: draft.endsAt, status: 'confirmed' } });
  await assert.rejects(queries.updateRichEventAndBooking(12, 7, 'organizer', { ...draft, endsAt: '2026-10-10 13:00:00' }), { code: 'EVENT_ALREADY_BOOKED' });
  assert.equal(calls.some(({ sql }) => sql?.startsWith('UPDATE events')), false);
  assert.equal(calls.some(({ action }) => action === 'commit'), false);
});

test('a paid request without buyer billing details cannot be confirmed', async () => {
  const { queries, calls } = fixture();
  queries.getVenueBookingBillingReadiness = async () => ({ isInvoiceRequired: true, priceReady: true, buyerBillingProfileReady: false });
  queries.venueBookingFinancialContext = async () => ({ venueId: 4 });
  queries.canManageVenueBilling = async () => true;
  assert.deepEqual(await queries.reviewVenueBooking(22, 15, 'venue_owner', 'confirmed'), { error: 'BUYER_PROFILE_INCOMPLETE' });
  assert.deepEqual(calls, []);
});
