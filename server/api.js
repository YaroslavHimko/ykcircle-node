 
import crypto from 'node:crypto';
import { APPLICATION_STATUSES, isApplicationStatus } from './application-status.js';
import { EVENT_STATUSES, isEventStatus } from './event-status.js';
import { REGISTRATION_STATUSES, isRegistrationStatus } from './registration-status.js';
import { INVITATION_STATUSES, isInvitationStatus } from './invitation-status.js';
import { PARTICIPANT_STATUSES, isParticipantStatus } from './participant-status.js';
import multer from 'multer';
import { EMAIL_UNSUBSCRIBE_REASONS } from './email-unsubscribe-reasons.js';
import { legalDocument, legalDocumentIndex, currentLegalDocument } from './legal-documents.js';
import { createRateLimiter } from './rate-limit.js';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const legalHtml = (markdown) => escapeHtml(markdown).split(/\r?\n/).map((line) => {
  if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
  if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
  if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
  if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`;
  if (!line.trim()) return '';
  return `<p>${line}</p>`;
}).join('\n');

export class Api {
  constructor({ config, database, queries, emailService, ftpService, eventFtpService, venueFtpService, groupFtpService, articleFtpService }) {
    this.config = config;
    this.database = database;
    this.queries = queries;
    this.emailService = emailService;
    this.ftpService = ftpService;
    this.eventFtpService = eventFtpService;
    this.venueFtpService = venueFtpService;
    this.groupFtpService = groupFtpService;
    this.articleFtpService = articleFtpService;
    this.authSecret = config.runtime.authSecret;
  }

  register(app) {
    const uploadProfilePicture = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) });
    const parseProfilePicture = (req, res, next) => uploadProfilePicture.single('profilePicture')(req, res, (error) => { if (!error) return next(); if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Profile picture must not exceed 5 MB.' }); return res.status(400).json({ error: 'Only one JPEG, PNG, GIF, or WebP image is allowed.' }); });
    const uploadEventCover = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });
    const parseEventCover = (req, res, next) => uploadEventCover.single('coverImage')(req, res, (error) => { if (!error) return next(); if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Event cover must not exceed 10 MB.' }); return res.status(400).json({ error: 'Only one JPEG, PNG, or WebP event cover is allowed.' }); });
    const parseVenueImage = (req, res, next) => uploadEventCover.single('image')(req, res, (error) => { if (!error) return next(); if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Venue images must not exceed 10 MB.' }); return res.status(400).json({ error: 'Only one JPEG, PNG, or WebP venue image is allowed.' }); });
    const uploadGroupCover = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    const parseGroupCover = (req, res, next) => uploadGroupCover.single('coverImage')(req, res, (error) => { if (!error) return next(); const message = error.code === 'LIMIT_FILE_SIZE' ? 'Group cover must not exceed 10 MB.' : 'Upload one JPEG, PNG, or WebP image using the coverImage field.'; return res.status(422).json({ error: 'Group cover is invalid.', fields: { coverImage: message } }); });
    const uploadArticleImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) });
    const parseArticleImage = (req, res, next) => uploadArticleImage.single('image')(req, res, (error) => { if (!error) return next(); const message = error.code === 'LIMIT_FILE_SIZE' ? 'Article image must not exceed 10 MB.' : 'Only one JPEG, PNG, GIF, or WebP image is allowed.'; return res.status(422).json({ error: 'Article image is invalid.', fields: { image: message } }); });
    const profileUploadRoute = `${this.ftpService.publicPath()}/:filename`;
    const eventUploadRoute = `${this.eventFtpService.publicPath()}/:filename`;
    const venueUploadRoute = `${this.venueFtpService.publicPath()}/:filename`;
    const groupUploadRoute = `${this.groupFtpService.publicPath()}/:filename`;
    const articleUploadRoute = `${this.articleFtpService.publicPath()}/:filename`;
    
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/api/application-statuses', (_req, res) => res.json(APPLICATION_STATUSES));
    app.get('/api/event-statuses', (_req, res) => res.json(EVENT_STATUSES));
    app.get('/api/registration-statuses', (_req, res) => res.json(REGISTRATION_STATUSES));
    app.get('/api/invitation-statuses', (_req, res) => res.json(INVITATION_STATUSES));
    app.get('/api/participant-statuses', (_req, res) => res.json(PARTICIPANT_STATUSES));
    app.get('/api/legal-documents', (_req, res) => res.json(legalDocumentIndex()));
    app.get('/api/legal-documents/:slug', async (req, res) => {
      try {
        const document = await legalDocument(req.params.slug, this.config);
        if (!document) return res.status(404).json({ error: 'Legal document not found.' });
        return res.json(document);
      } catch (error) { console.error('Legal document load failed:', error.message); return res.status(500).json({ error: 'Unable to load legal document.' }); }
    });
    const publicFooter = '<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/community-guidelines">Community Guidelines</a><a href="/cookies">Cookies</a><a href="/report">Report</a><a href="/appeal">Appeal</a><a href="/contact">Contact</a></footer>';
    const publicPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(this.config.site.brandName)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.55;margin:0;color:#172033;background:#f7f8fa}main{max-width:840px;margin:2rem auto;padding:2rem;background:#fff;border-radius:12px}footer{display:flex;flex-wrap:wrap;gap:1rem;margin-top:3rem;padding-top:1rem;border-top:1px solid #ddd}label,input,select,textarea,button{display:block;width:100%;box-sizing:border-box;margin:.5rem 0}input,select,textarea,button{padding:.7rem}textarea{min-height:9rem}</style></head><body><main>${body}${publicFooter}</main></body></html>`;
    for (const slug of ['terms', 'privacy', 'community-guidelines', 'cookies']) app.get(`/${slug}`, async (_req, res) => { try { const document = await legalDocument(slug, this.config); return res.type('html').send(publicPage(document.title, legalHtml(document.content))); } catch { return res.status(500).type('html').send(publicPage('Unavailable', '<h1>Document unavailable</h1>')); } });
    app.get('/report', (req, res) => res.type('html').send(publicPage('Report content', `<h1>Report content</h1><p>Use this form to report content you believe is illegal or violates the Community Guidelines.</p><form id="report"><label>Content type<select name="entityType"><option value="event">Event</option><option value="group">Group</option><option value="profile">Profile</option><option value="image">Image</option><option value="review">Review</option><option value="organization">Venue or business listing</option></select></label><label>Content URL or ID<input name="content" required></label><label>Reason<select name="reasonCode"><option value="illegal_content">Illegal content</option><option value="harassment">Harassment</option><option value="child_safety">Child safety</option><option value="privacy">Privacy</option><option value="other">Other</option></select></label><label>Your email<input name="reporterEmail" type="email" required></label><label>Explanation<textarea name="description" required></textarea></label><label><input type="checkbox" name="goodFaithDeclared" required>I submit this report in good faith.</label><button>Submit report</button></form><p id="result"></p><script nonce="${req.cspNonce}">document.querySelector('#report').onsubmit=async(e)=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));if(/^https?:/i.test(d.content))d.contentUrl=d.content;else d.entityId=d.content;delete d.content;d.goodFaithDeclared=true;const r=await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const out=await r.json();document.querySelector('#result').textContent=out.reference||out.error||'Unable to submit report.'}</script>`)));
    app.get('/contact', (req, res) => res.type('html').send(publicPage('Contact', `<h1>Contact</h1><form id="contact"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Category<select name="category"><option>General</option><option>Privacy</option><option>Account</option><option>Safety</option><option>Other</option></select></label><label>Message<textarea name="message" required></textarea></label><button>Send</button></form><p id="result"></p><script nonce="${req.cspNonce}">document.querySelector('#contact').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const d=await r.json();document.querySelector('#result').textContent=d.reference?('Reference: '+d.reference):(d.error||'Unable to send request.');}</script>`)));
    app.get('/appeal', (_req, res) => res.type('html').send(publicPage('Appeal', '<h1>Appeal a moderation decision</h1><p>Log in to the Platform, then submit your appeal through the authenticated <code>POST /api/appeals</code> endpoint with the moderation decision ID and your explanation.</p>')));
    app.get('/api/event-categories', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.eventCategories()); } catch { return res.status(500).json({ error: 'Unable to load event categories.' }); } });
    app.get('/api/event-types', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.eventTypes()); } catch { return res.status(500).json({ error: 'Unable to load event types.' }); } });
    app.get('/api/timezones', (_req, res) => {
      if (typeof Intl.supportedValuesOf !== 'function') return res.status(500).json({ error: 'Timezone data is unavailable on this server.' });
      return res.json(Intl.supportedValuesOf('timeZone'));
    });
    app.get('/api/email/unsubscribe-reasons', (_req, res) => res.json(EMAIL_UNSUBSCRIBE_REASONS));
    app.get('/api/email/unsubscribe', (req, res) => { const token = String(req.query.token || ''); const options = EMAIL_UNSUBSCRIBE_REASONS.map((reason) => `<option value="${reason.replace(/"/g, '&quot;')}">${reason}</option>`).join(''); return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;padding:32px}main{max-width:520px;margin:40px auto;background:#fff;padding:32px;border-radius:14px;box-shadow:0 4px 24px #17203318}label,select,button{display:block;width:100%;margin-top:12px}select,button{padding:12px;border-radius:8px;border:1px solid #d8deea}button{background:#0ea5e9;color:#fff;border:0;font-weight:700;cursor:pointer}</style></head><body><main><h1>Email preferences</h1><p>Why would you like to stop receiving emails?</p><form id="unsubscribe"><input type="hidden" name="token" value="${token.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/><label for="reason">Reason</label><select id="reason" name="reason" required>${options}</select><button type="submit">Unsubscribe</button></form><p id="result"></p><script nonce="${req.cspNonce}">document.getElementById('unsubscribe').addEventListener('submit',async(e)=>{e.preventDefault();const result=document.getElementById('result');const response=await fetch('/api/email/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const data=await response.json();result.textContent=data.message||data.error||'Unable to update your preference.';});</script></main></body></html>`); });
    app.post('/api/email/unsubscribe', async (req, res) => { const { token, reason } = req.body; if (!token || !EMAIL_UNSUBSCRIBE_REASONS.includes(reason)) return res.status(400).json({ error: 'A valid token and unsubscribe reason are required.' }); try { const [payload, signature] = token.split('.'); const expected = crypto.createHmac('sha256', this.authSecret).update(payload || '').digest('base64url'); if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(400).json({ error: 'Invalid unsubscribe link.' }); const email = Buffer.from(payload, 'base64url').toString(); if (!email.includes('@')) return res.status(400).json({ error: 'Invalid unsubscribe link.' }); await ensureTable(); await this.queries.setMarketingEmailPreference(email, false, null, `unsubscribe:${reason}`); return res.json({ message: 'You have been unsubscribed from marketing emails. Transactional and security messages will still be sent when necessary.' }); } catch (error) { return res.status(400).json({ error: 'Invalid unsubscribe link.' }); } });
    app.get(profileUploadRoute, async (req, res) => { try { if (!await this.ftpService.streamProfilePicture(req.params.filename, res)) return res.status(404).json({ error: 'Profile picture not found.' }); } catch (error) { console.error('Profile picture proxy failed:', error.message); if (!res.headersSent) return res.status(502).json({ error: 'Unable to load profile picture.' }); } });
    app.get(eventUploadRoute, async (req, res) => { try { await ensureTable(); if (!await this.queries.eventCover(req.params.filename) || !await this.eventFtpService.streamEventCover(req.params.filename, res)) return res.status(404).json({ error: 'Image not found.' }); } catch (error) { console.error('Event image proxy failed:', error.message); if (!res.headersSent) return res.status(502).json({ error: 'Unable to load image.' }); } });
    app.get(venueUploadRoute, async (req, res) => { try { await ensureTable(); if (!await this.queries.venueImageVisible(req.params.filename) || !await this.venueFtpService.streamVenueImage(req.params.filename, res)) return res.status(404).json({ error: 'Image not found.' }); } catch (error) { console.error('Venue image proxy failed:', error.message); if (!res.headersSent) return res.status(502).json({ error: 'Unable to load image.' }); } });
    app.get('/api/application-activities', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.applicationActivities()); } catch (error) { return res.status(500).json({ error: 'Unable to load application activities.' }); } });
    app.post('/api/invitations/respond', async (req, res) => { const { token, action } = req.body; const status = action === 'accept' ? 'Accepted' : action === 'decline' ? 'Declined' : null; if (!token || !status) return res.status(400).json({ error: 'A valid invitation token and action are required.' }); try { await ensureTable(); const invitation = status === 'Accepted' ? await this.queries.acceptInvitationAsParticipant(token) : await this.queries.respondToInvitation(token, status); if (!invitation) return res.status(400).json({ error: 'Invalid, expired, or already used invitation.' }); if (invitation.alreadyRegistered) return res.status(409).json({ error: 'This email or user is already registered for this event.', eventId: invitation.eventId, participantId: invitation.participantId || null }); return res.json({ message: status === 'Accepted' ? 'Invitation accepted. Your participation is confirmed.' : 'Invitation declined.', eventId: invitation.eventId, registrationId: null, participantId: invitation.participantId || null, requiresRegistration: Boolean(invitation.requiresRegistration), status, paymentStatus: invitation.paymentStatus || null }); } catch (error) { console.error('Invitation response failed:', error.message); return res.status(500).json({ error: 'Unable to process invitation response.' }); } });
    
    const ensureTable = () => this.queries.initialize();
    const articleImageUrl = (filename) => `${this.articleFtpService.publicPath()}/${encodeURIComponent(filename)}`;
    const groupCoverUrl = (filename) => filename ? `${this.groupFtpService.publicPath()}/${encodeURIComponent(filename)}` : null;
    const apiAssetUrl = (value) => {
      if (!value || typeof value !== 'string') return value;
      if (value.startsWith('/')) return value;
      try { return new URL(value).pathname; } catch { /* Stored event images are normally filenames. */ }
      const malformedUrl = value.match(/^https?\/\/[^/]+(\/.*)?$/i);
      if (malformedUrl) return malformedUrl[1] || null;
      return `${this.eventFtpService.publicPath()}/${encodeURIComponent(value)}`;
    };
    const decorateGroup = (group) => {
      if (!group) return group;
      if (group.coverImage) group.coverImageUrl = groupCoverUrl(group.coverImage);
      if (Array.isArray(group.events)) {
        group.events = group.events.map((event) => ({
          ...event,
          coverImageUrl: apiAssetUrl(event.coverImageUrl || event.coverImage),
          thumbnailUrl: apiAssetUrl(event.thumbnailUrl || event.coverImage),
        }));
      }
      return group;
    };
    const decorateGroups = (groups) => groups.map(decorateGroup);
    const decorateArticleImageUrls = (article) => {
      if (article.coverImage) article.coverImageUrl = articleImageUrl(article.coverImage);
      article.body = String(article.body || '').replace(/\/uploads\/article-images\//g, articleImageUrl('article-image-placeholder.png').replace(/article-image-placeholder\.png$/, ''));
      article.media = article.media?.map((media) => ({ ...media, url: articleImageUrl(media.filename) }));
      return article;
    };
    
    const hashPassword = (password) => new Promise((resolve, reject) => {
      const salt = crypto.randomBytes(16).toString('hex');
      crypto.scrypt(password, salt, 64, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(`${salt}:${derivedKey.toString('hex')}`);
      });
    });
    const createVerificationToken = () => crypto.randomBytes(32).toString('hex');
    const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
    const verifyPassword = (password, stored) => new Promise((resolve, reject) => {
      const [salt, hash] = stored.split(':');
      crypto.scrypt(password, salt, 64, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(hash.length === derivedKey.toString('hex').length && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derivedKey));
      });
    });
    const createToken = (user) => {
      const payload = Buffer.from(JSON.stringify({ id: user.id, sessionVersion: user.sessionVersion, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
      const signature = crypto.createHmac('sha256', this.authSecret).update(payload).digest('base64url');
      return `${payload}.${signature}`;
    };
    const authenticate = async (req, res, next) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ error: 'Authentication required.' });
      const [payload, signature] = token.split('.');
      try {
      const expected = crypto.createHmac('sha256', this.authSecret).update(payload).digest('base64url');
        if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid token');
        const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (user.exp < Date.now()) throw new Error('Expired token');
        await ensureTable();
        req.user = await this.queries.findUserById(user.id);
        if (!req.user || user.sessionVersion !== req.user.sessionVersion) throw new Error('User not found');
        res.set('Cache-Control', 'no-store');
        return next();
      } catch { return res.status(401).json({ error: 'Invalid or expired token.' }); }
    };
    const optionalAuthenticate = async (req, _res, next) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next();
      const [payload, signature] = token.split('.');
      try {
        const expected = crypto.createHmac('sha256', this.authSecret).update(payload).digest('base64url');
        if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return next();
        const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (user.exp >= Date.now()) { const currentUser = await this.queries.findUserById(user.id); if (currentUser && user.sessionVersion === currentUser.sessionVersion) { req.user = currentUser; _res.set('Cache-Control', 'no-store'); } }
      } catch { /* Treat invalid optional credentials as anonymous. */ }
      return next();
    };
    const anonymisedIp = (req) => crypto.createHash('sha256').update(`${this.authSecret}:${req.ip || 'unknown'}`).digest('hex').slice(0, 16);
    const writeLimitLog = (scope) => (req, { retryAfter, max, windowMs }) => console.warn('Venue/event write rate limit reached.', {
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
      const location = req.body?.location && typeof req.body.location === 'object' ? req.body.location : {};
      const placeId = req.body?.googlePlaceId || req.body?.customGooglePlaceId || location.googlePlaceId;
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
          if (!activity.timestamps.length || now - activity.timestamps.at(-1) >= 10 * 60 * 1000 || locationActivity.size > 10000) locationActivity.delete(entryKey);
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
    // Places requests go directly from the browser to Google, so this is
    // deliberately a sparse, privacy-preserving client activity signal. It
    // contains no search text, address, place ID, or API key; Cloud Monitoring
    // remains the authoritative source for Maps API request counts.
    app.post('/api/maps/places-activity', authenticate, placesActivityReportLimit, (req, res) => {
      const count = Number(req.body?.count);
      const windowMs = Number(req.body?.windowMs);
      if (!Number.isInteger(count) || count < 20 || count > 500 || !Number.isInteger(windowMs) || windowMs < 60 * 1000 || windowMs > 60 * 60 * 1000) return res.status(422).json({ error: 'Places activity report is invalid.' });
      console.warn('Unusually high client-reported Google Places activity.', {
        accountId: req.user.id,
        ipHash: anonymisedIp(req),
        route: req.originalUrl,
        action: 'places-autocomplete',
        count,
        windowMs,
      });
      return res.status(202).json({ accepted: true });
    });
    const reportEntityTypes = new Set(['image', 'event', 'group', 'review', 'profile', 'organization', 'venue', 'business_listing']);
    const reportReasonCodes = new Set(['illegal_content', 'harassment', 'sexual_content', 'child_safety', 'violence', 'hate', 'scam_fraud', 'impersonation', 'privacy', 'intellectual_property', 'spam', 'unsafe_event', 'misleading_business', 'misleading_listing', 'other']);
    const reportReference = () => `RPT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    app.post('/api/reports', optionalAuthenticate, async (req, res) => {
      const entityType = String(req.body.entityType || '').trim();
      const entityId = req.body.entityId == null ? null : String(req.body.entityId).trim() || null;
      const contentUrl = req.body.contentUrl == null ? null : String(req.body.contentUrl).trim() || null;
      const reasonCode = String(req.body.reasonCode || '').trim();
      const description = String(req.body.description || '').trim();
      const supportingDetails = req.body.supportingDetails == null ? null : String(req.body.supportingDetails).trim() || null;
      const reporterEmail = req.user?.email || (req.body.reporterEmail == null ? null : String(req.body.reporterEmail).trim().toLowerCase() || null);
      const allegedIllegal = req.body.allegedIllegal === true;
      const goodFaithDeclared = req.body.goodFaithDeclared === true;
      if (!reportEntityTypes.has(entityType) || (!entityId && !contentUrl) || !reportReasonCodes.has(reasonCode) || !description || description.length > 5000 || supportingDetails?.length > 10000 || !goodFaithDeclared) return res.status(422).json({ error: 'Provide a supported content type, content ID or URL, reason, explanation, and good-faith declaration.' });
      if (!reporterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) return res.status(422).json({ error: 'A valid contact email is required.' });
      if (contentUrl) { try { const url = new URL(contentUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL'); } catch { return res.status(422).json({ error: 'contentUrl must be a valid HTTP(S) URL.' }); } }
      try {
        await ensureTable();
        const reference = reportReference();
        const id = await this.queries.createContentReport({ reference, reporterUserId: req.user?.id || null, reporterEmail, entityType, entityId, contentUrl, reasonCode, description, supportingDetails, allegedIllegal });
        return res.status(201).json({ id, reference, status: 'submitted', message: 'Your report has been received.' });
      } catch (error) { console.error('Content report submission failed:', error.message); return res.status(500).json({ error: 'Unable to submit your report.' }); }
    });
    app.get(groupUploadRoute, optionalAuthenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.groupForCover(req.params.filename, req.user?.id ?? null, req.user?.role ?? null)) return res.status(404).json({ error: 'Group cover not found.' }); if (!await this.groupFtpService.streamGroupCover(req.params.filename, res)) return res.status(404).json({ error: 'Group cover not found.' }); } catch (error) { console.error('Group cover proxy failed:', error.message); if (!res.headersSent) return res.status(502).json({ error: 'Unable to load group cover.' }); } });
    app.get(articleUploadRoute, optionalAuthenticate, async (req, res) => { try { await ensureTable(); if (!this.articleFtpService || !await this.queries.articleImageVisible(req.params.filename, req.user?.id ?? null, req.user?.role ?? null) || !await this.articleFtpService.streamArticleImage(req.params.filename, res)) return res.status(404).json({ error: 'Article image not found.' }); } catch (error) { console.error('Article image proxy failed:', error.message); if (!res.headersSent) return res.status(502).json({ error: 'Unable to load article image.' }); } });
    const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' });
    // Any registered role can manage the events it owns.  Managers and admins
    // retain their broader access through the ownership checks in Queries.
    const requireManager = (req, res, next) => ['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Event-management access required.' });
    // Events, like groups, can be created by any verified account.  The
    // database ownership checks on the individual operations ensure a user
    // can only administer events they created (unless they are a manager/admin).
    const requireVerifiedUser = (req, res, next) => req.user.isEmailConfirmed ? next() : res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before creating an event.' });
    const requireRoleManager = (req, res, next) => ['manager', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Manager access required.' });
    // Venue access is governed by organization membership.  The legacy
    // venue_owner role remains accepted for existing accounts, but is not a
    // separate authentication system for new venue organizations.
    const requireVenueOwner = (req, res, next) => req.user.isEmailConfirmed ? next() : res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before managing venues.' });
    const supportedTimezone = (timezone) => timezone === 'UTC' || (typeof Intl.supportedValuesOf === 'function' && Intl.supportedValuesOf('timeZone').includes(timezone));
    const venueSlug = (value) => String(value || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const venueData = (body, existing = {}) => {
      const nullableNumber = (value, fallback = null) => value === '' || value === null ? null : (value === undefined ? fallback : Number(value));
      const list = (value, fallback = []) => value === undefined ? fallback : (Array.isArray(value) ? [...new Set(value.map(venueSlug).filter(Boolean))] : null);
      const structuredLocation = [body.city ?? existing.city, body.municipality ?? existing.municipality, body.region ?? existing.region, body.country ?? existing.country].map((value) => String(value || '').trim()).filter(Boolean).join(', ');
      const data = {
        organizationId: body.organizationId === undefined ? existing.organizationId ?? null : Number(body.organizationId),
        name: String(body.name ?? existing.name ?? '').trim(),
        slug: venueSlug(body.slug ?? existing.slug ?? body.name ?? existing.name),
        businessName: String(body.businessName ?? existing.businessName ?? '').trim() || null,
        shortDescription: String(body.shortDescription ?? existing.shortDescription ?? '').trim() || null,
        description: String(body.description ?? existing.description ?? '').trim() || null,
        // `location` is retained for compatibility with existing event and
        // booking responses. New clients supply the structured fields below.
        location: String(body.location ?? existing.location ?? structuredLocation).trim(),
        country: String(body.country ?? existing.country ?? '').trim() || null,
        city: String(body.city ?? existing.city ?? '').trim() || null,
        municipality: String(body.municipality ?? existing.municipality ?? '').trim() || null,
        region: String(body.region ?? existing.region ?? '').trim() || null,
        address: String(body.address ?? existing.address ?? '').trim() || null,
        addressLine1: String(body.addressLine1 ?? existing.addressLine1 ?? '').trim() || null,
        addressLine2: String(body.addressLine2 ?? existing.addressLine2 ?? '').trim() || null,
        postalCode: String(body.postalCode ?? existing.postalCode ?? '').trim() || null,
        countryCode: String(body.countryCode ?? existing.countryCode ?? '').trim().toUpperCase() || null,
        googlePlaceId: String(body.googlePlaceId ?? existing.googlePlaceId ?? '').trim() || null,
        formattedAddress: String(body.formattedAddress ?? existing.formattedAddress ?? '').trim() || null,
        latitude: nullableNumber(body.latitude, existing.latitude ?? null),
        longitude: nullableNumber(body.longitude, existing.longitude ?? null),
        locationVisibility: String(body.locationVisibility ?? existing.locationVisibility ?? 'exact'),
        timezone: String(body.timezone ?? existing.timezone ?? 'UTC'),
        venueType: venueSlug(body.venueType ?? existing.venueType),
        capacityMin: nullableNumber(body.capacityMin, existing.capacityMin ?? null), capacityMax: nullableNumber(body.capacityMax, existing.capacityMax ?? null),
        standingCapacity: nullableNumber(body.standingCapacity, existing.standingCapacity ?? null), seatedCapacity: nullableNumber(body.seatedCapacity, existing.seatedCapacity ?? null), diningCapacity: nullableNumber(body.diningCapacity, existing.diningCapacity ?? null), classroomCapacity: nullableNumber(body.classroomCapacity, existing.classroomCapacity ?? null), sizeSqm: nullableNumber(body.sizeSqm, existing.sizeSqm ?? null),
        priceFrom: nullableNumber(body.priceFrom, existing.priceFrom ?? null), priceUnit: String(body.priceUnit ?? existing.priceUnit ?? 'contact'), currency: String(body.currency ?? existing.currency ?? 'SEK').trim().toUpperCase(), pricingDescription: String(body.pricingDescription ?? existing.pricingDescription ?? '').trim() || null, minimumBookingHours: nullableNumber(body.minimumBookingHours, existing.minimumBookingHours ?? null),
        websiteUrl: String(body.websiteUrl ?? existing.websiteUrl ?? '').trim() || null, phone: String(body.phone ?? existing.phone ?? '').trim() || null, contactEmail: String(body.contactEmail ?? existing.contactEmail ?? '').trim().toLowerCase() || null,
        availabilityType: String(body.availabilityType ?? existing.availabilityType ?? 'calendar'), availability: body.availability === undefined ? (existing.availability ?? []) : body.availability, houseRulesText: String(body.houseRulesText ?? existing.houseRulesText ?? '').trim() || null,
        amenitySlugs: list(body.amenities, (existing.amenities || []).map((item) => item.slug)), suitableEventTypeSlugs: list(body.suitableEventTypes, (existing.suitableEventTypes || []).map((item) => item.slug)),
        isActive: body.isActive ?? (existing.isActive == null ? true : Boolean(existing.isActive)),
      };
      const errors = {};
      if (!existing.id && (!Number.isInteger(data.organizationId) || data.organizationId < 1)) errors.organizationId = 'A valid organizationId is required.';
      if (data.name.length < 2 || data.name.length > 160) errors.name = 'Venue name must be between 2 and 160 characters.';
      if (!data.slug || data.slug.length > 180) errors.slug = 'Venue slug must contain letters or numbers and be at most 180 characters.';
      if (data.location.length < 2 || data.location.length > 255) errors.location = 'A location of up to 255 characters is required.';
      if (data.businessName?.length > 160) errors.businessName = 'Business name must not exceed 160 characters.';
      if (data.shortDescription?.length > 400) errors.shortDescription = 'Short description must not exceed 400 characters.';
      if (data.latitude !== null && (!Number.isFinite(Number(data.latitude)) || Number(data.latitude) < -90 || Number(data.latitude) > 90)) errors.latitude = 'Latitude must be between -90 and 90.';
      if (data.longitude !== null && (!Number.isFinite(Number(data.longitude)) || Number(data.longitude) < -180 || Number(data.longitude) > 180)) errors.longitude = 'Longitude must be between -180 and 180.';
      if (data.countryCode && !/^[A-Z]{2}$/.test(data.countryCode)) errors.countryCode = 'Country code must be a two-letter ISO code.';
      if (data.googlePlaceId?.length > 255) errors.googlePlaceId = 'Google Place ID must not exceed 255 characters.';
      if (data.formattedAddress?.length > 500) errors.formattedAddress = 'Formatted address must not exceed 500 characters.';
      if (!['exact', 'approximate', 'private', 'private_until_booking'].includes(data.locationVisibility)) errors.locationVisibility = 'Invalid location visibility.';
      if (data.locationVisibility === 'private_until_booking') data.locationVisibility = 'private';
      if (!data.venueType) errors.venueType = 'A venue type is required.';
      for (const key of ['capacityMin', 'capacityMax', 'standingCapacity', 'seatedCapacity', 'diningCapacity', 'classroomCapacity']) if (data[key] !== null && (!Number.isInteger(data[key]) || data[key] < 1)) errors[key] = 'Capacity must be a positive whole number.';
      if (data.capacityMin !== null && data.capacityMax !== null && data.capacityMin > data.capacityMax) errors.capacityMax = 'Maximum capacity must be at least the minimum capacity.';
      if (data.sizeSqm !== null && (!Number.isFinite(data.sizeSqm) || data.sizeSqm <= 0)) errors.sizeSqm = 'Size must be positive.';
      if (data.priceFrom !== null && (!Number.isFinite(data.priceFrom) || data.priceFrom < 0)) errors.priceFrom = 'Price must be zero or positive.';
      if (!['hour', 'half_day', 'day', 'evening', 'person', 'event', 'contact'].includes(data.priceUnit)) errors.priceUnit = 'Invalid price unit.';
      if (!/^[A-Z]{3}$/.test(data.currency)) errors.currency = 'Currency must be a three-letter ISO code.';
      if (data.minimumBookingHours !== null && (!Number.isFinite(data.minimumBookingHours) || data.minimumBookingHours <= 0)) errors.minimumBookingHours = 'Minimum booking hours must be positive.';
      if (data.websiteUrl && !/^https:\/\//i.test(data.websiteUrl)) errors.websiteUrl = 'Website URL must use HTTPS.';
      if (data.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail)) errors.contactEmail = 'A valid contact email is required.';
      if (!['contact', 'calendar', 'always_open'].includes(data.availabilityType)) errors.availabilityType = 'Invalid availability type.';
      const schedule = venueAvailability(data.availability);
      if (schedule.error) errors.availability = schedule.error;
      else if (schedule.errors) Object.assign(errors, schedule.errors);
      else data.availability = schedule.slots;
      if (!existing.id && !data.availability?.length) errors.availability = 'Add at least one weekly availability period.';
      if (!Array.isArray(data.amenitySlugs)) errors.amenities = 'amenities must be an array of amenity slugs.';
      if (!Array.isArray(data.suitableEventTypeSlugs)) errors.suitableEventTypes = 'suitableEventTypes must be an array of event-type slugs.';
      if (!supportedTimezone(data.timezone)) errors.timezone = 'Select a timezone returned by GET /api/timezones.';
      if (typeof data.isActive !== 'boolean') errors.isActive = 'isActive must be a boolean.';
      return { data, errors };
    };
    const venueAvailability = (slots) => {
      if (!Array.isArray(slots)) return { error: 'availability must be an array of weekly time slots.' };
      if (slots.length > 56) return { error: 'availability can contain at most 56 weekly time slots.' };
      const errors = {};
      const normalized = slots.map((slot, index) => {
        const weekday = Number(slot?.weekday);
        const startTime = String(slot?.startTime || '');
        const endTime = String(slot?.endTime || '');
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) errors[`availability.${index}.weekday`] = 'weekday must be an integer from 0 (Sunday) to 6 (Saturday).';
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) errors[`availability.${index}.startTime`] = 'startTime must use HH:mm.';
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) errors[`availability.${index}.endTime`] = 'endTime must use HH:mm.';
        if (startTime && endTime && startTime >= endTime) errors[`availability.${index}.endTime`] = 'endTime must be after startTime; overnight slots are not supported.';
        return { weekday, startTime, endTime };
      });
      for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
        const days = normalized.filter((slot) => slot.weekday === weekday).sort((a, b) => a.startTime.localeCompare(b.startTime));
        for (let index = 1; index < days.length; index += 1) if (days[index].startTime < days[index - 1].endTime) errors.availability = 'Availability slots on the same day must not overlap.';
      }
      return Object.keys(errors).length ? { errors } : { slots: normalized };
    };
    const requestedAvailabilityDate = (value) => {
      const date = String(value || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return null;
      const today = new Date();
      const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      const requestedUtc = Date.parse(`${date}T12:00:00Z`);
      const daysAhead = Math.floor((requestedUtc - todayUtc) / (24 * 60 * 60 * 1000));
      return daysAhead >= 0 && daysAhead <= 366 ? date : null;
    };
    const asUtcDate = (value) => {
      if (value instanceof Date) return value;
      const text = String(value).replace(' ', 'T');
      return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}Z`);
    };
    const eventFitsVenueAvailability = (event, venue) => {
      if (!event.startsAt || !event.endsAt) return { error: 'The event must have both a start and end time before it can be booked.' };
      const start = asUtcDate(event.startsAt);
      const end = asUtcDate(event.endsAt);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return { error: 'The event has an invalid booking time.' };
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: venue.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const local = (value) => Object.fromEntries(formatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      const starts = local(start);
      const ends = local(end);
      const dayNumbers = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      if (starts.weekday !== ends.weekday) return { error: 'The event must start and end on the same local day at this venue.' };
      const startTime = `${starts.hour}:${starts.minute}`;
      const endTime = `${ends.hour}:${ends.minute}`;
      const available = venue.availability.some((slot) => slot.weekday === dayNumbers[starts.weekday] && slot.startTime <= startTime && slot.endTime >= endTime);
      return available ? {} : { error: 'The venue is not available for the full event time.' };
    };
    // Collection endpoints always return an array. An empty collection is a
    // successful lookup, not a missing resource.
    const sendVenueList = (res, venues) => res.json(venues);
    app.get('/api/maps/config', (_req, res) => {
      const maps = this.config.runtime.maps || {};
      // Browser keys are designed to be visible to clients and must be
      // referrer/API-restricted in Google Cloud. The server key is never sent.
      res.set({ 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400', 'X-Robots-Tag': 'noindex, noarchive' });
      return res.json({ enabled: Boolean(maps.enabled && maps.browserApiKey), browserApiKey: maps.enabled ? maps.browserApiKey || null : null, requiresConsent: Boolean(maps.requiresConsent) });
    });
    const parseEventRecurrence = (body) => {
      if (body.recurrence == null || body.recurrence === false) return { recurrence: { frequency: 'none', interval: 1, count: 1 } };
      if (typeof body.recurrence !== 'object' || Array.isArray(body.recurrence)) return { error: 'recurrence must be an object.' };
      const frequency = String(body.recurrence.frequency || 'none').toLowerCase();
      if (frequency === 'none') return { recurrence: { frequency: 'none', interval: 1, count: 1 } };
      const interval = Number(body.recurrence.interval ?? 1);
      const count = Number(body.recurrence.count);
      if (!['daily', 'weekly', 'monthly'].includes(frequency)) return { error: 'recurrence.frequency must be daily, weekly, monthly, or none.' };
      if (!Number.isInteger(interval) || interval < 1 || interval > 52) return { error: 'recurrence.interval must be an integer between 1 and 52.' };
      if (!Number.isInteger(count) || count < 2 || count > 100) return { error: 'recurrence.count must be an integer between 2 and 100.' };
      return { recurrence: { frequency, interval, count } };
    };
    const validateRichEvent = async (body, { publishing = false } = {}) => {
      const title = String(body.title || '').trim();
      const startsAt = body.startsAtUtc || body.startsAt;
      const endsAt = body.endsAtUtc || body.endsAt || null;
      const errors = {};
      const recurrenceResult = parseEventRecurrence(body);
      if (recurrenceResult.error) errors.recurrence = recurrenceResult.error;
      if (publishing || title) { if (title.length < 5 || title.length > 100) errors.title = 'Title must be between 5 and 100 characters.'; }
      if (publishing || body.categoryId) { if (!Number.isInteger(Number(body.categoryId))) errors.categoryId = 'A valid category is required.'; }
      if (publishing || body.typeId) { if (!Number.isInteger(Number(body.typeId))) errors.typeId = 'A valid event type is required.'; }
      if (publishing || startsAt) { if (!startsAt || Number.isNaN(Date.parse(startsAt))) errors.startsAt = 'A valid start date and time is required.'; }
      if (recurrenceResult.recurrence?.frequency !== 'none' && (!startsAt || Number.isNaN(Date.parse(startsAt)))) errors.recurrence = 'Recurring events require a valid start date and time.';
      if (endsAt && Number.isNaN(Date.parse(endsAt))) errors.endsAt = 'End date and time must be valid.';
      if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) errors.endsAt = 'End must be after start.';
      if (body.capacity !== null && body.capacity !== '' && body.capacity !== undefined && (!Number.isInteger(Number(body.capacity)) || Number(body.capacity) < 1)) errors.capacity = 'Capacity must be a positive integer or null.';
      const pricingType = body.pricingType || (Number(body.fee || 0) > 0 ? 'paid' : 'free');
      if (!['free', 'paid'].includes(pricingType)) errors.pricingType = 'Pricing type must be free or paid.';
      if (pricingType === 'paid' && Number(body.fee || 0) <= 0) errors.fee = 'Paid events require a positive price.';
      if (pricingType === 'free' && Number(body.fee || 0) !== 0) errors.fee = 'Free events cannot have a price.';
      if (!['Public', 'Private', 'Members', 'Unlisted'].includes(body.visibility || 'Public')) errors.visibility = 'Invalid visibility.';
      const locationType = ({ physical: 'custom', tba: 'custom' })[body.locationType] || body.locationType || 'custom';
      const nestedLocation = body.location && typeof body.location === 'object' && !Array.isArray(body.location) ? body.location : {};
      const locationField = (name, legacy = null) => body[`custom${name[0].toUpperCase()}${name.slice(1)}`] ?? nestedLocation[name] ?? body[name] ?? legacy;
      const customLatitude = locationField('latitude', body.latitude);
      const customLongitude = locationField('longitude', body.longitude);
      const customFormattedAddress = locationField('formattedAddress', typeof body.location === 'string' ? body.location : null);
      if (!['venue', 'custom', 'online'].includes(locationType)) errors.locationType = 'Location type must be venue, custom, or online.';
      if (locationType === 'venue') {
        const venueId = Number(body.venueId ?? body.venue?.id);
        if (!Number.isInteger(venueId) || venueId < 1) errors.venueId = 'A valid venue is required.';
        else if (!await this.queries.eventLocationVenue(venueId)) errors.venueId = 'The selected venue is unavailable.';
      }
      if (locationType === 'custom') {
        if (!customFormattedAddress || String(customFormattedAddress).trim().length > 500) errors.formattedAddress = 'A formatted address of up to 500 characters is required.';
        if (!Number.isFinite(Number(customLatitude)) || Number(customLatitude) < -90 || Number(customLatitude) > 90) errors.latitude = 'Latitude must be between -90 and 90.';
        if (!Number.isFinite(Number(customLongitude)) || Number(customLongitude) < -180 || Number(customLongitude) > 180) errors.longitude = 'Longitude must be between -180 and 180.';
        if (publishing && !locationField('country')) errors.country = 'A country is required before publication.';
      }
      if (locationType === 'online') {
        const onlineUrl = body.onlineUrl == null ? '' : String(body.onlineUrl).trim();
        if (onlineUrl && (!/^https:\/\//i.test(onlineUrl) || onlineUrl.length > 1024)) errors.onlineUrl = 'Online URL must be an HTTPS URL of up to 1,024 characters.';
      }
      for (const [field, max] of Object.entries({ addressLine1: 255, addressLine2: 255, postalCode: 32, locality: 120, municipality: 120, region: 120, country: 120, countryCode: 2, googlePlaceId: 255 })) {
        const value = locationField(field);
        if (value != null && String(value).trim().length > max) errors[field] = `Must not exceed ${max} characters.`;
      }
      const countryCode = locationField('countryCode');
      if (countryCode && !/^[A-Za-z]{2}$/.test(String(countryCode).trim())) errors.countryCode = 'Country code must be a two-letter ISO code.';
      if (publishing && !body.description?.trim()) errors.description = 'Description is required before publication.';
      const timezone = body.timezone || 'UTC';
      if (typeof Intl.supportedValuesOf !== 'function' || (timezone !== 'UTC' && !Intl.supportedValuesOf('timeZone').includes(timezone))) errors.timezone = 'Select a timezone returned by GET /api/timezones.';
      return { errors, title, startsAt, endsAt, pricingType, timezone, locationType, recurrence: recurrenceResult.recurrence || { frequency: 'none', interval: 1, count: 1 } };
    };
    const richEventData = (body, userId, validation) => {
      const nestedLocation = body.location && typeof body.location === 'object' && !Array.isArray(body.location) ? body.location : {};
      const locationField = (name, legacy = null) => body[`custom${name[0].toUpperCase()}${name.slice(1)}`] ?? nestedLocation[name] ?? body[name] ?? legacy;
      const text = (value, max) => value == null ? null : String(value).trim().slice(0, max) || null;
      const isCustom = validation.locationType === 'custom';
      const custom = isCustom ? {
        addressLine1: text(locationField('addressLine1', body.address), 255), addressLine2: text(locationField('addressLine2'), 255), postalCode: text(locationField('postalCode'), 32),
        locality: text(locationField('locality', body.city), 120), municipality: text(locationField('municipality'), 120), region: text(locationField('region'), 120), country: text(locationField('country', body.country), 120), countryCode: text(locationField('countryCode'), 2)?.toUpperCase() || null,
        latitude: Number(locationField('latitude', body.latitude)), longitude: Number(locationField('longitude', body.longitude)), googlePlaceId: text(locationField('googlePlaceId'), 255), formattedAddress: text(locationField('formattedAddress', typeof body.location === 'string' ? body.location : null), 500),
      } : {};
      return { managerId: userId, title: validation.title, shortDescription: body.shortDescription?.trim() || null, description: body.description?.trim() || null, coverImage: body.coverImage || null, categoryId: body.categoryId ? Number(body.categoryId) : null, typeId: body.typeId ? Number(body.typeId) : null, country: custom.country || null, city: custom.locality || null, location: custom.formattedAddress || null, address: custom.addressLine1 || null, latitude: custom.latitude ?? null, longitude: custom.longitude ?? null, locationType: validation.locationType, locationVisibility: body.locationVisibility || 'public', startsAt: validation.startsAt ? new Date(validation.startsAt).toISOString().slice(0, 19).replace('T', ' ') : null, endsAt: validation.endsAt ? new Date(validation.endsAt).toISOString().slice(0, 19).replace('T', ' ') : null, timezone: validation.timezone, capacity: body.capacity === '' || body.capacity === undefined ? null : body.capacity, minimumAttendees: body.minimumAttendees || null, registrationDeadline: body.registrationDeadline || null, minimumAge: body.minimumAge || null, languageCode: body.languageCode || null, whatToBring: body.whatToBring || null, meetingInstructions: body.meetingInstructions || null, cancellationPolicy: body.cancellationPolicy || null, pricingType: validation.pricingType, fee: validation.pricingType === 'free' ? 0 : Number(body.fee || 0), currency: body.currency || 'SEK', registrationType: body.registrationType || 'yaroko', externalRegistrationUrl: body.externalRegistrationUrl || null, visibility: body.visibility || 'Public', groupId: body.groupId ? Number(body.groupId) : null, recurrence: validation.recurrence, venueId: validation.locationType === 'venue' ? Number(body.venueId ?? body.venue?.id) : null, customAddressLine1: custom.addressLine1 || null, customAddressLine2: custom.addressLine2 || null, customPostalCode: custom.postalCode || null, customLocality: custom.locality || null, customMunicipality: custom.municipality || null, customRegion: custom.region || null, customCountry: custom.country || null, customCountryCode: custom.countryCode || null, customLatitude: custom.latitude ?? null, customLongitude: custom.longitude ?? null, customGooglePlaceId: custom.googlePlaceId || null, customFormattedAddress: custom.formattedAddress || null, onlineUrl: validation.locationType === 'online' ? text(body.onlineUrl, 1024) : null, onlinePlatform: validation.locationType === 'online' ? text(body.onlinePlatform, 120) : null };
    };
    const notifyGroupEventMembers = async (eventId) => { const members = await this.queries.pendingGroupEventNotifications(eventId); await Promise.all(members.map(async (member) => { if (!await this.queries.claimGroupEventNotification(eventId, member.userId)) return; try { await this.emailService.sendGroupEventNotification(member.email, member.name, { id: member.groupId, name: member.groupName }, member); } catch (emailError) { try { await this.queries.releaseGroupEventNotification(eventId, member.userId); } catch (releaseError) { console.error(`Unable to release group event notification for ${member.email}:`, releaseError.message); } console.error(`Group event notification failed for ${member.email}:`, emailError.message); } })); };
    const createRichDraft = async (req, res, groupId = req.body.groupId) => { try { await ensureTable(); if (groupId && (!Number.isInteger(Number(groupId)) || !await this.queries.canManageGroup(Number(groupId), req.user.id, req.user.role))) return res.status(403).json({ error: 'You can only post events in groups you manage.' }); const validation = await validateRichEvent(req.body); if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event draft is invalid.', fields: validation.errors }); const series = await this.queries.createRichEventSeries(richEventData({ ...req.body, groupId }, req.user.id, validation)); const event = await this.queries.richEvent(series.eventIds[0], req.user.id, req.user.role); return res.status(201).json({ ...event, seriesId: series.seriesId, occurrenceIds: series.eventIds }); } catch (error) { console.error('Rich event creation failed:', error); return res.status(500).json({ error: 'Unable to create event draft.' }); } };
    app.post('/api/events/drafts', authenticate, requireVerifiedUser, ...creationGuards, (req, res) => createRichDraft(req, res));
    app.post('/api/groups/:id/events/drafts', authenticate, ...creationGuards, (req, res) => createRichDraft(req, res, req.params.id));
    app.post('/api/events/:id/cover', authenticate, parseEventCover, async (req, res) => { if (!req.file) return res.status(400).json({ error: 'A JPEG, PNG, or WebP cover image is required.' }); try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user.id, req.user.role); if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' }); const coverImage = await this.eventFtpService.uploadEventCover(req.params.id, req.file); if (!await this.queries.setEventCover(req.params.id, req.user.id, req.user.role, coverImage)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); return res.json({ coverImage }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(400).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Event image storage is not configured.' }); console.error('Event cover upload failed:', error); return res.status(502).json({ error: 'Unable to upload event cover.' }); } });
    app.patch('/api/events/:id', authenticate, ...updateGuards, async (req, res) => { try { await ensureTable(); const validation = await validateRichEvent(req.body); if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event draft is invalid.', fields: validation.errors }); if (!await this.queries.updateRichEvent(req.params.id, req.user.id, req.user.role, richEventData(req.body, req.user.id, validation))) return res.status(404).json({ error: 'Event not found or not managed by you.' }); return res.json(await this.queries.richEvent(req.params.id, req.user.id, req.user.role)); } catch (error) { console.error('Rich event update failed:', error.message); return res.status(500).json({ error: 'Unable to update event.' }); } });
    app.post('/api/events/:id/publish', authenticate, async (req, res) => { try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user.id, req.user.role); if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' }); if (!this.config.runtime.paidEventsEnabled && Number(event.fee) > 0) return res.status(422).json({ error: 'Paid events are disabled during the pre-company beta.' }); const validation = await validateRichEvent(event, { publishing: true }); if (!event.coverImage) validation.errors.coverImage = 'A cover image is required before publication.'; if (!event.categoryId || !event.typeId) validation.errors.taxonomy = 'Category and event type are required before publication.'; if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event cannot be published.', fields: validation.errors }); await this.queries.publishRichEvent(req.params.id, req.user.id, req.user.role); if (event.groupId && event.status !== 'Published') await notifyGroupEventMembers(req.params.id); return res.json(await this.queries.richEvent(req.params.id, req.user.id, req.user.role)); } catch (error) { console.error('Rich event publication failed:', error.message); return res.status(500).json({ error: 'Unable to publish event.' }); } });
    app.post('/api/events', authenticate, requireVerifiedUser, ...creationGuards, (req, res, next) => { const fee = req.body.fee ?? 0; const startsAtUtc = req.body.startsAtUtc ?? req.body.startsAt; const endsAtUtc = req.body.endsAtUtc ?? req.body.endsAt ?? null; if (!startsAtUtc || Number.isNaN(Date.parse(startsAtUtc)) || (endsAtUtc && Number.isNaN(Date.parse(endsAtUtc)))) return res.status(400).json({ error: 'Valid startsAtUtc and endsAtUtc timestamps are required.' }); if (!Number.isFinite(Number(fee)) || Number(fee) < 0) return res.status(400).json({ error: 'Fee must be a non-negative number.' }); if (!this.config.runtime.paidEventsEnabled && Number(fee) > 0) return res.status(422).json({ error: 'Paid events are disabled during the pre-company beta.' }); req.body.startsAt = new Date(startsAtUtc).toISOString().slice(0, 19).replace('T', ' '); req.body.endsAt = endsAtUtc ? new Date(endsAtUtc).toISOString().slice(0, 19).replace('T', ' ') : null; req.body.fee = Number(fee).toFixed(2); next(); });

    app.get('/api/events', optionalAuthenticate, async (req, res) => { const categorySlug = req.query.category == null ? null : String(req.query.category).trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); if (req.query.category != null && !categorySlug) return res.status(422).json({ error: 'category must be a valid category slug.' }); try { await ensureTable(); return res.json(await this.queries.eventsForViewer(req.user?.id ?? null, req.user?.role ?? null, { categorySlug })); } catch (error) { console.error('Event lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load events.' }); } });
    app.post('/api/events', authenticate, async (req, res) => { const { title, description = null, location = null, startsAt, endsAt = null, capacity = null, visibility = 'Public', fee = 0 } = req.body; if (!title?.trim() || !startsAt) return res.status(400).json({ error: 'Title and start date are required.' }); if (!['Public', 'Private'].includes(visibility)) return res.status(400).json({ error: 'Visibility must be Public or Private.' }); try { await ensureTable(); const id = await this.queries.createVisibleEvent({ managerId: req.user.id, title: title.trim(), description, location, startsAt, endsAt, capacity: capacity === null ? null : Number(capacity), fee, visibility }); return res.status(201).json({ id, status: 'Draft', visibility, fee, role: req.user.role }); } catch (error) { return res.status(500).json({ error: 'Unable to create event.' }); } });
    app.get('/api/venue-types', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.venueTypes()); } catch (error) { console.error('Venue type lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue types.' }); } });
    app.get('/api/venue-event-types', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.venueEventTypes()); } catch (error) { console.error('Venue event-type lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue event types.' }); } });
    app.get('/api/venue-amenities', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.venueAmenities()); } catch (error) { console.error('Venue amenity lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue amenities.' }); } });
    app.post('/api/organizations', authenticate, requireVerifiedUser, async (req, res) => {
      const name = String(req.body.name || '').trim(); const slug = venueSlug(req.body.slug || name); const websiteUrl = String(req.body.websiteUrl || '').trim() || null; const contactEmail = String(req.body.contactEmail || '').trim().toLowerCase() || null;
      if (name.length < 2 || name.length > 160 || !slug || slug.length > 180 || (websiteUrl && !/^https:\/\//i.test(websiteUrl)) || (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))) return res.status(422).json({ error: 'Organization is invalid.' });
      try { await ensureTable(); const id = await this.queries.createOrganization(req.user.id, { name, slug, description: String(req.body.description || '').trim() || null, websiteUrl, phone: String(req.body.phone || '').trim() || null, contactEmail }); return res.status(201).json(await this.queries.organization(id, req.user.id, req.user.role)); }
      catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That organization slug is already in use.' }); console.error('Organization creation failed:', error.message); return res.status(500).json({ error: 'Unable to create organization.' }); }
    });
    app.get('/api/organizations/:id', optionalAuthenticate, async (req, res) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid organization id is required.' }); try { await ensureTable(); const organization = await this.queries.organization(id, req.user?.id ?? null, req.user?.role ?? null); return organization ? res.json(organization) : res.status(404).json({ error: 'Organization not found.' }); } catch (error) { console.error('Organization lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load organization.' }); } });
    app.put('/api/organizations/:id/members/:userId', authenticate, requireVerifiedUser, async (req, res) => { const organizationId = Number(req.params.id); const userId = Number(req.params.userId); const role = String(req.body.role || ''); if (!Number.isInteger(organizationId) || !Number.isInteger(userId) || !['owner', 'admin', 'manager', 'staff'].includes(role)) return res.status(422).json({ error: 'A valid organization member and role are required.' }); try { await ensureTable(); if (!await this.queries.setOrganizationMember(organizationId, req.user.id, req.user.role, userId, role)) return res.status(403).json({ error: 'Organization owner or admin access is required.' }); return res.json({ organizationId, userId, role }); } catch (error) { console.error('Organization member update failed:', error.message); return res.status(500).json({ error: 'Unable to update organization member.' }); } });
    app.get('/api/venues', optionalAuthenticate, async (req, res) => {
      const number = (value, name) => value == null || value === '' ? null : (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : name);
      const minCapacity = number(req.query.minCapacity, 'minCapacity'); const maxCapacity = number(req.query.maxCapacity, 'maxCapacity'); const maxPrice = number(req.query.maxPrice, 'maxPrice');
      if ([minCapacity, maxCapacity, maxPrice].some((value) => typeof value === 'string') || (minCapacity !== null && !Number.isInteger(minCapacity)) || (maxCapacity !== null && !Number.isInteger(maxCapacity))) return res.status(422).json({ error: 'Capacity filters must be whole non-negative numbers and maxPrice must be non-negative.' });
      const amenities = req.query.amenity == null ? [] : String(req.query.amenity).split(',').map(venueSlug).filter(Boolean);
      try { await ensureTable(); return sendVenueList(res, await this.queries.venuesForViewer(req.user?.id ?? null, req.user?.role ?? null, { city: req.query.city ? String(req.query.city).trim() : null, venueType: req.query.venueType ? venueSlug(req.query.venueType) : null, eventType: req.query.eventType ? venueSlug(req.query.eventType) : null, amenities, minCapacity, maxCapacity, maxPrice, verifiedOnly: req.query.verified === 'true' })); }
      catch (error) { console.error('Venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venues.' }); }
    });
    app.get('/api/venues/mine', authenticate, requireVenueOwner, async (req, res) => {
      try { await ensureTable(); return sendVenueList(res, await this.queries.venuesForViewer(req.user.id, req.user.role, { managedOnly: true })); }
      catch (error) { console.error('Managed venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load your venues.' }); }
    });
    app.get('/api/manager/venues', authenticate, requireRoleManager, async (req, res) => {
      try { await ensureTable(); return sendVenueList(res, await this.queries.venuesForViewer(req.user.id, req.user.role, { managedOnly: true })); }
      catch (error) { console.error('Manager venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venues.' }); }
    });
    app.get('/api/admin/venues', authenticate, requireAdmin, async (req, res) => {
      try { await ensureTable(); return sendVenueList(res, await this.queries.venuesForViewer(req.user.id, req.user.role, { managedOnly: true })); }
      catch (error) { console.error('Admin venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venues.' }); }
    });
    app.patch('/api/admin/venues/:id/moderation', authenticate, requireAdmin, async (req, res) => {
      const venueId = Number(req.params.id); const moderationStatus = String(req.body.moderationStatus || ''); const verificationStatus = req.body.verificationStatus == null ? null : String(req.body.verificationStatus); const isActive = req.body.isActive == null ? null : req.body.isActive;
      if (!Number.isInteger(venueId) || venueId < 1 || !['draft', 'pending', 'approved', 'rejected', 'removed'].includes(moderationStatus) || (verificationStatus !== null && !['unverified', 'pending', 'verified', 'rejected'].includes(verificationStatus)) || (isActive !== null && typeof isActive !== 'boolean')) return res.status(422).json({ error: 'Venue moderation update is invalid.' });
      try { await ensureTable(); if (!await this.queries.moderateVenue(venueId, moderationStatus, verificationStatus, isActive)) return res.status(404).json({ error: 'Venue not found.' }); return res.json(await this.queries.venue(venueId, req.user.id, req.user.role)); }
      catch (error) { console.error('Venue moderation update failed:', error.message); return res.status(500).json({ error: 'Unable to update venue moderation.' }); }
    });
    app.post('/api/venues', authenticate, requireVerifiedUser, requireVenueOwner, ...creationGuards, async (req, res) => {
      const { data, errors } = venueData(req.body);
      if (Object.keys(errors).length) return res.status(422).json({ error: 'Venue is invalid.', fields: errors });
      try { await ensureTable(); const membership = await this.queries.organizationMember(data.organizationId, req.user.id); if (!['owner', 'admin', 'manager'].includes(membership?.role) && !['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Organization manager access is required to create a venue.' }); const id = await this.queries.createVenue(req.user.id, data); return res.status(201).json(await this.queries.venue(id, req.user.id, req.user.role)); }
      catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That venue slug is already in use.' }); console.error('Venue creation failed:', error.message); return res.status(500).json({ error: 'Unable to create venue.' }); }
    });
    app.post('/api/venues/:id/media', authenticate, requireVenueOwner, parseVenueImage, async (req, res) => {
      const venueId = Number(req.params.id); const altText = String(req.body.altText || '').trim(); const caption = req.body.caption == null ? null : String(req.body.caption).trim() || null; const isCover = req.body.kind === 'cover';
      if (!Number.isInteger(venueId) || venueId < 1 || !req.file || altText.length < 3 || altText.length > 200 || caption?.length > 500 || !['cover', 'gallery'].includes(req.body.kind)) return res.status(422).json({ error: 'Venue image is invalid.' });
      try { await ensureTable(); if (!await this.queries.canManageVenue(venueId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Venue not found or not managed by you.' }); const filename = await this.venueFtpService.uploadVenueImage(venueId, req.file); const id = await this.queries.addVenueMedia(venueId, filename, altText, caption, isCover); return res.status(201).json({ id, filename, url: `${this.venueFtpService.publicPath()}/${encodeURIComponent(filename)}`, altText, caption, isCover }); }
      catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Venue image storage is not configured.' }); console.error('Venue image upload failed:', error.message); return res.status(502).json({ error: 'Unable to upload venue image.' }); }
    });
    app.get('/api/venues/:id/bookings', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); const bookings = await this.queries.venueBookings(venueId, req.user.id, req.user.role); if (!bookings.length && !await this.queries.venue(venueId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Venue not found or not managed by you.' }); return res.json(bookings); }
      catch (error) { console.error('Venue bookings lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue bookings.' }); }
    });
    // Event editors request one date at a time. This intentionally never
    // expands a recurring schedule into months or years of future slots.
    app.get('/api/venues/:id/availability', authenticate, async (req, res) => {
      const venueId = Number(req.params.id);
      const date = requestedAvailabilityDate(req.query.date);
      if (!Number.isInteger(venueId) || venueId < 1 || !date) return res.status(422).json({ error: 'Provide a valid availability date between today and one year from today.' });
      try {
        await ensureTable();
        const availability = await this.queries.venueAvailabilityForDate(venueId, date);
        return availability ? res.json(availability) : res.status(404).json({ error: 'Venue not found or unavailable.' });
      } catch (error) { console.error('Venue availability lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue availability.' }); }
    });
    app.put('/api/venues/:id/availability', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id);
      const validated = venueAvailability(req.body.availability);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      if (validated.error) return res.status(422).json({ error: validated.error });
      if (validated.errors) return res.status(422).json({ error: 'Availability is invalid.', fields: validated.errors });
      try { await ensureTable(); if (!await this.queries.replaceVenueAvailability(venueId, req.user.id, req.user.role, validated.slots)) return res.status(404).json({ error: 'Venue not found or not managed by you.' }); return res.json({ venueId, availability: await this.queries.venueAvailability(venueId) }); }
      catch (error) { console.error('Venue availability update failed:', error.message); return res.status(500).json({ error: 'Unable to update venue availability.' }); }
    });
    app.patch('/api/venues/:id', authenticate, requireVenueOwner, ...updateGuards, async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        const existing = await this.queries.venue(venueId, req.user.id, req.user.role);
        if (!existing) return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        const { data, errors } = venueData(req.body, existing);
        if (Object.keys(errors).length) return res.status(422).json({ error: 'Venue is invalid.', fields: errors });
        if (!await this.queries.updateVenue(venueId, req.user.id, req.user.role, data)) return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        return res.json(await this.queries.venue(venueId, req.user.id, req.user.role));
      } catch (error) { console.error('Venue update failed:', error.message); return res.status(500).json({ error: 'Unable to update venue.' }); }
    });
    app.delete('/api/venues/:id', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); if (!await this.queries.deleteVenue(venueId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Venue not found or not managed by you.' }); return res.status(204).send(); }
      catch (error) { console.error('Venue deletion failed:', error.message); return res.status(500).json({ error: 'Unable to delete venue.' }); }
    });
    app.post('/api/venues/:id/inquiries', authenticate, requireVerifiedUser, async (req, res) => {
      const venueId = Number(req.params.id); const body = req.body;
      const data = { eventId: body.eventId == null || body.eventId === '' ? null : Number(body.eventId), eventName: String(body.eventName || '').trim(), eventType: body.eventType == null ? null : venueSlug(body.eventType), requestedDate: body.requestedDate || null, startTime: body.startTime || null, endTime: body.endTime || null, expectedGuests: body.expectedGuests == null || body.expectedGuests === '' ? null : Number(body.expectedGuests), budget: body.budget == null || body.budget === '' ? null : Number(body.budget), message: String(body.message || '').trim() };
      if (!Number.isInteger(venueId) || venueId < 1 || data.eventName.length < 2 || data.eventName.length > 200 || !data.message || data.message.length > 5000 || (data.eventId !== null && (!Number.isInteger(data.eventId) || data.eventId < 1)) || (data.expectedGuests !== null && (!Number.isInteger(data.expectedGuests) || data.expectedGuests < 1)) || (data.budget !== null && (!Number.isFinite(data.budget) || data.budget < 0)) || (data.requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.requestedDate)) || (data.startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.startTime)) || (data.endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.endTime)) || (data.startTime && data.endTime && data.endTime <= data.startTime)) return res.status(422).json({ error: 'Venue inquiry is invalid.' });
      try { await ensureTable(); const venue = await this.queries.venue(venueId); if (!venue) return res.status(404).json({ error: 'Venue not found.' }); if (data.eventId && !await this.queries.eventForVenueInquiry(data.eventId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); const id = await this.queries.createVenueInquiry(venueId, req.user.id, data); return res.status(201).json({ id, venueId, status: 'new' }); }
      catch (error) { console.error('Venue inquiry creation failed:', error.message); return res.status(500).json({ error: 'Unable to send venue request.' }); }
    });
    app.get('/api/venues/:id/inquiries', authenticate, requireVenueOwner, async (req, res) => { const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' }); try { await ensureTable(); const inquiries = await this.queries.venueInquiries(venueId, req.user.id, req.user.role); return inquiries === null ? res.status(403).json({ error: 'Venue manager access is required.' }) : res.json(inquiries); } catch (error) { console.error('Venue inquiry lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue requests.' }); } });
    app.patch('/api/venues/:venueId/inquiries/:id', authenticate, requireVenueOwner, async (req, res) => { const venueId = Number(req.params.venueId); const inquiryId = Number(req.params.id); const status = String(req.body.status || ''); if (!Number.isInteger(venueId) || !Number.isInteger(inquiryId) || !['new', 'viewed', 'responded', 'accepted', 'declined', 'cancelled'].includes(status)) return res.status(422).json({ error: 'A valid inquiry id and status are required.' }); try { await ensureTable(); if (!await this.queries.updateVenueInquiryStatus(inquiryId, venueId, req.user.id, req.user.role, status)) return res.status(404).json({ error: 'Venue request not found or not managed by you.' }); return res.json({ id: inquiryId, venueId, status }); } catch (error) { console.error('Venue inquiry update failed:', error.message); return res.status(500).json({ error: 'Unable to update venue request.' }); } });
    app.post('/api/venues/:id/save', authenticate, async (req, res) => { const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' }); try { await ensureTable(); const saved = await this.queries.saveVenue(venueId, req.user.id); return saved ? res.status(201).json({ venueId, saved: true }) : res.status(404).json({ error: 'Venue not found or unavailable.' }); } catch (error) { console.error('Venue save failed:', error.message); return res.status(500).json({ error: 'Unable to save venue.' }); } });
    app.delete('/api/venues/:id/save', authenticate, async (req, res) => { const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' }); try { await ensureTable(); await this.queries.unsaveVenue(venueId, req.user.id); return res.status(204).send(); } catch (error) { console.error('Venue unsave failed:', error.message); return res.status(500).json({ error: 'Unable to remove saved venue.' }); } });
    app.post('/api/venues/:id/reports', optionalAuthenticate, async (req, res) => {
      const venueId = Number(req.params.id); const reason = String(req.body.reason || '').trim(); const description = String(req.body.description || '').trim(); const reporterEmail = req.user?.email || (req.body.reporterEmail == null ? null : String(req.body.reporterEmail).trim().toLowerCase() || null);
      if (!Number.isInteger(venueId) || venueId < 1 || !['fake_listing', 'incorrect_information', 'scam_fraud', 'illegal_activity', 'unsafe_venue', 'inappropriate_content', 'privacy', 'intellectual_property', 'other'].includes(reason) || !description || description.length > 5000 || !reporterEmail) return res.status(422).json({ error: 'A valid report reason, explanation, and email are required.' });
      try { await ensureTable(); if (!await this.queries.venue(venueId)) return res.status(404).json({ error: 'Venue not found.' }); const reference = reportReference(); const id = await this.queries.createContentReport({ reference, reporterUserId: req.user?.id || null, reporterEmail, entityType: 'venue', entityId: String(venueId), contentUrl: null, reasonCode: reason === 'scam_fraud' ? 'scam_fraud' : reason === 'privacy' ? 'privacy' : reason === 'intellectual_property' ? 'intellectual_property' : 'other', description, supportingDetails: `Venue report reason: ${reason}`, allegedIllegal: reason === 'illegal_activity' || reason === 'scam_fraud' }); return res.status(201).json({ id, reference, status: 'submitted' }); }
      catch (error) { console.error('Venue report submission failed:', error.message); return res.status(500).json({ error: 'Unable to submit venue report.' }); }
    });
    app.get('/api/my/saved-venues', authenticate, async (req, res) => { try { await ensureTable(); return sendVenueList(res, await this.queries.savedVenues(req.user.id)); } catch (error) { console.error('Saved venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load saved venues.' }); } });
    app.get('/api/venues/:id/similar', optionalAuthenticate, async (req, res) => { const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' }); try { await ensureTable(); const venues = await this.queries.similarVenues(venueId, req.user?.id ?? null, req.user?.role ?? null); return venues === null ? res.status(404).json({ error: 'Venue not found.' }) : sendVenueList(res, venues); } catch (error) { console.error('Similar venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load similar venues.' }); } });
    app.get('/api/venues/slug/:slug', optionalAuthenticate, async (req, res) => { const slug = venueSlug(req.params.slug); if (!slug) return res.status(422).json({ error: 'A valid venue slug is required.' }); try { await ensureTable(); const venue = await this.queries.venueBySlug(slug, req.user?.id ?? null, req.user?.role ?? null); return venue ? res.json(venue) : res.status(404).json({ error: 'Venue not found.' }); } catch (error) { console.error('Venue slug lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue.' }); } });
    app.get('/api/venues/:id', optionalAuthenticate, async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); const venue = await this.queries.venue(venueId, req.user?.id ?? null, req.user?.role ?? null); return venue ? res.json(venue) : res.status(404).json({ error: 'Venue not found.' }); }
      catch (error) { console.error('Venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue.' }); }
    });
    app.post('/api/events/:id/venue-booking', authenticate, async (req, res) => {
      const eventId = Number(req.params.id);
      const venueId = Number(req.body.venueId);
      if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'Valid eventId and venueId values are required.' });
      try {
        await ensureTable();
        const context = await this.queries.venueBookingContext(eventId, venueId, req.user.id, req.user.role);
        if (context.error === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Event not found or not managed by you.' });
        if (context.error === 'VENUE_NOT_FOUND') return res.status(404).json({ error: 'Venue not found or inactive.' });
        const availability = eventFitsVenueAvailability(context.event, context.venue);
        if (availability.error) return res.status(422).json({ error: availability.error });
        const result = await this.queries.requestVenueBooking(eventId, venueId, context.event.managerId);
        if (result.error === 'EVENT_ALREADY_BOOKED') return res.status(409).json({ error: 'This event already has an active venue booking.' });
        if (result.error === 'VENUE_UNAVAILABLE') return res.status(409).json({ error: 'The venue is already booked for this time.' });
        if (result.error) return res.status(404).json({ error: 'Event or venue not found.' });
        return res.status(201).json(await this.queries.eventVenueBooking(eventId, req.user.id, req.user.role));
      } catch (error) { console.error('Venue booking request failed:', error.message); return res.status(500).json({ error: 'Unable to request venue booking.' }); }
    });
    app.get('/api/events/:id/venue-booking', authenticate, async (req, res) => {
      try { await ensureTable(); const booking = await this.queries.eventVenueBooking(req.params.id, req.user.id, req.user.role); return booking ? res.json(booking) : res.status(404).json({ error: 'Venue booking not found or not available to you.' }); }
      catch (error) { console.error('Venue booking lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue booking.' }); }
    });
    app.post('/api/events/:id/venue-booking/cancel', authenticate, async (req, res) => {
      try { await ensureTable(); if (!await this.queries.cancelVenueBooking(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Active venue booking not found or not managed by you.' }); return res.json({ message: 'Venue booking cancelled.' }); }
      catch (error) { console.error('Venue booking cancellation failed:', error.message); return res.status(500).json({ error: 'Unable to cancel venue booking.' }); }
    });
    app.patch('/api/venue-bookings/:id', authenticate, requireVenueOwner, async (req, res) => {
      const bookingId = Number(req.params.id);
      const status = String(req.body.status || '');
      const ownerNote = req.body.ownerNote == null ? null : String(req.body.ownerNote).trim() || null;
      if (!Number.isInteger(bookingId) || bookingId < 1 || !['confirmed', 'declined'].includes(status)) return res.status(422).json({ error: 'A booking id and status of confirmed or declined are required.' });
      try { await ensureTable(); if (!await this.queries.reviewVenueBooking(bookingId, req.user.id, req.user.role, status, ownerNote)) return res.status(404).json({ error: 'Pending venue booking not found or not managed by you.' }); return res.json({ id: bookingId, status, ownerNote }); }
      catch (error) { console.error('Venue booking review failed:', error.message); return res.status(500).json({ error: 'Unable to review venue booking.' }); }
    });
    app.post('/api/events/:id/registrations', authenticate, async (req, res, next) => { try { await ensureTable(); if (await this.queries.eventVisibility(req.params.id) === 'Private' && !await this.queries.privateInvitationExists(req.params.id, req.user.id) && req.user.id !== (await this.queries.eventManagerId(req.params.id))) return res.status(403).json({ code: 'INVITATION_REQUIRED', error: 'A direct invitation is required to register for this private event.' }); return next(); } catch (error) { return res.status(500).json({ error: 'Unable to validate event access.' }); } });
    
    app.post('/api/auth/register', async (req, res) => {
      const { profilePicture = null, name, email, password, termsAccepted, termsVersion, ageConfirmed, marketingConsent = false } = req.body;
      if (!name?.trim() || !email?.trim() || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      if (termsAccepted !== true || typeof termsVersion !== 'string') return res.status(422).json({ error: 'You must accept the current Terms of Service to register.' });
      if (ageConfirmed !== true) return res.status(422).json({ error: `You must confirm that you are at least ${this.config.runtime.minimumUserAge} years old to register.` });
      if (typeof marketingConsent !== 'boolean') return res.status(422).json({ error: 'marketingConsent must be a boolean when provided.' });
      try {
        await ensureTable();
        const terms = await currentLegalDocument('terms', this.config);
        await this.queries.ensureLegalDocumentVersion(terms);
        if (terms.version !== termsVersion) return res.status(409).json({ error: 'The Terms of Service have changed. Review and accept the current version.', termsVersion: terms.version });
        const normalizedEmail = email.trim().toLowerCase();
        if (await this.queries.emailExists(normalizedEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });
        const passwordHash = await hashPassword(password);
        const verificationToken = createVerificationToken();
      if (!this.config.email.smtp.host) throw new Error('SMTP_HOST is not configured');
      const userId = await this.queries.createUser({ profilePicture, name: name.trim(), email: normalizedEmail, passwordHash, phone: null, role: 'customer', tokenHash: hashToken(verificationToken), termsVersion: terms.version, marketingConsent, marketingPolicyVersion: '2026-08-26' }, () => this.emailService.sendVerification(normalizedEmail, name.trim(), verificationToken));
        return res.status(201).json({ message: 'Registration successful. Please check your email to verify your account.', user: { id: userId, profilePicture, name: name.trim(), email: normalizedEmail, role: 'customer', isEmailConfirmed: false }, termsVersion: terms.version });
      } catch (error) { console.error('Registration failed:', error.message); return res.status(500).json({ error: 'Unable to register right now.' }); }
    });
    app.post('/api/auth/resend-verification', async (req, res) => { const email = req.body.email?.trim().toLowerCase(); const message = 'If an unverified account exists for that email, a new verification email has been sent.'; if (!email) return res.status(200).json({ message }); try { await ensureTable(); const token = createVerificationToken(); const user = await this.queries.refreshVerification(email, hashToken(token)); if (user?.cooldownSeconds) return res.status(429).set('Retry-After', String(user.cooldownSeconds)).json({ error: 'Please wait before requesting another verification email.', retryAfter: user.cooldownSeconds }); if (user) { try { await this.emailService.sendVerification(user.email, user.name, token); } catch (emailError) { console.error('Verification resend email failed:', emailError.message); } } return res.json({ message }); } catch (error) { console.error('Verification resend failed:', error.message); return res.status(500).json({ error: 'Unable to resend verification email.' }); } });
    app.post('/api/auth/forgot-password', async (req, res) => {
      const email = String(req.body.email || '').trim().toLowerCase();
      const message = 'If an account exists for that email, a password reset link has been sent.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
      try {
        await ensureTable();
        const token = createVerificationToken();
        const user = await this.queries.createPasswordReset(email, hashToken(token));
        if (user && !user.cooldown) {
          try { await this.emailService.sendPasswordReset(user.email, user.name, token); }
          catch (emailError) { console.error('Password reset email failed:', emailError.message); }
        }
        return res.json({ message });
      } catch (error) { console.error('Password reset request failed:', error.message); return res.status(500).json({ error: 'Unable to request a password reset right now.' }); }
    });
    app.post('/api/auth/reset-password', async (req, res) => {
      const token = String(req.body.token || '');
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!token || password.length < 8) return res.status(400).json({ error: 'A valid reset token and a password of at least 8 characters are required.' });
      try {
        await ensureTable();
        if (!await this.queries.resetPassword(hashToken(token), await hashPassword(password))) return res.status(400).json({ error: 'Invalid or expired password reset token.' });
        return res.json({ message: 'Your password has been reset successfully.' });
      } catch (error) { console.error('Password reset failed:', error.message); return res.status(500).json({ error: 'Unable to reset your password right now.' }); }
    });
    
    app.get('/api/auth/verify-email', async (req, res) => {
      const { token } = req.query;
      if (!token) return res.status(400).json({ error: 'Verification token is required.' });
      try {
        await ensureTable();
        if (!await this.queries.verifyEmail(hashToken(token))) return res.status(400).json({ error: 'Invalid or expired verification token.' });
        return res.json({ message: 'Email address verified successfully.' });
      } catch (error) { console.error('Email verification failed:', error.message); return res.status(500).json({ error: 'Unable to verify email right now.' }); }
    });
    
    app.post('/api/auth/login', async (req, res) => {
      const { email, password } = req.body;
      try {
        await ensureTable();
      const user = await this.queries.findUserByEmail(email?.trim().toLowerCase());
        if (!user || !(await verifyPassword(password || '', user.password_hash))) return res.status(401).json({ error: 'Invalid email or password.' });
        if (!user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before logging in.' });
        return res.json({ token: createToken(user), user: { ...user, password_hash: undefined } });
      } catch (error) { console.error('Login failed:', error.message); return res.status(500).json({ error: 'Unable to log in right now.' }); }
    });
    
    app.get('/api/auth/profile', authenticate, async (req, res) => {
      try {
        await ensureTable();
      const user = await this.queries.profile(req.user.id);
        if (!user) return res.status(404).json({ error: 'User profile not found.' });
        return res.json({ user: { ...user, marketingConsent: Boolean(user.marketingConsent) } });
      } catch (error) { console.error('Profile lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load profile.' }); }
    });
    app.post('/api/auth/profile/picture', authenticate, parseProfilePicture, async (req, res) => { if (!req.file) return res.status(400).json({ error: 'A JPEG, PNG, GIF, or WebP image is required.' }); try { await ensureTable(); const profilePicture = await this.ftpService.uploadProfilePicture(req.user.id, req.file); if (!await this.queries.updateProfilePicture(req.user.id, profilePicture)) return res.status(404).json({ error: 'User profile not found.' }); return res.json({ profilePicture }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(400).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Profile picture storage is not configured.' }); console.error('Profile picture upload failed:', error.message); return res.status(502).json({ error: 'Unable to upload profile picture.' }); } });
    app.patch('/api/auth/profile/marketing-preferences', authenticate, async (req, res) => { if (typeof req.body.marketingConsent !== 'boolean') return res.status(400).json({ error: 'marketingConsent must be a boolean.' }); try { await ensureTable(); const profile = await this.queries.profile(req.user.id); if (!profile) return res.status(404).json({ error: 'User profile not found.' }); const marketingConsent = await this.queries.setMarketingEmailPreference(profile.email, req.body.marketingConsent, '2026-08-26'); await this.queries.audit(req.user.id, 'marketing_consent_changed', 'user', req.user.id, { marketingConsent }); return res.json({ marketingConsent }); } catch (error) { return res.status(500).json({ error: 'Unable to update marketing preferences.' }); } });
    app.patch('/api/auth/profile/email-preferences', authenticate, async (req, res) => { if (typeof req.body.receiveEmailNotifications !== 'boolean') return res.status(400).json({ error: 'receiveEmailNotifications must be a boolean.' }); try { await ensureTable(); const profile = await this.queries.profile(req.user.id); if (!profile) return res.status(404).json({ error: 'User profile not found.' }); const marketingConsent = await this.queries.setMarketingEmailPreference(profile.email, req.body.receiveEmailNotifications, '2026-08-26', 'legacy-settings'); return res.json({ marketingConsent, deprecated: true }); } catch (error) { return res.status(500).json({ error: 'Unable to update marketing preferences.' }); } });
    
    app.get('/api/auth/export', authenticate, async (req, res) => {
      try {
        await ensureTable();
        const exportData = await this.queries.dataExport(req.user.id);
        if (!exportData) return res.status(404).json({ error: 'User profile not found.' });
        await this.queries.audit(req.user.id, 'data_export_requested', 'user', req.user.id);
        res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="ykcircle-data-export-${req.user.id}.json"` });
        return res.json(exportData);
      } catch (error) { console.error('Data export failed:', error.message); return res.status(500).json({ error: 'Unable to create data export.' }); }
    });
    app.delete('/api/auth/profile', authenticate, async (req, res) => {
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!password) return res.status(400).json({ error: 'Confirm your password to delete your account.' });
      try {
        await ensureTable();
      const currentUser = await this.queries.findUserByEmail(req.user.email);
      if (!currentUser || !(await verifyPassword(password, currentUser.password_hash))) return res.status(403).json({ error: 'Password confirmation failed.' });
      const deletedUser = await this.queries.deleteUser(req.user.id);
        if (!deletedUser) return res.status(404).json({ error: 'User account not found.' });
        try {
          await this.emailService.sendAccountDeleted(deletedUser.email, deletedUser.name);
        } catch (emailError) {
          console.error('Account deletion email failed:', emailError.message);
        }
        return res.json({ message: 'Your account has been deleted and eligible content has been removed or anonymised.' });
      } catch (error) { console.error('Account deletion failed:', error.message); return res.status(500).json({ error: 'Unable to delete account.' }); }
    });
    
    app.get('/api/applications', authenticate, async (req, res) => {
      try {
        await ensureTable();
      return res.json(await this.queries.applicationsForUser(req.user.email));
      } catch (error) { console.error('Application lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load applications.' }); }
    });
    app.get('/api/venue-owner-applications/me', authenticate, async (req, res) => {
      try { await ensureTable(); const application = await this.queries.venueOwnerApplication(req.user.id); return application ? res.json(application) : res.status(404).json({ error: 'Venue-owner application not found.' }); }
      catch (error) { console.error('Venue-owner application lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue-owner application.' }); }
    });
    app.post('/api/venue-owner-applications', authenticate, requireVerifiedUser, async (req, res) => {
      const businessName = String(req.body.businessName || '').trim();
      const message = req.body.message == null ? null : String(req.body.message).trim() || null;
      if (businessName.length < 2 || businessName.length > 160 || (message && message.length > 5000)) return res.status(422).json({ error: 'Business name must be 2-160 characters and the message must not exceed 5,000 characters.' });
      try { await ensureTable(); const application = await this.queries.createVenueOwnerApplication(req.user.id, { businessName, message }); return res.status(201).json(application); }
      catch (error) { console.error('Venue-owner application failed:', error.message); return res.status(500).json({ error: 'Unable to submit venue-owner application.' }); }
    });
    
    app.get('/api/admin/applications', authenticate, requireAdmin, async (_req, res) => {
      try {
        await ensureTable();
      return res.json(await this.queries.applications());
      } catch (error) { console.error('Application lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load applications.' }); }
    });
    
    app.get('/api/admin/applications/:id', authenticate, requireAdmin, async (req, res) => {
      try {
        await ensureTable();
      const application = await this.queries.application(req.params.id);
        if (!application) return res.status(404).json({ error: 'Application not found.' });
        return res.json(application);
      } catch (error) { console.error('Application lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load application.' }); }
    });
    app.get('/api/admin/venue-owner-applications', authenticate, requireAdmin, async (req, res) => {
      const status = req.query.status == null ? null : String(req.query.status);
      if (status && !['pending', 'approved', 'declined'].includes(status)) return res.status(422).json({ error: 'Invalid venue-owner application status.' });
      try { await ensureTable(); return res.json(await this.queries.venueOwnerApplications(status)); }
      catch (error) { console.error('Venue-owner application lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue-owner applications.' }); }
    });
    app.patch('/api/admin/venue-owner-applications/:id/review', authenticate, requireAdmin, async (req, res) => {
      const applicationId = Number(req.params.id);
      const status = String(req.body.status || '');
      if (!Number.isInteger(applicationId) || applicationId < 1 || !['approved', 'declined'].includes(status)) return res.status(422).json({ error: 'A valid application id and status of approved or declined are required.' });
      try {
        await ensureTable();
        const result = await this.queries.reviewVenueOwnerApplication(applicationId, status, req.user.id);
        if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Venue-owner application not found.' });
        if (result.error === 'USER_NOT_FOUND') return res.status(404).json({ error: 'Applicant user not found.' });
        if (result.error === 'ROLE_NOT_ELIGIBLE') return res.status(409).json({ error: 'Manager and admin accounts cannot be reassigned as venue owners.' });
        return res.json({ message: `Venue-owner application ${status}.`, ...result });
      } catch (error) { console.error('Venue-owner application review failed:', error.message); return res.status(500).json({ error: 'Unable to review venue-owner application.' }); }
    });
    
    app.patch('/api/applications/:id/status', authenticate, requireAdmin, async (req, res) => {
    if (!isApplicationStatus(req.body.status)) return res.status(400).json({ error: 'Invalid application status.' });
      try {
        await ensureTable();
      if (!await this.queries.updateApplicationStatus(req.params.id, req.body.status)) return res.status(404).json({ error: 'Application not found.' });
        return res.json({ message: 'Application status updated.' });
      } catch (error) { console.error('Application update failed:', error.message); return res.status(500).json({ error: 'Unable to update application.' }); }
    });
    app.patch('/api/admin/applications/:id/organizer-review', authenticate, requireAdmin, async (req, res) => {
      if (!['Approved', 'Declined'].includes(req.body.status)) return res.status(400).json({ error: 'Status must be Approved or Declined.' });
      try {
        await ensureTable();
        const result = await this.queries.reviewOrganizerApplication(req.params.id, req.body.status);
        if (result.error === 'NOT_ORGANIZER_APPLICATION') return res.status(400).json({ error: 'This is not an event organizer application.' });
        if (result.error === 'CUSTOMER_NOT_FOUND') return res.status(404).json({ error: 'No customer account matches this application email.' });
        if (result.error === 'INVALID_CUSTOMER_ROLE') return res.status(409).json({ error: 'Only customer accounts can be approved as event organizers.' });
        return res.json({ message: `Organizer application ${req.body.status.toLowerCase()}.`, status: result.status, role: req.body.status === 'Approved' ? 'organizer' : 'customer' });
      } catch (error) { console.error('Organizer application review failed:', error.message); return res.status(500).json({ error: 'Unable to review organizer application.' }); }
    });
    app.patch('/api/admin/users/:id/role', authenticate, requireAdmin, async (req, res) => { if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid user role.' }); try { await ensureTable(); if (!await this.queries.updateUserRole(req.params.id, req.body.role, req.user.role)) return res.status(404).json({ error: 'User not found.' }); return res.json({ message: 'User role updated.', role: req.body.role }); } catch (error) { return res.status(500).json({ error: 'Unable to update user role.' }); } });
    app.get('/api/admin/users', authenticate, requireAdmin, async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.users()); } catch (error) { return res.status(500).json({ error: 'Unable to load users.' }); } });
    app.get('/api/manager/users', authenticate, requireRoleManager, async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.users()); } catch (error) { return res.status(500).json({ error: 'Unable to load users.' }); } });
    app.patch('/api/manager/users/:id/role', authenticate, requireRoleManager, async (req, res) => { if (req.body.role !== 'organizer') return res.status(400).json({ error: 'Managers can only assign the organizer role.' }); try { await ensureTable(); if (!await this.queries.updateUserRole(req.params.id, 'organizer', req.user.role)) return res.status(404).json({ error: 'Customer not found.' }); return res.json({ message: 'User role updated.', role: 'organizer' }); } catch (error) { return res.status(500).json({ error: 'Unable to update user role.' }); } });
    app.get('/api/admin/reports', authenticate, requireAdmin, async (req, res) => { const status = req.query.status ? String(req.query.status) : null; if (status && !['submitted', 'under_review', 'resolved', 'dismissed'].includes(status)) return res.status(422).json({ error: 'Invalid report status.' }); try { await ensureTable(); return res.json(await this.queries.contentReports(status)); } catch (error) { return res.status(500).json({ error: 'Unable to load reports.' }); } });
    app.patch('/api/admin/reports/:id', authenticate, requireAdmin, async (req, res) => { const id = Number(req.params.id); const status = String(req.body.status || ''); if (!Number.isInteger(id) || id < 1 || !['under_review', 'resolved', 'dismissed'].includes(status)) return res.status(422).json({ error: 'Invalid report status.' }); try { await ensureTable(); if (!await this.queries.reviewContentReport(id, status, req.user.id)) return res.status(404).json({ error: 'Report not found.' }); await this.queries.audit(req.user.id, 'content_report_reviewed', 'content_report', id, { status }); return res.json({ id, status }); } catch (error) { return res.status(500).json({ error: 'Unable to review report.' }); } });
    app.post('/api/admin/moderation/decisions', authenticate, requireAdmin, async (req, res) => { const entityType = String(req.body.entityType || '').trim(); const entityId = String(req.body.entityId || '').trim(); const action = String(req.body.action || '').trim(); const reasonCode = String(req.body.reasonCode || '').trim(); const explanationUser = req.body.explanationUser == null ? null : String(req.body.explanationUser).trim(); if (!entityType || !entityId || !action || !reasonCode || explanationUser?.length > 5000) return res.status(422).json({ error: 'A content type, content id, action, reason and optional user explanation are required.' }); try { await ensureTable(); const id = await this.queries.createModerationDecision({ entityType, entityId, subjectUserId: Number.isInteger(req.body.subjectUserId) ? req.body.subjectUserId : null, action, reasonCode, explanationInternal: req.body.explanationInternal == null ? null : String(req.body.explanationInternal).trim(), explanationUser, automatedDetection: req.body.automatedDetection === true, decidedByUserId: req.user.id, appealAvailable: req.body.appealAvailable !== false }); await this.queries.audit(req.user.id, 'moderation_decision_created', entityType, entityId, { decisionId: id, action, reasonCode }); return res.status(201).json({ id }); } catch (error) { return res.status(500).json({ error: 'Unable to record moderation decision.' }); } });
    app.post('/api/appeals', authenticate, async (req, res) => { const decisionId = Number(req.body.moderationDecisionId); const explanation = String(req.body.explanation || '').trim(); if (!Number.isInteger(decisionId) || decisionId < 1 || !explanation || explanation.length > 5000) return res.status(422).json({ error: 'A moderation decision and explanation are required.' }); try { await ensureTable(); const decision = await this.queries.moderationDecision(decisionId); if (!decision || !decision.appealAvailable || (decision.subjectUserId && decision.subjectUserId !== req.user.id)) return res.status(404).json({ error: 'Appeal is unavailable for this decision.' }); const id = await this.queries.createModerationAppeal({ decisionId, userId: req.user.id, explanation }); await this.queries.audit(req.user.id, 'moderation_appeal_created', 'moderation_decision', decisionId, { appealId: id }); return res.status(201).json({ id, status: 'submitted' }); } catch (error) { return res.status(500).json({ error: 'Unable to submit appeal.' }); } });
    app.patch('/api/admin/appeals/:id', authenticate, requireAdmin, async (req, res) => { const id = Number(req.params.id); const status = String(req.body.status || ''); if (!Number.isInteger(id) || id < 1 || !['under_review', 'upheld', 'reversed', 'partially_reversed'].includes(status)) return res.status(422).json({ error: 'Invalid appeal status.' }); try { await ensureTable(); if (!await this.queries.resolveModerationAppeal(id, req.user.id, status, req.body.outcome == null ? null : String(req.body.outcome), req.body.outcomeReason == null ? null : String(req.body.outcomeReason))) return res.status(404).json({ error: 'Appeal not found or already resolved.' }); await this.queries.audit(req.user.id, 'moderation_appeal_resolved', 'moderation_appeal', id, { status }); return res.json({ id, status }); } catch (error) { return res.status(500).json({ error: 'Unable to resolve appeal.' }); } });

    const articleSlug = (value) => String(value || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const articleTags = (values) => { const seen = new Set(); return (Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean).map((name) => ({ name: name.slice(0, 80), slug: articleSlug(name).slice(0, 100) })).filter((tag) => tag.slug && !seen.has(tag.slug) && (seen.add(tag.slug) || true)).slice(0, 8); };
    const sanitizeRichText = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r\n|\r|\n/g, '<br>');
    const articleInput = (body) => { const input = body && typeof body === 'object' ? body : {}; const rawCategoryId = input.categoryId; return { categoryId: rawCategoryId == null || rawCategoryId === '' || rawCategoryId === 'null' ? null : Number(rawCategoryId), title: String(input.title || '').trim(), excerpt: String(input.excerpt || '').trim(), body: sanitizeRichText(input.body).trim(), tags: articleTags(input.tags), isIndexable: input.isIndexable !== false, status: input.status || 'draft' }; };
    const validateArticle = (article, isAdmin = false) => { const fields = {}; if (article.categoryId !== null && (!Number.isInteger(article.categoryId) || article.categoryId < 1)) fields.categoryId = 'Choose a valid category.'; if (article.title.length < 8 || article.title.length > 200) fields.title = 'Title must be between 8 and 200 characters.'; if (article.excerpt.length < 20 || article.excerpt.length > 400) fields.excerpt = 'Excerpt must be between 20 and 400 characters.'; if (article.body.length < 40 || article.body.length > 200000) fields.body = 'Article body must be between 40 and 200,000 characters.'; if (!['draft', 'published'].includes(article.status) && !(isAdmin && ['archived', 'removed'].includes(article.status))) fields.status = 'Status must be draft or published.'; return fields; };
    app.get('/api/article-categories', async (_req, res) => { try { await ensureTable(); return res.json(await this.queries.articleCategories()); } catch { return res.status(500).json({ error: 'Unable to load article categories.' }); } });
    app.get('/api/articles', async (req, res) => { const page = Number(req.query.page || 1); const limit = Number(req.query.limit || 20); if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) return res.status(422).json({ error: 'page must be positive and limit must be between 1 and 50.' }); try { await ensureTable(); return res.json(await this.queries.articles({ categorySlug: req.query.category ? articleSlug(req.query.category) : null, tagSlug: req.query.tag ? articleSlug(req.query.tag) : null, page, limit })); } catch (error) { console.error('Article lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load articles.' }); } });
    app.get('/api/articles/:slug', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const article = await this.queries.articleBySlug(articleSlug(req.params.slug), req.user?.id ?? null, req.user?.role ?? null); if (!article) return res.status(404).json({ error: 'Article not found.' }); article.media = await this.queries.articleMedia(article.id); return res.json(decorateArticleImageUrls(article)); } catch (error) { console.error('Article lookup by slug failed:', error.message); return res.status(500).json({ error: 'Unable to load article.' }); } });
    app.get('/api/my/articles', authenticate, requireRoleManager, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.articles({ editorId: req.user.id, editorRole: req.user.role, limit: 50 })); } catch (error) { console.error('My article lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load your articles.' }); } });
    app.post('/api/articles', authenticate, requireRoleManager, async (req, res) => { const article = articleInput(req.body); if (req.user.role !== 'admin') article.isIndexable = true; const fields = validateArticle(article, req.user.role === 'admin'); if (Object.keys(fields).length) return res.status(422).json({ error: 'Article is invalid.', fields }); const slug = articleSlug(req.body.slug || article.title); if (!slug || slug.length > 180) return res.status(422).json({ error: 'Article is invalid.', fields: { slug: 'Provide a valid slug up to 180 characters.' } }); try { await ensureTable(); const id = await this.queries.createArticle({ ...article, slug, authorUserId: req.user.id }); await this.queries.syncArticleTags(id, article.tags); return res.status(201).json(await this.queries.articleBySlug(slug, req.user.id, req.user.role)); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An article with this slug already exists.' }); console.error('Article creation failed:', error.message); return res.status(500).json({ error: 'Unable to create article.' }); } });
    app.patch('/api/articles/:id', authenticate, requireRoleManager, async (req, res) => { const id = Number(req.params.id); const article = articleInput(req.body); if (req.user.role !== 'admin') article.isIndexable = true; const fields = validateArticle(article, req.user.role === 'admin'); if (!Number.isInteger(id) || id < 1 || Object.keys(fields).length) return res.status(422).json({ error: 'Article is invalid.', fields }); try { await ensureTable(); if (!await this.queries.updateArticle(id, req.user.id, req.user.role, [article.categoryId, article.title, article.excerpt, article.body, article.isIndexable])) return res.status(404).json({ error: 'Article not found or not owned by you.' }); await this.queries.syncArticleTags(id, article.tags); const editor = await this.queries.articleForEditor(id, req.user.id, req.user.role); return res.json(await this.queries.articleBySlug(editor.slug, req.user.id, req.user.role)); } catch (error) { console.error('Article update failed:', error.message); return res.status(500).json({ error: 'Unable to update article.' }); } });
    app.patch('/api/articles/:id/status', authenticate, requireRoleManager, async (req, res) => { const id = Number(req.params.id); const status = String(req.body.status || ''); const allowed = req.user.role === 'admin' ? ['draft', 'published', 'archived', 'removed'] : ['draft', 'published', 'archived']; if (!Number.isInteger(id) || id < 1 || !allowed.includes(status)) return res.status(422).json({ error: 'Invalid article status.' }); try { await ensureTable(); if (!await this.queries.setArticleStatus(id, req.user.id, req.user.role, status, req.user.role === 'admin' && typeof req.body.isIndexable === 'boolean' ? req.body.isIndexable : null)) return res.status(404).json({ error: 'Article not found or not owned by you.' }); return res.json({ id, status }); } catch (error) { console.error('Article status update failed:', error.message); return res.status(500).json({ error: 'Unable to update article status.' }); } });
    app.post('/api/articles/:id/cover', authenticate, requireRoleManager, parseArticleImage, async (req, res) => { const id = Number(req.params.id); const altText = String(req.body.altText || '').trim(); if (!Number.isInteger(id) || id < 1 || !req.file || altText.length < 3 || altText.length > 200) return res.status(422).json({ error: 'Cover image is invalid.', fields: { altText: 'Alt text must be between 3 and 200 characters.' } }); try { await ensureTable(); const article = await this.queries.articleForEditor(id, req.user.id, req.user.role); if (!article) return res.status(404).json({ error: 'Article not found or not owned by you.' }); const filename = await this.articleFtpService.uploadArticleImage(id, req.file); if (!await this.queries.setArticleCover(id, req.user.id, req.user.role, filename, altText)) { await this.articleFtpService.deleteArticleImage(filename); return res.status(404).json({ error: 'Article not found or not owned by you.' }); } if (article.coverImage) { try { await this.articleFtpService.deleteArticleImage(article.coverImage); } catch (error) { console.error('Previous article cover cleanup failed:', error.message); } } return res.json({ coverImage: articleImageUrl(filename), coverAltText: altText }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Article image storage is not configured.' }); return res.status(502).json({ error: 'Unable to upload article image.' }); } });
    app.post('/api/articles/:id/media', authenticate, requireRoleManager, parseArticleImage, async (req, res) => { const id = Number(req.params.id); const altText = String(req.body.altText || '').trim(); const caption = req.body.caption == null ? null : String(req.body.caption).trim() || null; if (!Number.isInteger(id) || id < 1 || !req.file || altText.length < 3 || altText.length > 200 || caption?.length > 500) return res.status(422).json({ error: 'Article image is invalid.' }); try { await ensureTable(); if (!await this.queries.articleForEditor(id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Article not found or not owned by you.' }); const filename = await this.articleFtpService.uploadArticleImage(id, req.file); const mediaId = await this.queries.addArticleMedia(id, filename, altText, caption); return res.status(201).json({ id: mediaId, filename, url: articleImageUrl(filename), altText, caption }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Article image storage is not configured.' }); return res.status(502).json({ error: 'Unable to upload article image.' }); } });
    app.delete('/api/articles/:articleId/media/:mediaId', authenticate, requireRoleManager, async (req, res) => { const articleId = Number(req.params.articleId); const mediaId = Number(req.params.mediaId); if (!Number.isInteger(articleId) || !Number.isInteger(mediaId)) return res.status(404).json({ error: 'Article image not found.' }); try { await ensureTable(); if (!await this.queries.articleForEditor(articleId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Article not found or not owned by you.' }); const media = await this.queries.articleMediaItem(mediaId, articleId); if (!media) return res.status(404).json({ error: 'Article image not found.' }); await this.queries.deleteArticleMedia(mediaId, articleId); try { await this.articleFtpService.deleteArticleImage(media.filename); } catch (error) { console.error('Article image cleanup failed:', error.message); } return res.json({ message: 'Article image deleted.' }); } catch { return res.status(500).json({ error: 'Unable to delete article image.' }); } });


    const groupInput = (body) => ({ name: String(body.name || '').trim(), description: body.description == null ? null : String(body.description).trim() || null, visibility: body.visibility || 'Public' });
    const validateGroup = (group) => {
      const fields = {};
      if (group.name.length < 3 || group.name.length > 120) fields.name = 'Name must be between 3 and 120 characters.';
      if (group.description?.length > 10000) fields.description = 'Description must not exceed 10,000 characters.';
      if (!['Public', 'Private'].includes(group.visibility)) fields.visibility = 'Visibility must be Public or Private.';
      return fields;
    };
    const groupSlug = (value) => String(value).trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    app.get('/api/groups', optionalAuthenticate, async (req, res) => { try { await ensureTable(); return res.json(decorateGroups(await this.queries.groupsForViewer(req.user?.id ?? null, req.user?.role ?? null))); } catch (error) { console.error('Group lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load groups.' }); } });
    app.get('/api/my/groups', authenticate, async (req, res) => { try { await ensureTable(); return res.json(decorateGroups(await this.queries.groupsForViewer(req.user.id, req.user.role, { membershipOnly: true }))); } catch (error) { return res.status(500).json({ error: 'Unable to load your groups.' }); } });
    app.get('/api/my/groups/managed', authenticate, async (req, res) => { try { await ensureTable(); return res.json(decorateGroups(await this.queries.groupsForViewer(req.user.id, req.user.role, { managedOnly: true }))); } catch (error) { return res.status(500).json({ error: 'Unable to load managed groups.' }); } });
    app.post('/api/groups', authenticate, async (req, res) => { if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before creating a group.' }); const group = groupInput(req.body); const fields = validateGroup(group); if (Object.keys(fields).length) return res.status(422).json({ error: 'Group is invalid.', fields }); const slug = groupSlug(req.body.slug || group.name); if (!slug || slug.length > 140) return res.status(422).json({ error: 'Group is invalid.', fields: { slug: 'Provide a valid slug up to 140 characters.' } }); try { await ensureTable(); const id = await this.queries.createGroup({ organizerId: req.user.id, ...group, slug }); return res.status(201).json(decorateGroup(await this.queries.group(id, req.user.id, req.user.role))); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A group with this name or slug already exists.' }); console.error('Group creation failed:', error.message); return res.status(500).json({ error: 'Unable to create group.' }); } });
    const requireManagedGroup = async (req, res, next) => { try { await ensureTable(); if (!await this.queries.groupExists(req.params.id)) return res.status(404).json({ error: 'Group not found.' }); if (!await this.queries.canManageGroup(req.params.id, req.user.id, req.user.role)) return res.status(403).json({ error: 'You do not manage this group.' }); req.managedGroup = await this.queries.group(req.params.id, req.user.id, req.user.role); return next(); } catch (error) { return res.status(500).json({ error: 'Unable to validate group access.' }); } };
    app.post('/api/group-invitations/respond', async (req, res) => { const token = String(req.body.token || ''); const action = String(req.body.action || ''); if (!token || !['accept', 'decline'].includes(action)) return res.status(422).json({ error: 'A valid invitation token and action are required.' }); try { await ensureTable(); const result = await this.queries.respondToGroupInvitation(token, action); if (result.error === 'INVALID') return res.status(400).json({ error: 'This group invitation is invalid, expired, or has already been used.' }); if (result.error === 'ACCOUNT_REQUIRED') return res.status(409).json({ code: 'ACCOUNT_REQUIRED', error: 'Create an account with the invited email address before accepting this invitation.', email: result.email }); if (result.error === 'EMAIL_NOT_VERIFIED') return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify the invited email address before accepting this invitation.' }); return res.json({ message: result.status === 'accepted' ? 'You joined the group.' : 'Invitation declined.', status: result.status, groupId: result.groupId, groupName: result.groupName }); } catch (error) { console.error('Group invitation response failed:', error.message); return res.status(500).json({ error: 'Unable to respond to this group invitation.' }); } });
    app.post('/api/groups/:id/invitations', authenticate, requireManagedGroup, async (req, res) => { if (Number(req.managedGroup.organizerId) !== req.user.id) return res.status(403).json({ error: 'Only the group organizer can invite members.' }); const rawUserId = req.body.userId; const email = String(req.body.email || '').trim(); const hasUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== ''; const hasEmail = Boolean(email); if (hasUserId === hasEmail) return res.status(422).json({ error: 'Invitation is invalid.', fields: { invitee: 'Provide exactly one of userId or email.' } }); const userId = hasUserId ? Number(rawUserId) : null; if (hasUserId && (!Number.isInteger(userId) || userId < 1)) return res.status(422).json({ error: 'Invitation is invalid.', fields: { userId: 'userId must be a positive integer.' } }); if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(422).json({ error: 'Invitation is invalid.', fields: { email: 'Provide a valid email address.' } }); try { const token = crypto.randomBytes(32).toString('base64url'); const result = await this.queries.createGroupInvitation(Number(req.params.id), req.user.id, { userId, email }, crypto.createHash('sha256').update(token).digest('hex')); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' }); if (result.error === 'NOT_PRIVATE') return res.status(409).json({ error: 'Only private groups use invitations; users can join public groups directly.' }); if (result.error === 'ALREADY_MEMBER') return res.status(409).json({ error: 'This user is already an active group member.' }); if (result.error === 'USER_NOT_FOUND') return res.status(404).json({ error: 'No user or valid email was found for this invitation.' }); await this.emailService.sendGroupInvitation(result.recipient.email, result.recipient.name, result.group, token); return res.status(201).json({ message: 'Group invitation sent.', invitation: result.invitation }); } catch (error) { console.error('Group invitation failed:', error.message); return res.status(502).json({ error: 'Unable to send group invitation.' }); } });
    app.get('/api/groups/:id/invitations', authenticate, requireManagedGroup, async (req, res) => { if (Number(req.managedGroup.organizerId) !== req.user.id) return res.status(403).json({ error: 'Only the group organizer can view invitations.' }); try { return res.json(await this.queries.groupInvitations(Number(req.params.id))); } catch (error) { return res.status(500).json({ error: 'Unable to load group invitations.' }); } });
    app.post('/api/groups/:id/cover', authenticate, requireManagedGroup, parseGroupCover, async (req, res) => { if (!req.file) return res.status(422).json({ error: 'Group cover is invalid.', fields: { coverImage: 'A JPEG, PNG, or WebP image is required.' } }); let coverImage; let coverPersisted = false; try { coverImage = await this.groupFtpService.uploadGroupCover(req.params.id, req.file); if (!await this.queries.setGroupCover(req.params.id, req.user.id, req.user.role, coverImage)) { await this.groupFtpService.deleteGroupCover(coverImage); return res.status(404).json({ error: 'Group not found or not managed by you.' }); } coverPersisted = true; const group = await this.queries.group(req.params.id, req.user.id, req.user.role); if (req.managedGroup.coverImage) { try { await this.groupFtpService.deleteGroupCover(req.managedGroup.coverImage); } catch (cleanupError) { console.error('Previous group cover cleanup failed:', cleanupError.message); } } return res.json(decorateGroup(group)); } catch (error) { if (coverImage && !coverPersisted) { try { await this.groupFtpService.deleteGroupCover(coverImage); } catch (cleanupError) { console.error('New group cover cleanup failed:', cleanupError.message); } } if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: 'Group cover is invalid.', fields: { coverImage: error.message } }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Group image storage is not configured.' }); console.error('Group cover upload failed:', error.message); return res.status(502).json({ error: 'Unable to upload group cover.' }); } });
    app.get('/api/groups/:id', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const group = await this.queries.group(req.params.id, req.user?.id ?? null, req.user?.role ?? null); if (!group) return res.status(404).json({ error: 'Group not found.' }); group.events = await this.queries.groupEvents(group.id, req.user?.id ?? null, req.user?.role ?? null); return res.json(decorateGroup(group)); } catch (error) { console.error('Group detail lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load group.' }); } });
    app.get('/api/groups/:id/threads', authenticate, async (req, res) => { const groupId = Number(req.params.id); if (!Number.isInteger(groupId) || groupId < 1) return res.status(404).json({ error: 'Group not found.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or you are not a member.' }); return res.json(await this.queries.forumThreads('group', groupId, req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load group threads.' }); } });
    app.post('/api/groups/:id/threads', authenticate, async (req, res) => { const groupId = Number(req.params.id); const title = String(req.body.title || '').trim(); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(groupId) || groupId < 1 || title.length < 3 || title.length > 180 || !body || body.length > 4000) return res.status(422).json({ error: 'Thread title must be 3–180 characters and body must be 1–4,000 characters.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or you are not a member.' }); const id = await this.queries.createForumThread('group', groupId, req.user.id, title, body); return res.status(201).json({ id, groupId, title, status: 'active' }); } catch (error) { return res.status(500).json({ error: 'Unable to create group thread.' }); } });
    app.get('/api/groups/:groupId/threads/:threadId/messages', authenticate, async (req, res) => { const groupId = Number(req.params.groupId); const threadId = Number(req.params.threadId); if (!Number.isInteger(groupId) || !Number.isInteger(threadId)) return res.status(404).json({ error: 'Group thread not found.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role) || !await this.queries.forumThread('group', groupId, threadId)) return res.status(404).json({ error: 'Group thread not found.' }); const messages = await this.queries.forumMessages('group', threadId); await this.queries.markForumThreadRead('group', threadId, req.user.id, messages.at(-1)?.id); return res.json(messages); } catch (error) { return res.status(500).json({ error: 'Unable to load thread messages.' }); } });
    app.post('/api/groups/:groupId/threads/:threadId/messages', authenticate, async (req, res) => { const groupId = Number(req.params.groupId); const threadId = Number(req.params.threadId); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(groupId) || !Number.isInteger(threadId) || !body || body.length > 4000) return res.status(422).json({ error: 'Message must be between 1 and 4,000 characters.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or you are not a member.' }); const thread = await this.queries.forumThread('group', groupId, threadId); if (!thread) return res.status(404).json({ error: 'Group thread not found.' }); if (thread.status !== 'active') return res.status(409).json({ error: 'This group thread is locked.' }); const id = await this.queries.addForumMessage('group', threadId, req.user.id, body); return res.status(201).json({ id, threadId, body }); } catch (error) { return res.status(500).json({ error: 'Unable to send thread message.' }); } });
    app.patch('/api/groups/:groupId/threads/:threadId', authenticate, async (req, res) => { const groupId = Number(req.params.groupId); const threadId = Number(req.params.threadId); const status = String(req.body.status || ''); if (!Number.isInteger(groupId) || !Number.isInteger(threadId) || !['active', 'locked', 'removed'].includes(status)) return res.status(422).json({ error: 'Invalid thread status.' }); try { await ensureTable(); if (!await this.queries.canManageGroup(groupId, req.user.id, req.user.role) || !await this.queries.forumThread('group', groupId, threadId)) return res.status(404).json({ error: 'Group thread not found or not managed by you.' }); await this.queries.setForumThreadStatus('group', threadId, status); return res.json({ id: threadId, status }); } catch (error) { return res.status(500).json({ error: 'Unable to moderate group thread.' }); } });
    app.patch('/api/groups/:id', authenticate, requireManagedGroup, async (req, res) => { const group = groupInput(req.body); const fields = validateGroup(group); if (Object.keys(fields).length) return res.status(422).json({ error: 'Group is invalid.', fields }); try { await ensureTable(); if (!await this.queries.updateGroup(req.params.id, req.user.id, req.user.role, group)) return res.status(404).json({ error: 'Group not found or not managed by you.' }); return res.json(decorateGroup(await this.queries.group(req.params.id, req.user.id, req.user.role))); } catch (error) { return res.status(500).json({ error: 'Unable to update group.' }); } });
    app.delete('/api/groups/:id', authenticate, requireManagedGroup, async (req, res) => { try { await ensureTable(); if (!await this.queries.deleteGroup(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or not managed by you.' }); return res.json({ message: 'Group deleted.' }); } catch (error) { return res.status(500).json({ error: 'Unable to delete group.' }); } });
    app.post('/api/groups/:id/join', authenticate, async (req, res) => { if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before joining a group.' }); try { await ensureTable(); const result = await this.queries.joinGroup(req.params.id, req.user.id); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' }); if (result.error === 'PRIVATE') return res.status(403).json({ error: 'This private group cannot be joined directly.' }); return res.status(result.joined ? 201 : 200).json({ message: result.joined ? 'You joined the group.' : 'You are already a member.', isMember: true }); } catch (error) { return res.status(500).json({ error: 'Unable to join group.' }); } });
    app.delete('/api/groups/:id/membership', authenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.leaveGroup(req.params.id, req.user.id)) return res.status(409).json({ error: 'You are not a member, or you own this group.' }); return res.json({ message: 'You left the group.', isMember: false }); } catch (error) { return res.status(500).json({ error: 'Unable to leave group.' }); } });
    app.get('/api/groups/:id/members', authenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.canManageGroup(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or not managed by you.' }); return res.json(await this.queries.groupMembers(req.params.id, req.user.id, req.user.role)); } catch (error) { return res.status(500).json({ error: 'Unable to load group members.' }); } });
    app.post('/api/groups/:id/members', authenticate, requireManagedGroup, async (req, res) => { const rawUserId = req.body.userId; const email = String(req.body.email || '').trim(); const hasUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== ''; const hasEmail = Boolean(email); if (hasUserId === hasEmail) return res.status(422).json({ error: 'Member is invalid.', fields: { member: 'Provide exactly one of userId or email.' } }); const userId = hasUserId ? Number(rawUserId) : null; if (hasUserId && (!Number.isInteger(userId) || userId < 1)) return res.status(422).json({ error: 'Member is invalid.', fields: { userId: 'userId must be a positive integer.' } }); if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(422).json({ error: 'Member is invalid.', fields: { email: 'Provide a valid email address.' } }); try { const result = await this.queries.addGroupMember(req.params.id, { userId, email }); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' }); if (result.error === 'PRIVATE') return res.status(409).json({ error: 'Invite private-group members through POST /api/groups/:id/invitations.' }); if (result.error === 'USER_NOT_FOUND') return res.status(404).json({ error: 'No registered user matches this member.' }); if (result.error === 'EMAIL_NOT_VERIFIED') return res.status(409).json({ code: 'EMAIL_NOT_VERIFIED', error: 'This user must verify their email before joining a group.' }); return res.status(result.added ? 201 : 200).json({ message: result.added ? 'Member added.' : 'This user is already a member.', member: result.member }); } catch (error) { console.error('Group member addition failed:', error.message); return res.status(500).json({ error: 'Unable to add group member.' }); } });
    app.delete('/api/groups/:id/members/:userId', authenticate, requireManagedGroup, async (req, res) => { const userId = Number(req.params.userId); if (!Number.isInteger(userId) || userId < 1) return res.status(404).json({ error: 'Member not found.' }); try { const result = await this.queries.removeGroupMember(req.params.id, userId); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Member not found.' }); if (result.error === 'OWNER') return res.status(409).json({ error: 'The group owner cannot be removed.' }); return res.json({ message: 'Member removed.', userId }); } catch (error) { console.error('Group member removal failed:', error.message); return res.status(500).json({ error: 'Unable to remove group member.' }); } });

    app.get('/api/events', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const canViewAll = ['manager', 'admin'].includes(req.user?.role); return res.json(await this.queries.events(req.user?.id ?? null, canViewAll)); } catch (error) { console.error('Event lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load events.' }); } });
    app.get('/api/events/:id', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user?.id ?? null, req.user?.role ?? null); if (!event) return res.status(404).json({ error: 'Event not found.' }); const canViewArchived = ['manager', 'admin'].includes(req.user?.role) || event.managerId === req.user?.id; if (event.status === 'Archived' && !canViewArchived) return res.status(404).json({ error: 'Event not found.' }); event.participants = await this.queries.publicEventParticipants(req.params.id); if (req.user) event.myParticipantStatus = await this.queries.eventParticipantStatus(event.id, req.user.id); return res.json(event); } catch (error) { console.error('Event detail lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load event.' }); } });
    app.get('/api/events/:id/rating', optionalAuthenticate, async (req, res) => { const eventId = Number(req.params.id); if (!Number.isInteger(eventId) || eventId < 1) return res.status(404).json({ error: 'Event not found.' }); try { await ensureTable(); const summary = await this.queries.eventRatingSummary(eventId, req.user?.id ?? null); if (!summary) return res.status(404).json({ error: 'Event not found.' }); return res.json(summary); } catch (error) { return res.status(500).json({ error: 'Unable to load event rating.' }); } });
    app.put('/api/events/:id/rating', authenticate, async (req, res) => { const eventId = Number(req.params.id); const rating = Number(req.body.rating); if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(422).json({ error: 'rating must be an integer from 1 to 5.' }); try { await ensureTable(); const result = await this.queries.rateEvent(eventId, req.user.id, rating); if (result.error === 'NO_SHOW') return res.status(403).json({ code: 'EVENT_RATING_NO_SHOW', error: 'No-show participants cannot rate this event.' }); if (result.error === 'NOT_ATTENDED') return res.status(403).json({ code: 'EVENT_RATING_REQUIRES_ATTENDANCE', error: 'Only participants marked as Attended can rate this event.' }); return res.json(result.summary); } catch (error) { return res.status(500).json({ error: 'Unable to save event rating.' }); } });
    app.get('/api/events/:id/threads', optionalAuthenticate, async (req, res) => { const eventId = Number(req.params.id); if (!Number.isInteger(eventId) || eventId < 1) return res.status(404).json({ error: 'Event not found.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user?.id ?? null, req.user?.role ?? null)) return res.status(404).json({ error: 'Event forum not found.' }); return res.json(await this.queries.forumThreads('event', eventId, req.user?.id ?? null)); } catch (error) { return res.status(500).json({ error: 'Unable to load event threads.' }); } });
    app.post('/api/events/:id/threads', authenticate, async (req, res) => { const eventId = Number(req.params.id); const title = String(req.body.title || '').trim(); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(eventId) || eventId < 1 || title.length < 3 || title.length > 180 || !body || body.length > 4000) return res.status(422).json({ error: 'Thread title must be 3-180 characters and body must be 1-4,000 characters.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event forum not found.' }); const id = await this.queries.createForumThread('event', eventId, req.user.id, title, body); return res.status(201).json({ id, eventId, title, status: 'active' }); } catch (error) { return res.status(500).json({ error: 'Unable to create event thread.' }); } });
    app.get('/api/events/:eventId/threads/:threadId/messages', optionalAuthenticate, async (req, res) => { const eventId = Number(req.params.eventId); const threadId = Number(req.params.threadId); if (!Number.isInteger(eventId) || !Number.isInteger(threadId)) return res.status(404).json({ error: 'Event thread not found.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user?.id ?? null, req.user?.role ?? null)) return res.status(404).json({ error: 'Event forum not found.' }); const thread = await this.queries.forumThread('event', eventId, threadId); if (!thread || thread.status === 'removed') return res.status(404).json({ error: 'Event thread not found.' }); const messages = await this.queries.forumMessages('event', threadId); if (req.user) await this.queries.markForumThreadRead('event', threadId, req.user.id, messages.at(-1)?.id); return res.json(messages); } catch (error) { return res.status(500).json({ error: 'Unable to load thread messages.' }); } });
    app.post('/api/events/:eventId/threads/:threadId/messages', authenticate, async (req, res) => { const eventId = Number(req.params.eventId); const threadId = Number(req.params.threadId); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(eventId) || !Number.isInteger(threadId) || !body || body.length > 4000) return res.status(422).json({ error: 'Message must be between 1 and 4,000 characters.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event forum not found.' }); const thread = await this.queries.forumThread('event', eventId, threadId); if (!thread || thread.status === 'removed') return res.status(404).json({ error: 'Event thread not found.' }); if (thread.status !== 'active') return res.status(409).json({ error: 'This event thread is locked.' }); const id = await this.queries.addForumMessage('event', threadId, req.user.id, body); return res.status(201).json({ id, threadId, body }); } catch (error) { return res.status(500).json({ error: 'Unable to send thread message.' }); } });
    app.patch('/api/events/:eventId/threads/:threadId', authenticate, async (req, res) => { const eventId = Number(req.params.eventId); const threadId = Number(req.params.threadId); const status = String(req.body.status || ''); if (!Number.isInteger(eventId) || !Number.isInteger(threadId) || !['active', 'locked', 'removed'].includes(status)) return res.status(422).json({ error: 'Invalid thread status.' }); try { await ensureTable(); if (!await this.queries.canManageEventForum(eventId, req.user.id, req.user.role) || !await this.queries.forumThread('event', eventId, threadId)) return res.status(404).json({ error: 'Event thread not found or not managed by you.' }); await this.queries.setForumThreadStatus('event', threadId, status); return res.json({ id: threadId, status }); } catch (error) { return res.status(500).json({ error: 'Unable to moderate event thread.' }); } });
    app.delete('/api/events/:id', authenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.softDeleteEvent(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); return res.json({ message: 'Event deleted.' }); } catch (error) { return res.status(500).json({ error: 'Unable to delete event.' }); } });
    app.get('/api/my/events', authenticate, async (req, res) => { try { await ensureTable(); if (['manager', 'admin'].includes(req.user.role)) return res.json(await this.queries.events(req.user.id, true)); return res.json(await this.queries.managerEvents(req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load your events.' }); } });
    app.post('/api/events', authenticate, async (req, res) => { const { title, description = null, location = null, startsAt, endsAt = null, capacity = null } = req.body; if (!title?.trim() || !startsAt) return res.status(400).json({ error: 'Title and start date are required.' }); try { await ensureTable(); const id = await this.queries.createEvent({ managerId: req.user.id, title: title.trim(), description, location, startsAt, endsAt, capacity: capacity === null ? null : Number(capacity) }); return res.status(201).json({ id, status: 'Draft', role: req.user.role === 'customer' ? 'organizer' : req.user.role }); } catch (error) { console.error('Event creation failed:', error.message); return res.status(500).json({ error: 'Unable to create event.' }); } });
    app.post('/api/events/:id/invitations', authenticate, requireManager, async (req, res) => { const { name, email } = req.body; if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: 'Name and email are required.' }); try { await ensureTable(); const invitation = await this.queries.createInvitation(req.params.id, req.user.id, name.trim(), email.trim().toLowerCase()); if (invitation.error === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Event not found.' }); if (invitation.error === 'ALREADY_INVITED') return res.status(409).json({ error: 'This customer has already been invited to the event.' }); await this.emailService.sendEventInvitation(email.trim().toLowerCase(), name.trim(), invitation); return res.status(201).json({ message: 'Invitation sent.' }); } catch (error) { console.error('Event invitation failed:', error.message); return res.status(500).json({ error: 'Unable to send event invitation.' }); } });
    app.post('/api/events/:eventId/invitations/:invitationId/resend', authenticate, requireManager, async (req, res) => { try { await ensureTable(); const invitation = await this.queries.resendInvitation(req.params.eventId, req.params.invitationId, req.user.id); if (!invitation) return res.status(404).json({ error: 'Pending invitation not found or not managed by you.' }); await this.emailService.sendEventInvitation(invitation.email, invitation.name, invitation); return res.json({ message: 'Invitation resent.' }); } catch (error) { console.error('Invitation resend failed:', error.message); return res.status(500).json({ error: 'Unable to resend invitation.' }); } });
    app.get('/api/events/:id/invitations', authenticate, requireManager, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.invitations(req.params.id, req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load event invitations.' }); } });
    app.patch('/api/events/:eventId/invitations/:invitationId/status', authenticate, requireManager, async (req, res) => { if (!isInvitationStatus(req.body.status)) return res.status(400).json({ error: 'Invalid invitation status.' }); try { await ensureTable(); if (!await this.queries.updateInvitationStatus(req.params.invitationId, req.params.eventId, req.user.id, req.body.status)) return res.status(404).json({ error: 'Invitation not found.' }); return res.json({ message: 'Invitation status updated.', status: req.body.status }); } catch (error) { return res.status(500).json({ error: 'Unable to update invitation status.' }); } });
    app.patch('/api/events/:id/status', authenticate, requireManager, async (req, res) => { if (!isEventStatus(req.body.status)) return res.status(400).json({ error: 'Invalid event status.' }); try { await ensureTable(); const event = req.body.status === 'Published' ? await this.queries.richEvent(req.params.id, req.user.id, req.user.role) : null; if (!await this.queries.updateEventStatus(req.params.id, req.user.id, req.body.status, req.user.role)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); if (event?.groupId && event.status !== 'Published') await notifyGroupEventMembers(req.params.id); return res.json({ message: 'Event status updated.', status: req.body.status }); } catch (error) { return res.status(500).json({ error: 'Unable to update event status.' }); } });
    app.post('/api/events/:id/registrations', authenticate, async (req, res) => { if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Your account is not permitted to register for events.' }); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before registering for an event.' }); try { await ensureTable(); const result = await this.queries.registerForEvent(req.params.id, req.user.id, req.user.email); if (result.error === 'EVENT_UNAVAILABLE') return res.status(409).json({ error: 'Event is not available for registration.' }); if (result.error === 'EVENT_FULL') return res.status(409).json({ error: 'Event is full.' }); if (result.error === 'ALREADY_REGISTERED') return res.status(409).json({ error: 'You are already registered for this event.' }); const user = await this.queries.profile(req.user.id); try { await this.emailService.sendRegistrationConfirmation(user.email, user.name, result); } catch (emailError) { console.error('Registration confirmation email failed:', emailError.message); } try { await this.emailService.sendManagerRegistrationNotification(result.managerEmail, result.managerName, user.name, user.email, result.title, result.eventId, result.id); } catch (emailError) { console.error('Manager registration notification failed:', emailError.message); } return res.status(201).json({ id: result.id, status: 'Pending' }); } catch (error) { console.error('Event registration failed:', error.message); return res.status(500).json({ error: 'Unable to register for event.' }); } });
    app.get('/api/my/registrations', authenticate, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.userRegistrations(req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load registrations.' }); } });
    app.patch('/api/events/:eventId/withdraw', authenticate, async (req, res) => { const eventId = Number(req.params.eventId); if (!Number.isInteger(eventId) || eventId < 1) return res.status(404).json({ error: 'Active registration not found.' }); try { await ensureTable(); const registration = await this.queries.findActiveRegistrationForUser(eventId, req.user.id); if (!registration || !await this.queries.markRegistrationWithdrawn(registration)) return res.status(404).json({ error: 'Active registration not found.' }); return res.json({ status: 'Withdrawn', registrationId: registration.id }); } catch (error) { console.error('Event withdrawal failed:', error.message); return res.status(500).json({ error: 'Unable to withdraw from this event.' }); } });
    app.patch('/api/registrations/:id/withdraw', authenticate, async (req, res) => { if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Your account is not permitted to withdraw registrations.' }); try { await ensureTable(); const registration = await this.queries.customerRegistration(req.params.id, req.user.id); if (!registration || !await this.queries.withdrawRegistration(req.params.id, req.user.id)) return res.status(404).json({ error: 'Registration not found or cannot be withdrawn.' }); try { await this.emailService.sendRegistrationWithdrawal(registration.email, registration.name, registration); } catch (emailError) { console.error('Registration withdrawal email failed:', emailError.message); } return res.json({ message: 'Registration withdrawn.', status: 'Withdrawn' }); } catch (error) { console.error('Registration withdrawal failed:', error.message); return res.status(500).json({ error: 'Unable to withdraw registration.' }); } });
    app.get('/api/events/:id/participants', authenticate, requireManager, async (req, res) => { try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user.id, req.user.role); if (!event || (!['manager', 'admin'].includes(req.user.role) && event.managerId !== req.user.id)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); return res.json(await this.queries.eventParticipants(req.params.id, true)); } catch (error) { return res.status(500).json({ error: 'Unable to load event participants.' }); } });
    app.get('/api/events/:id/registrations', authenticate, requireManager, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.registrations(req.params.id, req.user.id, req.user.role === 'admin')); } catch (error) { return res.status(500).json({ error: 'Unable to load event registrations.' }); } });
    app.patch('/api/participants/:id/status', authenticate, requireManager, async (req, res) => { if (!isParticipantStatus(req.body.status) || req.body.status === 'Pending') return res.status(400).json({ error: 'Participant status must be Attended or No Show.' }); try { await ensureTable(); if (!await this.queries.updateParticipantStatus(req.params.id, req.user.id, req.body.status, req.user.role === 'admin')) return res.status(404).json({ error: 'Participant not found.' }); return res.json({ message: 'Participant status updated.', status: req.body.status }); } catch (error) { return res.status(500).json({ error: 'Unable to update participant status.' }); } });
    app.patch('/api/participants/:id/payment-status', authenticate, requireManager, async (req, res) => { if (!['Not Required', 'Payment Required', 'Paid'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid payment status.' }); try { await ensureTable(); const fee = await this.queries.participantFee(req.params.id); if (req.body.status === 'Paid' && fee <= 0) return res.status(400).json({ error: 'This event does not require payment.' }); if (!await this.queries.updateParticipantPaymentStatus(req.params.id, req.user.id, req.body.status, req.user.role)) return res.status(404).json({ error: 'Participant not found.' }); return res.json({ message: 'Participant payment status updated.', paymentStatus: req.body.status }); } catch (error) { return res.status(500).json({ error: 'Unable to update participant payment status.' }); } });
    app.patch('/api/registrations/:id/payment-status', authenticate, requireManager, async (req, res) => { if (!['Not Required', 'Payment Required', 'Paid'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid payment status.' }); try { await ensureTable(); const fee = await this.queries.registrationFee(req.params.id); if (req.body.status === 'Paid' && fee <= 0) return res.status(400).json({ error: 'This event does not require payment.' }); if (!await this.queries.updateRegistrationPaymentStatus(req.params.id, req.user.id, req.body.status, req.user.role)) return res.status(404).json({ error: 'Pending registration not found.' }); return res.json({ message: 'Registration payment status updated.', paymentStatus: req.body.status }); } catch (error) { return res.status(500).json({ error: 'Unable to update registration payment status.' }); } });
    app.patch('/api/registrations/:id/status', authenticate, requireManager, async (req, res) => { if (!isRegistrationStatus(req.body.status)) return res.status(400).json({ error: 'Invalid registration status.' }); try { await ensureTable(); const registration = await this.queries.registration(req.params.id, req.user.id); if (!registration && req.user.role !== 'admin') return res.status(404).json({ error: 'Registration not found.' }); if (!await this.queries.updateRegistrationStatus(req.params.id, req.user.id, req.body.status, req.user.role === 'admin')) return res.status(404).json({ error: 'Registration not found.' }); if (req.body.status === 'Confirmed' && registration) { try { await this.emailService.sendRegistrationApproved(registration.email, registration.name, registration); } catch (emailError) { console.error('Registration approval email failed:', emailError.message); } } return res.json({ message: 'Registration status updated.' }); } catch (error) { return res.status(500).json({ error: 'Unable to update registration status.' }); } });
    
    app.post('/api/contact', optionalAuthenticate, async (req, res) => {
      const name = String(req.body.name || '').trim();
      const email = String(req.body.email || req.user?.email || '').trim().toLowerCase();
      const category = String(req.body.category || 'General');
      const message = String(req.body.message || req.body.additionalInformation || '').trim();
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['General', 'Privacy', 'Account', 'Safety', 'Other'].includes(category) || !message || message.length > 10000) return res.status(422).json({ error: 'Provide your name, a valid email, category, and a message up to 10,000 characters.' });
      try {
        await ensureTable();
        const reference = `CON-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        await this.queries.createPrivacyRequest({ reference, userId: req.user?.id || null, name, email, category, message });
        await this.queries.audit(req.user?.id || null, 'contact_request_created', 'privacy_request', reference, { category });
        return res.status(201).json({ reference, message: 'Your request has been received.' });
      } catch (error) {
        console.error('Contact submission failed:', error.message);
        return res.status(500).json({ error: 'Unable to save your message right now.' });
      }
    });
    
    
  }
}
