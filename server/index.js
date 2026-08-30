import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import cors from 'cors';
import { Database } from './database.js';
import { EmailService } from './email-service.js';
import { Configuration } from './configuration.js';
import { Queries } from './queries.js';
import { Api } from './api.js';
import { FtpService } from './ftp-service.js';
import { createRateLimiter } from './rate-limit.js';

const securityHeaders = (req, res, next) => {
  req.cspNonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Security-Policy': `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'nonce-${req.cspNonce}'; style-src 'self' 'unsafe-inline'`,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  next();
};

const loadConfiguration = async () => {
  try {
    return (await import('./config.local.js')).default;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return (await import('./config.js')).default;
  }
};

const start = async () => {
  const config = new Configuration(await loadConfiguration());
  console.info('Google Maps configuration:', {
    enabled: config.runtime.maps.enabled,
    browserApiKeyPresent: Boolean(config.runtime.maps.browserApiKey),
    requiresConsent: config.runtime.maps.requiresConsent,
  });
  const database = new Database(config.database);
  const queries = new Queries(database);
  const emailService = new EmailService({
    smtp: config.email.smtp,
    domain: config.site.domain,
    verificationUrl: config.email.urls.verification,
    passwordResetUrl: config.email.urls.passwordReset,
    applicationUrl: config.email.urls.application,
    managerEventUrl: config.email.urls.managerEvent,
    eventDetailsUrl: config.email.urls.eventDetails,
    invitationResponseUrl: config.email.urls.invitationResponse,
    groupInvitationUrl: config.email.urls.groupInvitation,
    loginUrl: config.email.urls.login,
    unsubscribeUrl: config.email.urls.unsubscribe,
    unsubscribeEndpointUrl: config.email.urls.unsubscribeEndpoint,
    unsubscribeSecret: config.runtime.authSecret,
    brandName: config.site.brandName,
    noReplyFrom: config.email.from.noReply,
    notificationFrom: config.email.from.applicationNotification,
    invitationFrom: config.email.from.invitation,
    database,
  });
  const ftpService = new FtpService(config.ftp.profilePictures);
  const eventFtpService = new FtpService(config.ftp.events);
  const venueFtpService = new FtpService(config.ftp.venues);
  const groupFtpService = new FtpService(config.ftp.groups);
  const articleFtpService = new FtpService(config.ftp.articles);
  const app = express();
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_HTTPS !== 'false') {
    app.use((req, res, next) => {
      if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
      return res.status(400).json({ error: 'HTTPS is required.' });
    });
  }
  app.use(securityHeaders);
  app.use(cors({ origin: config.runtime.allowedOrigins, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 86400 }));
  app.use(express.json());
  const byIpAndEmail = (req) => `${req.ip}:${String(req.body?.email || req.body?.reporterEmail || '').trim().toLowerCase()}`;
  const authIpLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many authentication attempts. Please try again later.' });
  const authIdentityLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10, key: byIpAndEmail, message: 'Too many authentication attempts. Please try again later.' });
  const emailIpLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: 'Too many email requests. Please try again later.' });
  const emailIdentityLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, key: byIpAndEmail, message: 'Too many email requests. Please try again later.' });
  const publicWriteLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many requests from this IP address. Please try again later.' });
  const reportLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => req.ip, message: 'Too many reports submitted. Please try again later.' });
  const uploadLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: 'Too many uploads. Please try again later.' });
  const messageLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 60, message: 'Too many messages. Please try again later.' });
  // The browser key is public by design, but this endpoint is not a general
  // configuration feed. The frontend caches it for a session, so repeated
  // requests are abusive rather than a legitimate application workflow.
  const mapsConfigLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many map configuration requests. Please try again later.' });
  const apiWriteLimit = createRateLimiter({ windowMs: 60 * 1000, max: 120, message: 'Too many write requests. Please try again shortly.' });
  app.use('/api', (req, res, next) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? apiWriteLimit(req, res, next) : next());
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
  // Keep this before API routes and any catch-all middleware so uploads are
  // always served as files by the API process.
  app.use('/uploads', express.static(path.resolve(process.cwd(), config.runtime.uploadsDir)));
  new Api({ config, database, queries, emailService, ftpService, eventFtpService, venueFtpService, groupFtpService, articleFtpService }).register(app);
  await queries.initialize();
  await queries.configureRetentionPolicies(config.runtime.retention);
  const runRetention = async () => { try { await queries.applyRetentionPolicies(config.runtime.retention); } catch (error) { console.error('Retention cleanup failed:', error.message); } };
  await runRetention();
  const retentionTimer = setInterval(runRetention, 24 * 60 * 60 * 1000);
  retentionTimer.unref();

  const server = app.listen(config.runtime.port, () => console.log(`API listening on port ${config.runtime.port}`));
  const shutdown = () => server.close(async () => { await database.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((error) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
