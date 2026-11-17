import { createRateLimiter } from './rate-limit.js';
export function registerRateLimits(app) {
  const byIpAndEmail = (req) =>
    `${req.ip}:${String(req.body?.email || req.body?.reporterEmail || '')
      .trim()
      .toLowerCase()}`;
  const authIpLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many authentication attempts. Please try again later.',
  });
  const authIdentityLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: byIpAndEmail,
    message: 'Too many authentication attempts. Please try again later.',
  });
  const emailIpLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: 'Too many email requests. Please try again later.',
  });
  const emailIdentityLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    key: byIpAndEmail,
    message: 'Too many email requests. Please try again later.',
  });
  const publicWriteLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'Too many requests from this IP address. Please try again later.',
  });
  const reportLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 5,
    key: (req) => req.ip,
    message: 'Too many reports submitted. Please try again later.',
  });
  const uploadLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: 'Too many uploads. Please try again later.',
  });
  const messageLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 60,
    message: 'Too many messages. Please try again later.',
  });
  // The browser key is public by design, but this endpoint is not a general
  // configuration feed. The frontend caches it for a session, so repeated
  // requests are abusive rather than a legitimate application workflow.
  const mapsConfigLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many map configuration requests. Please try again later.',
  });
  const apiWriteLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many write requests. Please try again shortly.',
  });
  app.use('/api', (req, res, next) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      ? apiWriteLimit(req, res, next)
      : next(),
  );
  app.post('/api/auth/login', authIpLimit, authIdentityLimit);
  app.post('/api/auth/register', publicWriteLimit);
  app.post('/api/auth/resend-verification', emailIpLimit, emailIdentityLimit);
  app.post('/api/auth/forgot-password', emailIpLimit, emailIdentityLimit);
  app.post('/api/contact', publicWriteLimit);
  app.post('/api/reports', reportLimit);
  app.post('/api/invitations/respond', publicWriteLimit);
  app.post('/api/auth/profile/picture', uploadLimit);
  app.post('/api/events/:id/cover', uploadLimit);
  app.post('/api/venues/:id/media', uploadLimit);
  app.post('/api/groups/:id/cover', uploadLimit);
  app.post('/api/articles/:id/cover', uploadLimit);
  app.post('/api/articles/:id/media', uploadLimit);
  app.get('/api/maps/config', mapsConfigLimit);
  app.post('/api/groups/:groupId/threads/:threadId/messages', messageLimit);
  app.post('/api/events/:eventId/threads/:threadId/messages', messageLimit);
}
