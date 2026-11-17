import { isDateOnly } from './time.js';
export const foodSelections = (value) => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((option) => typeof option === 'string') : [];
  } catch {
    return [];
  }
};
export const utcTimestamp = (value) => {
  if (!value) return value;
  const instant =
    value instanceof Date
      ? value
      : new Date(`${String(value).replace(' ', 'T').replace(/Z$/i, '')}Z`);
  return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
};
export const dateOnly = (value) => {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const date = String(value ?? '').slice(0, 10);
  return isDateOnly(date) ? date : null;
};
export const jsonValue = (value) => {
  if (!value || typeof value === 'object') return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
