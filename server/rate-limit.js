/**
 * Small in-process rolling-window limiter for application routes.
 *
 * This deliberately has no dependency on Express configuration so protected
 * routes can use an authenticated account key as well as an IP key.
 */
export const createRateLimiter = ({
  windowMs,
  max,
  key = (req) => req.ip,
  message = 'Too many requests. Please try again later.',
  onBlocked = null,
}) => {
  const attempts = new Map();
  const maxEntries = 10000;

  return (req, res, next) => {
    const now = Date.now();
    const identity = String(key(req) || req.ip || 'unknown').slice(0, 320);
    const values = (attempts.get(identity) || []).filter((time) => now - time < windowMs);
    if (values.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((values[0] + windowMs - now) / 1000));
      onBlocked?.(req, { identity, retryAfter, windowMs, max });
      return res.status(429).set('Retry-After', String(retryAfter)).json({ error: message, retryAfter });
    }

    values.push(now);
    attempts.set(identity, values);
    if (attempts.size > maxEntries) {
      for (const [entryKey, entryValues] of attempts) {
        if (!entryValues.length || now - entryValues.at(-1) >= windowMs || attempts.size > maxEntries) attempts.delete(entryKey);
        if (attempts.size <= maxEntries) break;
      }
    }
    return next();
  };
};
