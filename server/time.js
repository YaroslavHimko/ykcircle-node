// Canonical time rules for the API.  Instants cross the API boundary as ISO
// timestamps with an offset (normally UTC); venue schedules remain local
// date/time values interpreted only in the venue's IANA timezone.

const formatterCache = new Map();
const supportedTimezones = typeof Intl.supportedValuesOf === 'function'
  ? new Set(Intl.supportedValuesOf('timeZone')) : null;

export const isValidIanaTimezone = (timezone) => timezone === 'UTC'
  || (typeof timezone === 'string' && (supportedTimezones ? supportedTimezones.has(timezone) : (() => {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return true; } catch { return false; }
  })()));

export const isDateOnly = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
  && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

export const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const weekdayForDate = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

export function parseUtcInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value);
  const text = String(value || '').trim().replace(' ', 'T');
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return null;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

export const mysqlUtc = (value) => {
  const instant = parseUtcInstant(value);
  return instant ? instant.toISOString().slice(0, 19).replace('T', ' ') : null;
};

function formatter(timeZone, withWeekday = false) {
  const key = `${timeZone}|${withWeekday}`;
  if (!formatterCache.has(key)) formatterCache.set(key, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withWeekday ? { weekday: 'short' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return formatterCache.get(key);
}

export function zonedParts(instant, timeZone, withWeekday = false) {
  if (!isValidIanaTimezone(timeZone)) return null;
  const value = instant instanceof Date ? instant : typeof instant === 'number' ? new Date(instant) : parseUtcInstant(instant);
  if (!value) return null;
  return Object.fromEntries(formatter(timeZone, withWeekday).formatToParts(value)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function zonedDateTime(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  return parts ? { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, seconds: parts.second } : null;
}

// Resolve a venue-local wall time without ever relying on the server's own
// timezone. An impossible spring-DST time is rejected. Fall-back ambiguity is
// deterministic: starts use the earlier instant, ends the later instant.
export function localDateTimeToUtc(date, time, timeZone, edge = 'start') {
  if (!isDateOnly(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || '')) || !isValidIanaTimezone(timeZone)) return null;
  const target = `${date} ${time}:00`;
  const nominal = Date.parse(`${date}T${time}:00Z`);
  const matchesTarget = (ms) => {
    const parts = zonedParts(new Date(ms), timeZone);
    return parts && `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` === target;
  };
  const offsetAt = (ms) => {
    const parts = zonedParts(new Date(ms), timeZone);
    return parts ? Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - ms : NaN;
  };
  let candidate = nominal - offsetAt(nominal);
  if (!matchesTarget(candidate)) candidate = nominal - offsetAt(candidate);
  if (!matchesTarget(candidate)) return null;
  const matches = [candidate];
  for (const minutes of [-180, -120, -60, -30, 30, 60, 120, 180]) {
    const alternative = candidate + minutes * 60000;
    if (matchesTarget(alternative)) matches.push(alternative);
  }
  return new Date(edge === 'end' ? Math.max(...matches) : Math.min(...matches));
}
