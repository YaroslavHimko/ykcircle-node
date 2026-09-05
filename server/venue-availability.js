// The availability engine intentionally deals in intervals, never generated
// slots.  Its inputs are already scoped to one venue by the query layer.

import { addDays, isDateOnly, localDateTimeToUtc, weekdayForDate, zonedDateTime } from './time.js';

export { addDays, isDateOnly, localDateTimeToUtc } from './time.js';
export const venueWeekday = weekdayForDate;

export function subtractIntervals(free, busy) {
  let remaining = free.map((interval) => ({ ...interval }));
  for (const blocked of busy) {
    remaining = remaining.flatMap((interval) => {
      if (blocked.end <= interval.start || blocked.start >= interval.end) return [interval];
      const result = [];
      if (blocked.start > interval.start) result.push({ start: interval.start, end: Math.min(blocked.start, interval.end) });
      if (blocked.end < interval.end) result.push({ start: Math.max(blocked.end, interval.start), end: interval.end });
      return result;
    });
  }
  return remaining.filter((interval) => interval.start < interval.end);
}

export function mergeIntervals(intervals) {
  return [...intervals].sort((left, right) => left.start - right.start).reduce((merged, interval) => {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = new Date(Math.max(previous.end.getTime(), interval.end.getTime()));
    else merged.push({ ...interval });
    return merged;
  }, []);
}

export function timeIntervalsForDate(date, timezone, windows) {
  return windows.map((window) => ({
    start: localDateTimeToUtc(date, window.startTime, timezone, 'start'),
    end: localDateTimeToUtc(date, window.endTime, timezone, 'end'),
  })).filter((interval) => interval.start && interval.end && interval.start < interval.end);
}

export function formatLocalTime(instant, timezone) {
  return zonedDateTime(instant, timezone)?.time || '';
}

export function calculateAvailability({ from, to, timezone, rules, overrides, blocks, bookings, externalReservations }) {
  const dateKey = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const overrideByDate = new Map(overrides.map((override) => [dateKey(override.date), override]));
  const dates = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const override = overrideByDate.get(date);
    const windows = override?.overrideType === 'closed' ? [] : override?.overrideType === 'custom'
      ? override.windows : rules.filter((rule) => rule.weekday === venueWeekday(date) && rule.isActive !== false);
    let intervals = timeIntervalsForDate(date, timezone, windows);
    const dayStart = localDateTimeToUtc(date, '00:00', timezone, 'start');
    const nextDayStart = localDateTimeToUtc(addDays(date, 1), '00:00', timezone, 'start');
    const busy = mergeIntervals([
      ...blocks, ...externalReservations,
      ...bookings.filter((booking) => ['requested', 'confirmed'].includes(booking.status)),
    ].map((item) => ({ start: new Date(item.startAt), end: new Date(item.endAt) }))
      .filter((interval) => !Number.isNaN(interval.start) && !Number.isNaN(interval.end)
      && (!dayStart || !nextDayStart || (interval.start < nextDayStart && interval.end > dayStart))));
    const unavailableIntervals = busy.map((interval) => ({
      start: dayStart && interval.start < dayStart ? dayStart : interval.start,
      end: nextDayStart && interval.end > nextDayStart ? nextDayStart : interval.end,
    })).filter((interval) => interval.start < interval.end).map((interval) => ({ start: formatLocalTime(interval.start, timezone), end: formatLocalTime(interval.end, timezone) }));
    intervals = subtractIntervals(intervals, busy);
    dates.push({ date, availabilityStatus: intervals.length ? 'available' : 'unavailable', availableIntervals: intervals.map((interval) => ({ start: formatLocalTime(interval.start, timezone), end: formatLocalTime(interval.end, timezone) })), unavailableIntervals });
  }
  return dates;
}
