import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAvailability, localDateTimeToUtc } from '../server/venue-availability.js';

test('availability replaces recurring hours with custom dates and subtracts private occupancy', () => {
  const dates = calculateAvailability({
    from: '2026-09-14', to: '2026-09-14', timezone: 'Europe/Stockholm',
    rules: [{ weekday: 1, startTime: '09:00', endTime: '17:00', isActive: true }],
    overrides: [{ date: '2026-09-14', overrideType: 'custom', windows: [{ startTime: '10:00', endTime: '18:00' }] }],
    blocks: [{ startAt: '2026-09-14T08:00:00.000Z', endAt: '2026-09-14T09:00:00.000Z' }],
    externalReservations: [{ startAt: '2026-09-14T11:00:00.000Z', endAt: '2026-09-14T12:00:00.000Z' }],
    bookings: [{ status: 'confirmed', startAt: '2026-09-14T13:00:00.000Z', endAt: '2026-09-14T14:00:00.000Z' }],
  });
  assert.deepEqual(dates[0].availableIntervals, [{ start: '11:00', end: '13:00' }, { start: '14:00', end: '15:00' }, { start: '16:00', end: '18:00' }]);
});

test('an hourly booking leaves the hours before and after it available', () => {
  const dates = calculateAvailability({
    from: '2026-09-14', to: '2026-09-14', timezone: 'Europe/Stockholm',
    rules: [{ weekday: 1, startTime: '09:00', endTime: '17:00', isActive: true }],
    overrides: [], blocks: [], externalReservations: [],
    bookings: [{ status: 'confirmed', startAt: '2026-09-14T08:00:00.000Z', endAt: '2026-09-14T10:00:00.000Z' }],
  });

  assert.deepEqual(dates[0].availableIntervals, [{ start: '09:00', end: '10:00' }, { start: '12:00', end: '17:00' }]);
});

test('each confirmed booking splits the day into additional free intervals', () => {
  const dates = calculateAvailability({
    from: '2026-09-14', to: '2026-09-14', timezone: 'Europe/Stockholm',
    rules: [{ weekday: 1, startTime: '09:00', endTime: '17:00', isActive: true }],
    overrides: [], blocks: [], externalReservations: [],
    bookings: [
      { status: 'confirmed', startAt: '2026-09-14T08:00:00.000Z', endAt: '2026-09-14T09:00:00.000Z' },
      { status: 'confirmed', startAt: '2026-09-14T11:00:00.000Z', endAt: '2026-09-14T12:00:00.000Z' },
    ],
  });

  assert.deepEqual(dates[0].availableIntervals, [
    { start: '09:00', end: '10:00' },
    { start: '11:00', end: '13:00' },
    { start: '14:00', end: '17:00' },
  ]);
});

test('a requested booking reserves its interval and exposes only a generic unavailable range', () => {
  const dates = calculateAvailability({
    from: '2026-09-14', to: '2026-09-14', timezone: 'Europe/Stockholm',
    rules: [{ weekday: 1, startTime: '09:00', endTime: '17:00', isActive: true }],
    overrides: [], blocks: [], externalReservations: [],
    bookings: [{ status: 'requested', startAt: '2026-09-14T08:00:00.000Z', endAt: '2026-09-14T09:00:00.000Z' }],
  });

  assert.deepEqual(dates[0].availableIntervals, [{ start: '09:00', end: '10:00' }, { start: '11:00', end: '17:00' }]);
  assert.deepEqual(dates[0].unavailableIntervals, [{ start: '10:00', end: '11:00' }]);
});

test('a declined booking releases its interval', () => {
  const [date] = calculateAvailability({
    from: '2026-09-14', to: '2026-09-14', timezone: 'Europe/Stockholm',
    rules: [{ weekday: 1, startTime: '09:00', endTime: '17:00', isActive: true }],
    overrides: [], blocks: [], externalReservations: [],
    bookings: [{ status: 'declined', startAt: '2026-09-14T08:00:00.000Z', endAt: '2026-09-14T09:00:00.000Z' }],
  });

  assert.deepEqual(date.availableIntervals, [{ start: '09:00', end: '17:00' }]);
  assert.deepEqual(date.unavailableIntervals, []);
});

test('unavailable ranges are expressed in the venue timezone, not the browser or UTC', () => {
  const [date] = calculateAvailability({
    from: '2026-09-14', to: '2026-09-14', timezone: 'Asia/Tokyo',
    rules: [{ weekday: 1, startTime: '09:00', endTime: '17:00', isActive: true }],
    overrides: [], blocks: [], externalReservations: [],
    // 01:00Z is 10:00 in Tokyo. The response must never expose it as 01:00.
    bookings: [{ status: 'confirmed', startAt: '2026-09-14T01:00:00.000Z', endAt: '2026-09-14T02:00:00.000Z' }],
  });
  assert.deepEqual(date.unavailableIntervals, [{ start: '10:00', end: '11:00' }]);
  assert.deepEqual(date.availableIntervals, [{ start: '09:00', end: '10:00' }, { start: '11:00', end: '17:00' }]);
});

test('venue-local conversion accounts for Stockholm daylight-saving changes', () => {
  assert.equal(localDateTimeToUtc('2026-03-29', '01:30', 'Europe/Stockholm').toISOString(), '2026-03-29T00:30:00.000Z');
  assert.equal(localDateTimeToUtc('2026-03-29', '02:30', 'Europe/Stockholm'), null);
  assert.equal(localDateTimeToUtc('2026-10-25', '02:30', 'Europe/Stockholm', 'start').toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(localDateTimeToUtc('2026-10-25', '02:30', 'Europe/Stockholm', 'end').toISOString(), '2026-10-25T01:30:00.000Z');
});
