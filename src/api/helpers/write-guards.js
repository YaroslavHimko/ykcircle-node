import crypto from 'node:crypto';
import { createRateLimiter } from '../middleware/rate-limit.js';

export function createHttpWriteGuards({ authSecret }) {
  const anonymisedIp = (req) =>
    crypto
      .createHash('sha256')
      .update(`${authSecret}:${req.ip || 'unknown'}`)
      .digest('hex')
      .slice(0, 16);
  const writeLimitLog =
    (scope) =>
    (req, { retryAfter, max, windowMs }) =>
      console.warn('Venue/event write rate limit reached.', {
        scope,
        accountId: req.user?.id || null,
        ipHash: anonymisedIp(req),
        route: req.originalUrl,
        action: req.method,
        decision: 'blocked',
        retryAfter,
        max,
        windowMs,
      });
  const createAccountLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 5,
    key: (req) => `account:${req.user?.id || 'unknown'}`,
    message: 'Too many venue or event creations. Please try again later.',
    onBlocked: writeLimitLog('venue-event-create-account'),
  });
  const createIpLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 10,
    key: (req) => `ip:${req.ip || 'unknown'}`,
    message: 'Too many venue or event creations from this IP address. Please try again later.',
    onBlocked: writeLimitLog('venue-event-create-ip'),
  });
  const updateAccountLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 30,
    key: (req) => `account:${req.user?.id || 'unknown'}`,
    message: 'Too many venue or event edits. Please try again later.',
    onBlocked: writeLimitLog('venue-event-update-account'),
  });
  const updateIpLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 60,
    key: (req) => `ip:${req.ip || 'unknown'}`,
    message: 'Too many venue or event edits from this IP address. Please try again later.',
    onBlocked: writeLimitLog('venue-event-update-ip'),
  });
  const locationActivity = new Map();
  const noteLocationActivity = (action) => (req, _res, next) => {
    const location =
      req.body?.location && typeof req.body.location === 'object' ? req.body.location : {};
    const placeId =
      req.body?.googlePlaceId || req.body?.customGooglePlaceId || location.googlePlaceId;
    if (!placeId) return next();
    const now = Date.now();
    const identity = `${req.user?.id || 'unknown'}:${anonymisedIp(req)}:${action}`;
    const entry = locationActivity.get(identity) || { timestamps: [], lastLoggedAt: 0 };
    entry.timestamps = entry.timestamps.filter((time) => now - time < 10 * 60 * 1000);
    entry.timestamps.push(now);
    if (entry.timestamps.length >= 20 && now - entry.lastLoggedAt >= 10 * 60 * 1000) {
      entry.lastLoggedAt = now;
      console.warn('Unusually high Google Places-backed location activity.', {
        accountId: req.user?.id || null,
        ipHash: anonymisedIp(req),
        route: req.originalUrl,
        action,
        count: entry.timestamps.length,
        windowMs: 10 * 60 * 1000,
      });
    }
    locationActivity.set(identity, entry);
    if (locationActivity.size > 10000) {
      for (const [entryKey, activity] of locationActivity) {
        if (
          !activity.timestamps.length ||
          now - activity.timestamps.at(-1) >= 10 * 60 * 1000 ||
          locationActivity.size > 10000
        )
          locationActivity.delete(entryKey);
        if (locationActivity.size <= 10000) break;
      }
    }
    return next();
  };
  const creationGuards = [createAccountLimit, createIpLimit, noteLocationActivity('create')];
  const updateGuards = [updateAccountLimit, updateIpLimit, noteLocationActivity('update')];
  const placesActivityReportLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 3,
    key: (req) => `account:${req.user?.id || 'unknown'}`,
    message: 'Too many Places activity reports. Please try again later.',
    onBlocked: writeLimitLog('places-activity-report'),
  });
  return { anonymisedIp, creationGuards, updateGuards, placesActivityReportLimit };
}
