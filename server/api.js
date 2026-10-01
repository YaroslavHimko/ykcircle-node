import { OrganizerSubscriptions, registerSubscriptionRoutes } from './organizer-subscriptions.js';
import { accessError } from './product-access.js';
import { ArticlePublishing } from './article-publishing.js';
import { validateBranding } from './branding.js';
﻿ 
import crypto from 'node:crypto';
import { EVENT_STATUSES, isEventStatus } from './event-status.js';
import { REGISTRATION_STATUSES, isRegistrationStatus } from './registration-status.js';
import { INVITATION_STATUSES, isInvitationStatus } from './invitation-status.js';
import { PARTICIPANT_STATUSES, isParticipantStatus } from './participant-status.js';
import multer from 'multer';
import { EMAIL_UNSUBSCRIBE_REASONS } from './email-unsubscribe-reasons.js';
import { legalDocument, legalDocumentIndex, currentLegalDocument, legalReadiness } from './legal-documents.js';
import { createRateLimiter } from './rate-limit.js';
import { isValidIanaTimezone, localDateTimeToUtc, mysqlUtc, parseUtcInstant, zonedDateTime } from './time.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { StripeConnectService } from './stripe-connect.js';
import { TicketSales } from './ticket-sales.js';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const legalHtml = (markdown) => {
  const html = [];
  let listOpen = false;
  let codeLines = null;
  const closeList = () => { if (listOpen) { html.push('</ul>'); listOpen = false; } };
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    if (rawLine.startsWith('```')) {
      closeList();
      if (codeLines) { html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`); codeLines = null; } else codeLines = [];
      continue;
    }
    if (codeLines) { codeLines.push(rawLine); continue; }
    const line = escapeHtml(rawLine);
    if (line.startsWith('# ')) { closeList(); html.push(`<h1>${line.slice(2)}</h1>`); continue; }
    if (line.startsWith('## ')) { closeList(); html.push(`<h2>${line.slice(3)}</h2>`); continue; }
    if (line.startsWith('### ')) { closeList(); html.push(`<h3>${line.slice(4)}</h3>`); continue; }
    if (line.startsWith('- ')) { if (!listOpen) { html.push('<ul>'); listOpen = true; } html.push(`<li>${line.slice(2)}</li>`); continue; }
    closeList();
    if (line.trim()) html.push(`<p>${line.replace(/^&gt;\s?/, '')}</p>`);
  }
  closeList();
  if (codeLines) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return html.join('\n');
};

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
    this.stripe = new StripeConnectService(config.runtime.stripe);
    this.subscriptions = new OrganizerSubscriptions({ queries, stripe: this.stripe, siteUrl: config.site.siteUrl });
    this.articlePublishing = new ArticlePublishing(queries);
    this.ticketSales = new TicketSales({ queries, stripe: this.stripe, emailService, siteUrl: config.site.siteUrl });
  }

  registerPaymentWebhooks(app) {
    // This route must be registered with an express.raw parser before the
    // application's JSON parser. Stripe signatures cover the exact bytes.
    app.post('/api/payment-webhooks/stripe', async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const event = this.stripe.verifyWebhook(rawBody, req.get('stripe-signature'));
      if (!event) return res.status(400).json({ error: 'Invalid Stripe webhook signature.' });
      try {
        await this.queries.initialize();
        if (await this.subscriptions.webhook(event)) return res.json({ received: true });
        const object = event.data?.object;
        if (object?.metadata?.ticketOrderId && event.type.startsWith('checkout.session.')) {
          if (!event.account) return res.status(400).json({ error: 'A connected-account event is required.' });
          await this.ticketSales.confirm(Number(object.metadata.ticketOrderId), object.id, event.account);
          return res.json({ received: true });
        }
        await this.queries.processTicketProviderEvent({ provider: 'stripe', providerEventId: event.id, eventType: event.type, payload: event });
        return res.status(200).json({ received: true });
      } catch (error) { console.error('Stripe webhook processing failed:', error.message); return res.status(500).json({ error: 'Webhook processing failed.' }); }
    });
    app.post('/api/payment-webhooks/stripe/thin', async (req, res) => {
      const notification = this.stripe.verifyThinWebhook(req.body, req.get('stripe-signature'));
      if (!notification) return res.status(400).json({ error: 'Invalid Stripe thin event signature.' });
      try {
        const event = await this.stripe.stripeClient.v2.core.events.retrieve(notification.id);
        const accountId = event.related_object?.id;
        if (accountId && event.type.startsWith('v2.core.account')) {
          await this.queries.initialize();
          await this.refreshStripeAccount(accountId);
        }
        return res.json({ received: true });
      } catch (error) { console.error('Stripe account refresh failed:', error.message); return res.status(500).json({ error: 'Unable to refresh connected account.' }); }
    });
  }

  async refreshStripeAccount(accountId) {
    const account = await this.stripe.account(accountId);
    await this.queries.updatePaymentAccountCapabilities('stripe', accountId, {
      onboardingStatus: account.onboarding_status || (account.charges_enabled ? 'ready' : account.details_submitted ? 'restricted' : 'pending'),
      chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, detailsSubmitted: account.details_submitted,
    });
    return account;
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
    app.get('/api/event-statuses', (_req, res) => res.json(EVENT_STATUSES));
    app.get('/api/registration-statuses', (_req, res) => res.json(REGISTRATION_STATUSES));
    app.get('/api/invitation-statuses', (_req, res) => res.json(INVITATION_STATUSES));
    app.get('/api/participant-statuses', (_req, res) => res.json(PARTICIPANT_STATUSES));
    const companyInformation = () => {
      const operator = this.config.operator || {};
      return {
        legalOperatorName: operator.name || null,
        organizationNumber: operator.organisationNumber || null,
        vatNumber: operator.vatNumber || null,
        registeredAddress: operator.registeredAddress || null,
        supportEmail: operator.supportEmail || operator.email || null,
        privacyEmail: operator.privacyEmail || operator.email || null,
        moderationEmail: operator.moderationEmail || operator.email || null,
        country: operator.country || null,
      };
    };
    const publishedSubprocessors = () => Array.isArray(this.config.legal?.subprocessors) ? this.config.legal.subprocessors : [];
    app.get('/api/legal-documents', (_req, res) => res.json(legalDocumentIndex()));
    app.get('/api/legal-documents/:slug', async (req, res) => {
      try {
        const document = await legalDocument(req.params.slug, this.config);
        if (!document) return res.status(404).json({ error: 'Legal document not found.' });
        return res.json(document);
      } catch (error) { console.error('Legal document load failed:', error.message); return res.status(500).json({ error: 'Unable to load legal document.' }); }
    });
    app.get('/api/company', (_req, res) => res.json(companyInformation()));
    app.get('/api/subprocessors', (_req, res) => res.json({ subprocessors: publishedSubprocessors() }));
    const publicFooter = '<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a><a href="/paid-services">Paid Services</a><a href="/community-guidelines">Community Guidelines</a><a href="/organizer-terms">Organizer Terms</a><a href="/venue-terms">Venue Terms</a><a href="/tickets-refunds">Tickets &amp; Refunds</a><a href="/marketplace-transparency">Marketplace Transparency</a><a href="/report">Report</a><a href="/appeal">Appeal</a><a href="/contact">Contact</a><a href="/company">Company information</a></footer>';
    const publicPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(this.config.site.brandName)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.55;margin:0;color:#172033;background:#f7f8fa}main{max-width:840px;margin:2rem auto;padding:2rem;background:#fff;border-radius:12px}footer{display:flex;flex-wrap:wrap;gap:1rem;margin-top:3rem;padding-top:1rem;border-top:1px solid #ddd}label,input,select,textarea,button{display:block;width:100%;box-sizing:border-box;margin:.5rem 0}input,select,textarea,button{padding:.7rem}textarea{min-height:9rem}</style></head><body><main>${body}${publicFooter}</main></body></html>`;
    for (const slug of legalDocumentIndex().map((document) => document.slug)) app.get(`/${slug}`, async (_req, res) => { try { const document = await legalDocument(slug, this.config); const metadata = `<header><p>Last updated: ${escapeHtml(document.lastUpdated || 'Not stated')}</p><p>Current version: ${escapeHtml(document.version)}</p></header>`; return res.type('html').send(publicPage(document.title, `<article>${metadata}${legalHtml(document.content)}</article>`)); } catch { return res.status(500).type('html').send(publicPage('Unavailable', '<h1>Document unavailable</h1>')); } });
    app.get('/company', (_req, res) => {
      const company = companyInformation();
      const value = (label, content) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(content || 'Not currently published')}</dd>`;
      return res.type('html').send(publicPage('Company information', `<article><h1>Company information</h1><dl>${value('Legal operator', company.legalOperatorName)}${value('Organisation number', company.organizationNumber)}${value('VAT number', company.vatNumber)}${value('Registered address', company.registeredAddress)}${value('Support email', company.supportEmail)}${value('Privacy contact', company.privacyEmail)}${value('Moderation contact', company.moderationEmail)}${value('Country of establishment', company.country)}</dl></article>`));
    });
    app.get('/subprocessors', (_req, res) => {
      const items = publishedSubprocessors().map((provider) => `<li>${escapeHtml(typeof provider === 'string' ? provider : provider.name || 'Unnamed provider')}</li>`).join('');
      return res.type('html').send(publicPage('Subprocessors', `<article><h1>Service providers and subprocessors</h1>${items ? `<ul>${items}</ul>` : '<p>No provider inventory has been published yet. This must be completed before commercial launch.</p>'}</article>`));
    });
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
    app.post('/api/invitations/respond', async (req, res) => { const { token, action } = req.body; const status = action === 'accept' ? 'Accepted' : action === 'decline' ? 'Declined' : null; if (!token || !status) return res.status(400).json({ error: 'A valid invitation token and action are required.' }); try { await ensureTable(); const invitation = status === 'Accepted' ? await this.queries.acceptInvitationAsParticipant(token) : await this.queries.respondToInvitation(token, status); if (!invitation) return res.status(400).json({ error: 'Invalid, expired, or already used invitation.' }); if (invitation.alreadyRegistered) return res.status(409).json({ error: 'This email or user is already registered for this event.', eventId: invitation.eventId, participantId: invitation.participantId || null }); return res.json({ message: status === 'Accepted' ? 'Invitation accepted. Your participation is confirmed.' : 'Invitation declined.', eventId: invitation.eventId, registrationId: null, participantId: invitation.participantId || null, requiresRegistration: Boolean(invitation.requiresRegistration), status, paymentStatus: invitation.paymentStatus || null }); } catch (error) { console.error('Invitation response failed:', error.message); return res.status(500).json({ error: 'Unable to process invitation response.' }); } });
    
    const ensureTable = () => this.queries.initialize();
    const articleImageUrl = (filename) => `${this.articleFtpService.publicPath()}/${encodeURIComponent(filename)}`;
    // Public media keeps its CDN-cacheable upload URL. Protected media must
    // always use an API route so a CDN never mistakes a tokenized request for
    // a static asset and serves it without reaching this process.
    const protectedMediaUrl = (kind, filename, token) => `/api/media/${kind}/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
    const groupCoverUrl = (filename, token = null) => filename ? (token ? protectedMediaUrl('group', filename, token) : `${this.groupFtpService.publicPath()}/${encodeURIComponent(filename)}`) : null;
    const eventCoverUrl = (filename, token = null) => filename ? (token ? protectedMediaUrl('event', filename, token) : `${this.eventFtpService.publicPath()}/${encodeURIComponent(filename)}`) : null;
    // An event's cover is publicly cacheable once it is Published and Public;
    // otherwise managers and viewers of the membership-scoped attending feed get
    // a signed token. Event covers are persisted
    // as storage filenames, never deployment-specific URLs.
    const decorateEventImage = (event, viewer = {}) => {
      if (!event || !event.coverImage) return event;
      const filename = event.coverImage;
      const { userId = null, role = null } = viewer;
      const privileged = ['manager', 'admin'].includes(role);
      const isPublic = event.status === 'Published' && event.visibility === 'Public';
      const canManage = privileged || (userId != null && event.managerId === userId);
      const token = !isPublic && (canManage || viewer.attendingAccess === true) ? eventCoverToken(filename) : null;
      const url = eventCoverUrl(filename, token);
      // Never expose the persisted value as a browser source. Older clients
      // read coverImage directly, and historic rows can contain an absolute
      // localhost signed URL created during development. The resolved URL is
      // always derived from the filename and current deployment instead.
      return { ...event, coverImage: url, coverImageUrl: url, thumbnailUrl: url };
    };
    const decorateEventImages = (events, viewer) => events.map((event) => decorateEventImage(event, viewer));
    const decorateGroup = (group, viewer = {}) => {
      if (!group) return group;
      const { role = null } = viewer;
      const privileged = ['manager', 'admin'].includes(role);
      const canViewPrivate = privileged || group.isOrganizer || group.isMember;
      const needsToken = group.visibility !== 'Public' && canViewPrivate;
      if (group.coverImage) group.coverImageUrl = groupCoverUrl(group.coverImage, needsToken ? groupCoverToken(group.coverImage) : null);
      if (Array.isArray(group.events)) group.events = decorateEventImages(group.events, viewer);
      return group;
    };
    const decorateGroups = (groups, viewer) => groups.map((group) => decorateGroup(group, viewer));
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
    app.get('/api/legal-readiness', authenticate, async (req, res) => {
      if (!['manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Manager access is required.' });
      return res.json(await legalReadiness(this.config));
    });
    app.post('/api/legal-documents/:slug/accept', authenticate, async (req, res) => {
      const document = await legalDocument(req.params.slug, this.config);
      if (!document) return res.status(404).json({ error: 'Legal document not found.' });
      if (req.body?.accepted !== true) return res.status(422).json({ error: 'You must explicitly confirm acceptance.' });
      const contextType = req.body?.contextType == null ? null : String(req.body.contextType).trim();
      const contextId = req.body?.contextId == null ? null : String(req.body.contextId).trim();
      const organizationId = req.body?.organizationId == null ? null : Number(req.body.organizationId);
      const allowedContexts = new Set(['registration', 'organization', 'event', 'venue', 'booking', 'platform_order', 'subscription']);
      if (contextType && !allowedContexts.has(contextType)) return res.status(422).json({ error: 'Legal acceptance context is invalid.' });
      if (organizationId != null && (!Number.isInteger(organizationId) || organizationId < 1)) return res.status(422).json({ error: 'Organization context is invalid.' });
      try {
        await ensureTable();
        if (organizationId != null && !['manager', 'admin'].includes(req.user.role)) {
          const membership = await this.queries.organizationMember(organizationId, req.user.id);
          if (!membership || !['owner', 'admin', 'manager'].includes(membership.role)) return res.status(403).json({ error: 'You are not authorized to accept terms for this organization.' });
        }
        const acceptance = await this.queries.recordLegalAcceptance(req.user.id, document, { source: 'account', contextType, contextId, organizationId });
        await this.queries.audit(req.user.id, 'legal_document_accepted', 'legal_document', document.documentType, JSON.stringify({ version: document.version, contextType, contextId, organizationId, created: acceptance.created }));
        return res.status(acceptance.created ? 201 : 200).json({ documentType: document.documentType, version: document.version, acceptedAt: acceptance.acceptedAt, created: acceptance.created });
      } catch (error) { console.error('Legal acceptance failed:', error.message); return res.status(500).json({ error: 'Unable to record legal acceptance.' }); }
    });
    // A browser cannot send an Authorization header when loading <img src>, so
    // an image that is not publicly visible is addressed with a short-lived
    // token bound to one filename. Each resource kind gets its own namespace
    // so these tokens are never interchangeable across venues/groups/events,
    // or with session or unsubscribe tokens.
    const imageTokenTtlMs = 15 * 60 * 1000;
    const signImagePayload = (kind, payload) => crypto.createHmac('sha256', this.authSecret).update(`${kind}:${payload}`).digest('base64url');
    const createImageToken = (kind) => (filename) => {
      const payload = Buffer.from(JSON.stringify({ filename, exp: Date.now() + imageTokenTtlMs })).toString('base64url');
      return `${payload}.${signImagePayload(kind, payload)}`;
    };
    const validateImageToken = (kind, token, filename) => {
      const [payload, signature] = String(token || '').split('.');
      if (!payload || !signature) return { valid: false, expired: false };
      const expected = signImagePayload(kind, payload);
      // timingSafeEqual throws on a length mismatch, so compare lengths first.
      if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { valid: false, expired: false };
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (data.filename !== filename) return { valid: false, expired: false };
        return { valid: data.exp > Date.now(), expired: data.exp <= Date.now() };
      } catch { return { valid: false, expired: false }; }
    };
    const venueImageToken = createImageToken('venue-image');
    const groupCoverToken = createImageToken('group-cover');
    const eventCoverToken = createImageToken('event-cover');
    // Public upload routes deliberately do not honour image tokens. They are
    // only storage/public-CDN endpoints; protected bytes are served below.
    const imageNotFound = (req, res, label, message, reason, extra = {}) => {
      console.warn(`${label} image request denied.`, { requestId: req.mediaRequestId || null, filename: req.params.filename, reason, tokenPresent: Boolean(req.query.token), userId: req.user?.id ?? null, role: req.user?.role ?? null, ...extra });
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ error: message });
    };
    const mediaRequestId = () => crypto.randomBytes(12).toString('hex');
    const redactedMediaUrl = (url) => String(url || '')
      .replace(/(\/api\/media\/(?:event|venue|group)\/)[^/?]+(?=\/)/i, '$1[TOKEN]')
      .replace(/([?&]token=)[^&]*/gi, '$1[present]');
    const attachMediaResponseLog = (req, res, details) => {
      res.once('finish', () => console.info('Media response completed.', {
        requestId: req.mediaRequestId,
        route: redactedMediaUrl(req.path),
        originalUrl: redactedMediaUrl(req.originalUrl || req.url),
        filename: req.params.filename,
        tokenPresent: Boolean(req.mediaTokenPresent ?? req.query.token),
        status: res.statusCode,
        location: res.getHeader('location') || null,
        contentType: res.getHeader('content-type') || null,
        cacheControl: res.getHeader('cache-control') || null,
        ...details(),
      }));
    };
    const mediaAccess = async ({ req, tokenKind, visible, allowSignedToken }) => {
      const tokenPresent = allowSignedToken && Boolean(req.mediaToken);
      const token = allowSignedToken ? validateImageToken(tokenKind, req.mediaToken, req.params.filename) : { valid: false, expired: false };
      const access = {
        publicAccess: false,
        signedTokenAccess: token.valid,
        authenticatedUserAccess: false,
        adminAccess: false,
      };
      // A supplied but invalid token is never silently ignored, even if the
      // caller also has credentials. This keeps signature failures observable
      // and prevents a malformed signed URL from changing authorization flow.
      if (tokenPresent && !token.valid) return { access, tokenPresent, token, media: null, allowed: false, authorizationReason: 'invalid-signed-media-token' };

      // A valid signed token is a capability for precisely this filename. It
      // must survive all later work; no visibility lookup may overwrite it.
      const media = token.valid ? null : await visible(req.params.filename, req.user?.id ?? null, req.user?.role ?? null);
      access.publicAccess = Boolean(media?.publiclyVisible);
      if (media && req.user && !access.publicAccess) {
        access.adminAccess = ['manager', 'admin'].includes(req.user.role);
        access.authenticatedUserAccess = !access.adminAccess;
      }
      const allowed = access.publicAccess || access.signedTokenAccess || access.authenticatedUserAccess || access.adminAccess;
      const authorizationReason = access.signedTokenAccess ? 'signed-media-token'
        : access.publicAccess ? 'public-media'
          : access.adminAccess ? 'administrator'
            : access.authenticatedUserAccess ? 'authenticated-user'
              : 'denied';
      return { access, tokenPresent, token, media, allowed, authorizationReason };
    };
    const publicMediaRoute = ({ route, label, visible, stream, message }) => app.get(route, async (req, res) => {
      req.mediaRequestId = mediaRequestId();
      attachMediaResponseLog(req, res, () => ({ mediaType: label, authorizationSurface: 'public-uploads' }));
      try {
        await ensureTable();
        // Do not use supplied credentials or tokens here: /uploads is public
        // only, and private media must be requested through /api/media.
        const result = await mediaAccess({ req, tokenKind: null, visible: (...args) => visible(args[0], null, null), allowSignedToken: false });
        if (!result.access.publicAccess) return imageNotFound(req, res, label, message, 'not-public');
        if (!await stream(req.params.filename, res)) return imageNotFound(req, res, label, message, 'missing-from-storage');
      } catch (error) {
        console.error(`${label} public image proxy failed:`, error.message);
        if (!res.headersSent) { res.set('Cache-Control', 'no-store'); return res.status(502).json({ error: 'Unable to load image.' }); }
      }
    });
    const logProtectedMedia = (req, details) => console.info('Protected media request.', {
      route: redactedMediaUrl(req.path),
      mediaType: req.params.kind,
      filename: req.params.filename,
      requestId: req.mediaRequestId,
      tokenPresent: Boolean(req.mediaTokenPresent ?? req.query.token),
      userId: req.user?.id ?? null,
      ...details,
    });
    const protectedMediaRoute = ({ kind, tokenKind, visible, stream, message }) => {
      const handler = async (req, res) => {
      req.mediaRequestId = mediaRequestId();
      // Path tokens are the canonical format. Query tokens remain accepted
      // temporarily for existing clients, but are no longer generated.
      req.mediaToken = req.params.token || req.query.token || null;
      req.mediaTokenPresent = Boolean(req.mediaToken);
      const routeToken = validateImageToken(tokenKind, req.mediaToken, req.params.filename);
      let result = null;
      let finalAuthorization = null;
      attachMediaResponseLog(req, res, () => ({
        mediaType: kind,
        authorizationSurface: 'protected-api',
        tokenValid: result?.token.valid ?? routeToken.valid,
        tokenExpired: result?.token.expired ?? routeToken.expired,
        signedTokenAccess: result?.access.signedTokenAccess ?? routeToken.valid,
        publicAccess: result?.access.publicAccess ?? false,
        authenticatedUserAccess: result?.access.authenticatedUserAccess ?? false,
        adminAccess: result?.access.adminAccess ?? false,
        finalAuthorization: finalAuthorization ?? (result?.allowed ? 'allowed' : 'denied'),
        authorizationReason: result?.authorizationReason ?? null,
      }));
      logProtectedMedia(req, { mediaType: kind, stage: 'route-reached', tokenValid: routeToken.valid, tokenExpired: routeToken.expired, signedTokenAccess: routeToken.valid });
      try {
        // A verified, filename-bound token is the authorization capability for
        // browser image loads. Do not revalidate it after asynchronous work or
        // apply event visibility rules that require a logged-in user.
        if (routeToken.valid) {
          result = {
            access: { publicAccess: false, signedTokenAccess: true, authenticatedUserAccess: false, adminAccess: false },
            tokenPresent: true,
            token: routeToken,
            media: null,
            allowed: true,
            authorizationReason: 'signed-media-token',
          };
          finalAuthorization = 'allowed';
          // Vary does not commit the response. streamImage sets the success
          // cache/content headers only after its FTP transfer completes.
          res.set('Vary', 'Authorization');
          if (!await stream(req.params.filename, res, 'private, no-store, max-age=0')) {
            res.set('Cache-Control', 'private, no-store, max-age=0');
            logProtectedMedia(req, { mediaType: kind, tokenValid: true, tokenExpired: false, ...result.access, finalAuthorization: 'allowed', authorization: 'allowed', authorizationReason: result.authorizationReason, status: 404, denialBranch: 'missing-from-storage' });
            return res.status(404).json({ error: message });
          }
          logProtectedMedia(req, { mediaType: kind, tokenValid: true, tokenExpired: false, ...result.access, finalAuthorization: 'allowed', authorization: 'allowed', authorizationReason: result.authorizationReason, status: 200 });
          return;
        }
        await ensureTable();
        result = await mediaAccess({ req, tokenKind, visible, allowSignedToken: true });
        const privateResponse = result.access.signedTokenAccess || !result.access.publicAccess;
        if (!result.allowed) {
          res.set({ 'Cache-Control': privateResponse ? 'private, no-store, max-age=0' : 'public, max-age=86400', Vary: 'Authorization' });
          finalAuthorization = 'denied';
          logProtectedMedia(req, { mediaType: kind, tokenValid: result.token.valid, tokenExpired: result.token.expired, ...result.access, finalAuthorization: 'denied', authorization: 'denied', authorizationReason: result.authorizationReason, status: 403, denialBranch: 'final-authorization' });
          return res.status(403).json({ error: 'Protected media access denied.' });
        }
        // Preparing Vary does not send a response; the FTP service commits
        // Cache-Control, Content-Type, and 200 only after it has the bytes.
        res.set('Vary', 'Authorization');
        if (!await stream(req.params.filename, res, privateResponse ? 'private, no-store, max-age=0' : undefined)) {
          res.set('Cache-Control', privateResponse ? 'private, no-store, max-age=0' : 'public, max-age=86400');
          finalAuthorization = 'allowed';
          logProtectedMedia(req, { mediaType: kind, tokenValid: result.token.valid, tokenExpired: result.token.expired, ...result.access, finalAuthorization: 'allowed', authorization: 'allowed', authorizationReason: result.authorizationReason, status: 404, denialBranch: 'missing-from-storage' });
          return res.status(404).json({ error: message });
        }
        finalAuthorization = 'allowed';
        logProtectedMedia(req, { mediaType: kind, tokenValid: result.token.valid, tokenExpired: result.token.expired, ...result.access, finalAuthorization: 'allowed', authorization: 'allowed', authorizationReason: result.authorizationReason, status: 200 });
      } catch (error) {
        console.error(`${kind} protected media proxy failed:`, error.message);
        if (!res.headersSent) {
          finalAuthorization = 'error';
          res.set('Cache-Control', 'private, no-store, max-age=0');
          logProtectedMedia(req, {
            mediaType: kind,
            tokenValid: result?.token.valid ?? routeToken.valid,
            tokenExpired: result?.token.expired ?? routeToken.expired,
            ...(result?.access || {}),
            finalAuthorization,
            authorization: 'error',
            authorizationReason: 'internal-error',
            status: 502,
            denialBranch: 'internal-error'
          });
          return res.status(502).json({ error: 'Unable to load image.' });
        }
      }
      };
      app.get(`/api/media/${kind}/:token/:filename`, optionalAuthenticate, handler);
      app.get(`/api/media/${kind}/:filename`, optionalAuthenticate, handler);
    };
    const mediaVisibility = (method) => (...args) => this.queries[method](...args);
    const mediaStream = (service, method) => (...args) => service[method](...args);
    publicMediaRoute({ route: venueUploadRoute, label: 'Venue', visible: mediaVisibility('venueImageVisible'), stream: mediaStream(this.venueFtpService, 'streamVenueImage'), message: 'Image not found.' });
    publicMediaRoute({ route: eventUploadRoute, label: 'Event', visible: mediaVisibility('eventCoverVisible'), stream: mediaStream(this.eventFtpService, 'streamEventCover'), message: 'Image not found.' });
    protectedMediaRoute({ kind: 'venue', tokenKind: 'venue-image', visible: mediaVisibility('venueImageVisible'), stream: mediaStream(this.venueFtpService, 'streamVenueImage'), message: 'Image not found.' });
    protectedMediaRoute({ kind: 'event', tokenKind: 'event-cover', visible: mediaVisibility('eventCoverVisible'), stream: mediaStream(this.eventFtpService, 'streamEventCover'), message: 'Image not found.' });
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
    publicMediaRoute({ route: groupUploadRoute, label: 'Group cover', visible: mediaVisibility('groupForCover'), stream: mediaStream(this.groupFtpService, 'streamGroupCover'), message: 'Group cover not found.' });
    protectedMediaRoute({ kind: 'group', tokenKind: 'group-cover', visible: mediaVisibility('groupForCover'), stream: mediaStream(this.groupFtpService, 'streamGroupCover'), message: 'Group cover not found.' });
    app.get(articleUploadRoute, optionalAuthenticate, async (req, res) => { try { await ensureTable(); if (!this.articleFtpService || !await this.queries.articleImageVisible(req.params.filename, req.user?.id ?? null, req.user?.role ?? null) || !await this.articleFtpService.streamArticleImage(req.params.filename, res)) return res.status(404).json({ error: 'Article image not found.' }); } catch (error) { console.error('Article image proxy failed:', error.message); if (!res.headersSent) return res.status(502).json({ error: 'Unable to load article image.' }); } });
    const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' });
    // Any registered role can manage the events it owns.  Managers and admins
    // retain their broader access through the ownership checks in Queries.
    const requirePlatformStaff = (req, res, next) => ['admin', 'manager'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Administrator or manager access required.' });
    const requireManager = (req, res, next) => ['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Event-management access required.' });
    // Events, like groups, can be created by any verified account.  The
    // database ownership checks on the individual operations ensure a user
    // can only administer events they created (unless they are a manager/admin).
    const requireVerifiedUser = (req, res, next) => req.user.isEmailConfirmed ? next() : res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address to continue.' });
    registerSubscriptionRoutes(app, { service: this.subscriptions, authenticate, requireVerifiedUser, initialize: ensureTable });
    // Reject paid-product writes server-side, including direct API clients.
    app.use('/api', async (req, res, next) => {
      if (!['POST','PUT','PATCH'].includes(req.method)) return next();
      const path = req.path.replace(/\/+$/, '').toLowerCase(), body = req.body || {};
      const eventWrite = /^\/(?:groups\/[^/]+\/)?events(?:\/[^/]+)?(?:\/drafts)?$/.test(path);
      const ticketWrite = /^\/events\/[^/]+\/(?:payment-settings|ticket-types|ticket-checkout)$/.test(path);
      const resumeCheckout = /^\/ticket-orders\/[^/]+\/checkout$/.test(path);
      const venueWrite = /^\/venues(?:\/[^/]+)?(?:\/booking-settings)?$/.test(path);
      try {
        if (resumeCheckout || (eventWrite && (body.pricingType === 'paid' || Number(body.fee) > 0)) || (ticketWrite && (Number(body.price) > 0 || body.paymentsEnabled || body.ticketSalesEnabled || path.endsWith('/ticket-checkout')))) {
          await ensureTable(); await this.subscriptions.access.requirePaidFeature('paidEventsEnabled');
        }
        if (venueWrite && ['priceFrom','hourlyRate','dailyRate'].some(key => Number(body[key]) > 0)) {
          await ensureTable(); await this.subscriptions.access.requirePaidFeature('paidVenuesEnabled');
        }
        return next();
      } catch (error) { return res.status(error.status || 503).json({ code: error.code, error: error.status ? error.message : 'Product configuration is unavailable.' }); }
    });

    const requireRoleManager = (req, res, next) => ['manager', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Manager access required.' });
    // Venue access is governed by organization membership and the ownership
    // checks in Queries.
    const requireVenueOwner = (req, res, next) => req.user.isEmailConfirmed ? next() : res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before managing venues.' });
    const supportedTimezone = isValidIanaTimezone;
    const venueSlug = (value) => String(value || '').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const venueData = (body, existing = {}) => {
      const nullableNumber = (value, fallback = null) => value === '' || value === null ? null : (value === undefined ? fallback : Number(value));
      const list = (value, fallback = []) => value === undefined ? fallback : (Array.isArray(value) ? [...new Set(value.map(venueSlug).filter(Boolean))] : null);
      const data = {
        organizationId: nullableNumber(body.organizationId, existing.organizationId ?? null),
        billingProfileId: nullableNumber(body.billingProfileId, existing.billingProfileId ?? null),
        name: String(body.name ?? existing.name ?? '').trim(),
        slug: venueSlug(body.slug ?? existing.slug ?? body.name ?? existing.name),
        logoImage: body.logoImage === undefined ? existing.logoImage || null : body.logoImage || null,
        businessName: String(body.businessName ?? existing.businessName ?? '').trim() || null,
        shortDescription: String(body.shortDescription ?? existing.shortDescription ?? '').trim() || null,
        description: String(body.description ?? existing.description ?? '').trim() || null,
        country: String(body.country ?? existing.country ?? '').trim() || null,
        city: String(body.city ?? existing.city ?? '').trim() || null,
        municipality: String(body.municipality ?? existing.municipality ?? '').trim() || null,
        region: String(body.region ?? existing.region ?? '').trim() || null,
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
      if (data.organizationId !== null && (!Number.isInteger(data.organizationId) || data.organizationId < 1)) errors.organizationId = 'A valid organization is required.';
      if (data.billingProfileId !== null && (!Number.isInteger(data.billingProfileId) || data.billingProfileId < 1)) errors.billingProfileId = 'A valid billing profile is required.';
      validateBranding(data, errors);
      if (data.name.length < 2 || data.name.length > 160) errors.name = 'Venue name must be between 2 and 160 characters.';
      if (!data.slug || data.slug.length > 180) errors.slug = 'Venue slug must contain letters or numbers and be at most 180 characters.';
      if (!data.formattedAddress || data.formattedAddress.length > 500) errors.formattedAddress = 'A formatted address of up to 500 characters is required.';
      if (data.businessName?.length > 160) errors.businessName = 'Business name must not exceed 160 characters.';
      if (data.shortDescription?.length > 400) errors.shortDescription = 'Short description must not exceed 400 characters.';
      if (data.latitude !== null && (!Number.isFinite(Number(data.latitude)) || Number(data.latitude) < -90 || Number(data.latitude) > 90)) errors.latitude = 'Latitude must be between -90 and 90.';
      if (data.longitude !== null && (!Number.isFinite(Number(data.longitude)) || Number(data.longitude) < -180 || Number(data.longitude) > 180)) errors.longitude = 'Longitude must be between -180 and 180.';
      if (data.countryCode && !/^[A-Z]{2}$/.test(data.countryCode)) errors.countryCode = 'Country code must be a two-letter ISO code.';
      if (data.googlePlaceId?.length > 255) errors.googlePlaceId = 'Google Place ID must not exceed 255 characters.';
      if (data.formattedAddress?.length > 500) errors.formattedAddress = 'Formatted address must not exceed 500 characters.';
      if (!['exact', 'approximate', 'private'].includes(data.locationVisibility)) errors.locationVisibility = 'Invalid location visibility.';
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
    const availabilityRange = (from, to) => {
      const valid = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
      if (!valid(from) || !valid(to) || from > to) return null;
      const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;
      return days <= 93 ? { from, to } : null;
    };
    const addDateDays = (date, days) => {
      const value = new Date(`${date}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    };
    const utcDateTime = mysqlUtc;
    // Owner calendars submit a venue-local date and clock time. Convert that
    // once at the API boundary; raw UTC fields remain accepted for API clients.
    const venueInterval = async (venueId, body) => {
      const directStart = utcDateTime(body.startAt);
      const directEnd = utcDateTime(body.endAt);
      if (directStart && directEnd) return { startAt: directStart, endAt: directEnd };
      const date = String(body.date || '');
      const venue = await this.queries.venueTimezone(venueId);
      if (!venue || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const startTime = body.allDay ? '00:00' : String(body.startTime || '');
      const endDate = body.allDay ? addDateDays(date, 1) : date;
      const endTime = body.allDay ? '00:00' : String(body.endTime || '');
      const start = localDateTimeToUtc(date, startTime, venue.timezone, 'start');
      const end = localDateTimeToUtc(endDate, endTime, venue.timezone, 'end');
      return start && end ? { startAt: mysqlUtc(start), endAt: mysqlUtc(end), timezone: venue.timezone } : null;
    };
    const bookingSettingsData = (body, existing = {}) => {
      const number = (key, fallback, nullable = false) => body[key] === undefined ? fallback : (body[key] === null || body[key] === '' ? (nullable ? null : NaN) : Number(body[key]));
      const data = { bookingMode: String(body.bookingMode ?? existing.bookingMode ?? 'hourly'), slotIncrementMinutes: number('slotIncrementMinutes', existing.slotIncrementMinutes ?? 30), minimumBookingMinutes: number('minimumBookingMinutes', existing.minimumBookingMinutes ?? 30), maximumBookingMinutes: number('maximumBookingMinutes', existing.maximumBookingMinutes ?? null, true), bufferBeforeMinutes: number('bufferBeforeMinutes', existing.bufferBeforeMinutes ?? 0), bufferAfterMinutes: number('bufferAfterMinutes', existing.bufferAfterMinutes ?? 0), minimumNoticeHours: number('minimumNoticeHours', existing.minimumNoticeHours ?? 0), maximumAdvanceDays: number('maximumAdvanceDays', existing.maximumAdvanceDays ?? 365), currency: String(body.currency ?? existing.currency ?? 'SEK').toUpperCase(), hourlyRate: number('hourlyRate', existing.hourlyRate ?? null, true), dailyRate: number('dailyRate', existing.dailyRate ?? null, true), invoiceDueDays: number('invoiceDueDays', existing.invoiceDueDays ?? 30) };
      const errors = {};
      if (!['hourly', 'daily', 'both', 'inquiry_only'].includes(data.bookingMode)) errors.bookingMode = 'Invalid booking mode.';
      for (const key of ['slotIncrementMinutes', 'minimumBookingMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'minimumNoticeHours', 'maximumAdvanceDays', 'invoiceDueDays']) if (!Number.isInteger(data[key]) || data[key] < 0) errors[key] = 'Must be a non-negative whole number.';
      if (data.slotIncrementMinutes < 1 || 1440 % data.slotIncrementMinutes) errors.slotIncrementMinutes = 'Slot increment must divide a day.';
      if (data.minimumBookingMinutes < 1) errors.minimumBookingMinutes = 'Minimum booking duration must be positive.';
      if (data.maximumBookingMinutes !== null && (!Number.isInteger(data.maximumBookingMinutes) || data.maximumBookingMinutes < data.minimumBookingMinutes)) errors.maximumBookingMinutes = 'Maximum booking duration must be at least the minimum.';
      for (const key of ['hourlyRate', 'dailyRate']) if (data[key] !== null && (!Number.isFinite(data[key]) || data[key] < 0)) errors[key] = 'Rate must be zero or positive.';
      if (!/^[A-Z]{3}$/.test(data.currency)) errors.currency = 'Currency must be a three-letter ISO code.';
      return { data, errors };
    };
    const venueFinancialSettingsData = (body, existing = {}) => {
      const nullableText = (key, max = 255) => body[key] == null || body[key] === '' ? null : String(body[key]).trim().slice(0, max) || null;
      const sellerBillingProfileId = body.sellerBillingProfileId == null || body.sellerBillingProfileId === '' ? null : Number(body.sellerBillingProfileId);
      const methods = Array.isArray(body.methods) ? [...new Set(body.methods.map(String))] : (existing.methods || []);
      const data = {
        invoiceMode: String(body.invoiceMode ?? existing.invoiceMode ?? 'ykcircle'), sellerBillingProfileId,
        paymentTermsDays: Number(body.paymentTermsDays ?? existing.paymentTermsDays ?? 30),
        taxMode: String(body.taxMode ?? existing.taxMode ?? 'no_tax'),
        defaultTaxRate: body.defaultTaxRate == null || body.defaultTaxRate === '' ? null : Number(body.defaultTaxRate),
        pricesIncludeTax: body.pricesIncludeTax === true, confirmationPolicy: String(body.confirmationPolicy ?? existing.confirmationPolicy ?? 'on_owner_approval'),
        methods, bankgiro: nullableText('bankgiro', 80), plusgiro: nullableText('plusgiro', 80), iban: nullableText('iban', 80), bic: nullableText('bic', 32),
        swishNumber: nullableText('swishNumber', 80), bankName: nullableText('bankName', 160), accountDetailsText: nullableText('accountDetailsText', 5000),
        additionalInstructions: nullableText('additionalInstructions', 5000), paymentReferenceMode: String(body.paymentReferenceMode ?? existing.paymentReferenceMode ?? 'invoice_number'),
        acceptInvoiceAuthorization: body.acceptInvoiceAuthorization === true, termsVersion: nullableText('termsVersion', 64),
      };
      const errors = {};
      if (!['ykcircle', 'external'].includes(data.invoiceMode)) errors.invoiceMode = 'Invoice mode must be ykcircle or external.';
      if (data.sellerBillingProfileId !== null && (!Number.isInteger(data.sellerBillingProfileId) || data.sellerBillingProfileId < 1)) errors.sellerBillingProfileId = 'Choose a valid seller billing profile.';
      if (!Number.isInteger(data.paymentTermsDays) || data.paymentTermsDays < 0 || data.paymentTermsDays > 365) errors.paymentTermsDays = 'Payment terms must be 0-365 days.';
      if (!['no_tax', 'configured'].includes(data.taxMode)) errors.taxMode = 'Choose no tax or a configured tax rate.';
      if (data.taxMode === 'configured' && (!Number.isFinite(data.defaultTaxRate) || data.defaultTaxRate < 0 || data.defaultTaxRate > 100)) errors.defaultTaxRate = 'Tax rate must be between 0 and 100.';
      if (!['on_owner_approval', 'after_payment'].includes(data.confirmationPolicy)) errors.confirmationPolicy = 'Invalid confirmation policy.';
      const allowedMethods = new Set(['bank_transfer', 'bankgiro', 'plusgiro', 'swish', 'cash', 'other']);
      if (methods.length > 6 || methods.some((method) => !allowedMethods.has(method))) errors.methods = 'Choose supported payment methods only.';
      if (!['invoice_number', 'custom'].includes(data.paymentReferenceMode)) errors.paymentReferenceMode = 'Invalid payment reference mode.';
      if (data.invoiceMode === 'ykcircle' && data.acceptInvoiceAuthorization && !data.termsVersion) errors.termsVersion = 'The invoicing terms version is required when accepting authorization.';
      return { data, errors };
    };
    const textField = (body, key, max = 255) => body[key] == null ? null : String(body[key]).trim().slice(0, max) || null;
    const sameSiteUrl = (value) => {
      try { return new URL(value).origin === new URL(this.config.site.siteUrl).origin; } catch { return false; }
    };
    const billingProfileData = (body) => {
      const data = Object.fromEntries(['legalName', 'organizationNumber', 'vatNumber', 'addressLine1', 'addressLine2', 'postalCode', 'city', 'country', 'billingEmail', 'phone', 'paymentInstructions'].map((key) => [key, textField(body, key, key === 'paymentInstructions' ? 5000 : 255)]));
      data.profileType = String(body.profileType || 'individual'); data.ownerOrganizationId = body.ownerOrganizationId ? Number(body.ownerOrganizationId) : null;
      data.defaultCurrency = body.defaultCurrency == null || body.defaultCurrency === '' ? null : String(body.defaultCurrency).trim().toUpperCase(); data.invoicePrefix = String(body.invoicePrefix || 'INV').trim().toUpperCase(); data.invoiceDueDays = Number(body.invoiceDueDays ?? 30); data.isDefault = Boolean(body.isDefault);
      const errors = {}; for (const key of ['legalName', 'addressLine1', 'postalCode', 'city', 'country', 'billingEmail']) if (!data[key]) errors[key] = 'This field is required.';
      if (!['individual', 'organization'].includes(data.profileType)) errors.profileType = 'Profile type must be individual or organization.';
      if (data.ownerOrganizationId && (!Number.isInteger(data.ownerOrganizationId) || data.ownerOrganizationId < 1)) errors.ownerOrganizationId = 'Choose a valid organization.';
      if (data.ownerOrganizationId && data.profileType !== 'organization') errors.profileType = 'An organization billing profile must use the organization profile type.';
      if (!data.ownerOrganizationId && data.profileType !== 'individual') errors.profileType = 'A personal billing profile must use the individual profile type.';
      if (data.billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.billingEmail)) errors.billingEmail = 'Enter a valid billing email address.';
      if (data.defaultCurrency && !/^[A-Z]{3}$/.test(data.defaultCurrency)) errors.defaultCurrency = 'Currency must be a three-letter ISO code.';
      if (!/^[A-Z0-9-]{1,20}$/.test(data.invoicePrefix)) errors.invoicePrefix = 'Invoice prefix must use 1-20 letters, digits, or hyphens.';
      if (!Number.isInteger(data.invoiceDueDays) || data.invoiceDueDays < 0 || data.invoiceDueDays > 365) errors.invoiceDueDays = 'Invoice due days must be 0-365.';
      return { data, errors };
    };
    const availabilityOverrides = (value) => {
      if (!Array.isArray(value) || value.length > 366) return { error: 'overrides must contain at most 366 dates.' };
      const seen = new Set(); const overrides = [];
      for (const item of value) { const date = String(item?.date || ''); const overrideType = String(item?.overrideType || ''); const windows = Array.isArray(item?.windows) ? item.windows.map((window) => ({ startTime: String(window?.startTime || ''), endTime: String(window?.endTime || '') })) : [];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || seen.has(date) || !['closed', 'custom'].includes(overrideType) || (overrideType === 'closed' && windows.length) || (overrideType === 'custom' && !windows.length)) return { error: 'Each override must be a unique closed date or a custom date with valid windows.' };
        const checked = venueAvailability(windows.map((window) => ({ weekday: 0, ...window }))); if (checked.error || checked.errors) return { error: 'Override windows must be non-overlapping HH:mm intervals.' };
        seen.add(date); overrides.push({ date, overrideType, windows }); }
      return { overrides };
    };
    const asStoredUtcDate = (value) => value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T').replace(/Z$/i, '')}Z`);
    const eventFitsVenueAvailability = async (event, venue) => {
      if (!event.startsAt || !event.endsAt) return { error: 'The event must have both a start and end time before it can be booked.' };
      const start = asStoredUtcDate(event.startsAt);
      const end = asStoredUtcDate(event.endsAt);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return { error: 'The event has an invalid booking time.' };
      const starts = zonedDateTime(start, venue.timezone);
      const ends = zonedDateTime(end, venue.timezone);
      if (!starts || !ends) return { error: 'The venue timezone is invalid.' };
      const startTime = starts.time;
      const endTime = ends.time;
      if (starts.seconds !== '00' || ends.seconds !== '00') return { error: 'Venue bookings must start and end on a whole minute.' };
      const date = starts.date;
      const availability = await this.queries.calculateVenueAvailability(venue.id, date, date);
      if (!availability) return { error: 'This venue is not available for booking.' };
      if (availability.bookingMode === 'daily') {
        const fullDay = (ends.date === addDateDays(date, 1) && endTime === '00:00') || (ends.date === date && endTime === '23:59');
        if (startTime !== '00:00' || !fullDay) return { error: 'This venue can only be booked for a full local day.' };
        return availability.dates[0]?.availableIntervals.length ? {} : { error: 'The venue is not available on this date.', unavailable: true };
      }
      if (starts.date !== ends.date) return { error: 'The event must start and end on the same local day at this venue.' };
      if (!availability || !['hourly', 'both'].includes(availability.bookingMode)) return { error: 'This venue does not accept hourly bookings.' };
      const durationMinutes = (end.getTime() - start.getTime()) / 60000;
      if (durationMinutes < availability.minimumBookingMinutes) return { error: `This venue requires bookings of at least ${availability.minimumBookingMinutes} minutes.` };
      if (availability.maximumBookingMinutes !== null && durationMinutes > availability.maximumBookingMinutes) return { error: `This venue allows bookings of at most ${availability.maximumBookingMinutes} minutes.` };
      const localStartMinutes = Number(starts.hour) * 60 + Number(starts.minute);
      if (durationMinutes % availability.slotIncrementMinutes || localStartMinutes % availability.slotIncrementMinutes) return { error: `Bookings must use ${availability.slotIncrementMinutes}-minute time slots.` };
      const available = availability.dates[0]?.availableIntervals.some((slot) => slot.start <= startTime && slot.end >= endTime);
      return available ? {} : { error: 'The venue is not available for the full event time.', unavailable: true };
    };
    // Collection endpoints always return an array. An empty collection is a
    // successful lookup, not a missing resource.
    // Venue image URLs are resolved server-side so no caller has to rebuild the
    // upload path. A venue awaiting moderation is only readable by the people
    // who manage it, so their URLs carry a signed token instead.
    const venueImageUrl = (filename, token = null) => token ? protectedMediaUrl('venue', filename, token) : `${this.venueFtpService.publicPath()}/${encodeURIComponent(filename)}`;
    const decorateVenueImages = (venue) => {
      if (!venue) return venue;
      const tokenFor = venue.canManage && !(venue.isActive && venue.moderationStatus === 'approved') ? venueImageToken : () => null;
      return {
        ...venue,
        coverImageUrl: venue.coverImage ? venueImageUrl(venue.coverImage, tokenFor(venue.coverImage)) : null,
        ...(venue.images ? { images: venue.images.map((image) => ({ ...image, url: venueImageUrl(image.filename, tokenFor(image.filename)) })) } : {}),
      };
    };
    const sendVenue = (res, venue, status = 200) => res.status(status).json(decorateVenueImages(venue));
    const sendVenueList = (res, venues) => res.json(venues.map(decorateVenueImages));
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
      validateBranding(body, errors);
      if (body.foodOptions != null && (!Array.isArray(body.foodOptions) || body.foodOptions.length > 12 ||
        body.foodOptions.some((option) => typeof option !== 'string' || !option.trim() || option.trim().length > 100))) {
        errors.foodOptions = 'Add up to 12 food options, each between 1 and 100 characters.';
      }
      const recurrenceResult = parseEventRecurrence(body);
      if (recurrenceResult.error) errors.recurrence = recurrenceResult.error;
      if (publishing || title) { if (title.length < 5 || title.length > 100) errors.title = 'Title must be between 5 and 100 characters.'; }
      if (publishing || body.categoryId) { if (!Number.isInteger(Number(body.categoryId))) errors.categoryId = 'A valid category is required.'; }
      if (publishing || body.typeId) { if (!Number.isInteger(Number(body.typeId))) errors.typeId = 'A valid event type is required.'; }
      const startInstant = parseUtcInstant(startsAt);
      const endInstant = endsAt ? parseUtcInstant(endsAt) : null;
      if (publishing || startsAt) { if (!startInstant) errors.startsAt = 'A start timestamp with UTC Z or an offset is required.'; }
      if (recurrenceResult.recurrence?.frequency !== 'none' && !startInstant) errors.recurrence = 'Recurring events require a UTC start timestamp.';
      if (endsAt && !endInstant) errors.endsAt = 'End must be a timestamp with UTC Z or an offset.';
      if (startInstant && endInstant && endInstant <= startInstant) errors.endsAt = 'End must be after start.';
      const pricingType = body.pricingType || (Number(body.fee || 0) > 0 ? 'paid' : 'free');
      if (!['free', 'paid'].includes(pricingType)) errors.pricingType = 'Pricing type must be free or paid.';
      if (pricingType === 'paid' && Number(body.fee || 0) <= 0) errors.fee = 'Paid events require a positive price.';
      if (pricingType === 'free' && Number(body.fee || 0) !== 0) errors.fee = 'Free events cannot have a price.';
      if (!['Public', 'Private', 'Members', 'Unlisted'].includes(body.visibility || 'Public')) errors.visibility = 'Invalid visibility.';
      const locationType = body.locationType || 'custom';
      // Draft reads expose the canonical structured location object. Publishing
      // validates that stored representation, whereas create/update requests
      // provide the equivalent explicit custom* fields.
      const locationField = (name) => body[`custom${name[0].toUpperCase()}${name.slice(1)}`] ?? body.location?.[name];
      const customLatitude = locationField('latitude');
      const customLongitude = locationField('longitude');
      const customFormattedAddress = locationField('formattedAddress');
      if (!['venue', 'custom', 'online'].includes(locationType)) errors.locationType = 'Location type must be venue, custom, or online.';
      let selectedVenue = null;
      if (locationType === 'venue') {
        if (startsAt || endsAt) {
          if (!startInstant) errors.startsAt = 'Choose and apply a venue booking start time.';
          if (!endInstant) errors.endsAt = 'Choose and apply a venue booking end time.';
        }
        const venueId = Number(body.venueId ?? body.venue?.id);
        if (!Number.isInteger(venueId) || venueId < 1) errors.venueId = 'A valid venue is required.';
        else { selectedVenue = await this.queries.eventLocationVenue(venueId); if (!selectedVenue) errors.venueId = 'The selected venue is unavailable.'; }
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
      // A venue owns booking/event wall time. A client-provided timezone is
      // ignored for venue events so a travelling organizer cannot shift it.
      const timezone = selectedVenue?.timezone || body.timezone || 'UTC';
      if (typeof Intl.supportedValuesOf !== 'function' || (timezone !== 'UTC' && !Intl.supportedValuesOf('timeZone').includes(timezone))) errors.timezone = 'Select a timezone returned by GET /api/timezones.';
      return { errors, title, startsAt, endsAt, pricingType, timezone, locationType, recurrence: recurrenceResult.recurrence || { frequency: 'none', interval: 1, count: 1 } };
    };
    const richEventData = (body, userId, validation) => {
      const locationField = (name) => body[`custom${name[0].toUpperCase()}${name.slice(1)}`];
      const text = (value, max) => value == null ? null : String(value).trim().slice(0, max) || null;
      // A cover image is managed by the event media endpoint. Store only its
      // filename, never an environment-specific URL supplied by a client.
      const coverImage = (value) => {
        const source = text(value, 1024);
        if (!source) return null;
        const filename = source.split(/[?#]/, 1)[0].split('/').pop();
        try { return filename ? decodeURIComponent(filename) : null; } catch { return filename || null; }
      };
      const isCustom = validation.locationType === 'custom';
      const custom = isCustom ? {
        addressLine1: text(locationField('addressLine1'), 255), addressLine2: text(locationField('addressLine2'), 255), postalCode: text(locationField('postalCode'), 32),
        locality: text(locationField('locality'), 120), municipality: text(locationField('municipality'), 120), region: text(locationField('region'), 120), country: text(locationField('country'), 120), countryCode: text(locationField('countryCode'), 2)?.toUpperCase() || null,
        latitude: Number(locationField('latitude')), longitude: Number(locationField('longitude')), googlePlaceId: text(locationField('googlePlaceId'), 255), formattedAddress: text(locationField('formattedAddress'), 500),
      } : {};
      return { managerId: userId, title: validation.title, brandName: body.brandName === undefined ? undefined : String(body.brandName || '').trim(), logoImage: body.logoImage === undefined ? undefined : body.logoImage || '', shortDescription: body.shortDescription?.trim() || null, description: body.description?.trim() || null, foodOptions: body.foodOptions === undefined ? undefined : (body.foodOptions || []).map((option) => option.trim()), coverImage: coverImage(body.coverImage), categoryId: body.categoryId ? Number(body.categoryId) : null, typeId: body.typeId ? Number(body.typeId) : null, locationType: validation.locationType, locationVisibility: body.locationVisibility || 'public', startsAt: mysqlUtc(validation.startsAt), endsAt: validation.endsAt ? mysqlUtc(validation.endsAt) : null, timezone: validation.timezone, cancellationPolicy: body.cancellationPolicy || null, pricingType: validation.pricingType, fee: validation.pricingType === 'free' ? 0 : Number(body.fee || 0), currency: body.currency || 'SEK', registrationType: body.registrationType || 'yaroko', externalRegistrationUrl: body.externalRegistrationUrl || null, visibility: body.visibility || 'Public', groupId: body.groupId ? Number(body.groupId) : null, recurrence: validation.recurrence, venueId: validation.locationType === 'venue' ? Number(body.venueId ?? body.venue?.id) : null, customAddressLine1: custom.addressLine1 || null, customAddressLine2: custom.addressLine2 || null, customPostalCode: custom.postalCode || null, customLocality: custom.locality || null, customMunicipality: custom.municipality || null, customRegion: custom.region || null, customCountry: custom.country || null, customCountryCode: custom.countryCode || null, customLatitude: custom.latitude ?? null, customLongitude: custom.longitude ?? null, customGooglePlaceId: custom.googlePlaceId || null, customFormattedAddress: custom.formattedAddress || null, onlineUrl: validation.locationType === 'online' ? text(body.onlineUrl, 1024) : null, onlinePlatform: validation.locationType === 'online' ? text(body.onlinePlatform, 120) : null };
    };
    const notifyGroupEventMembers = async (eventId) => { const members = await this.queries.pendingGroupEventNotifications(eventId); await Promise.all(members.map(async (member) => { if (!await this.queries.claimGroupEventNotification(eventId, member.userId)) return; try { await this.emailService.sendGroupEventNotification(member.email, member.name, { id: member.groupId, name: member.groupName }, member); } catch (emailError) { try { await this.queries.releaseGroupEventNotification(eventId, member.userId); } catch (releaseError) { console.error(`Unable to release group event notification for ${member.email}:`, releaseError.message); } console.error(`Group event notification failed for ${member.email}:`, emailError.message); } })); };
    const bookingFailure = (res, error) => {
      const failures = {
        VENUE_UNAVAILABLE: [409, 'The venue is already booked for this time. Choose another time.'],
        EVENT_ALREADY_BOOKED: [409, 'Cancel the active booking before changing the venue or booking time.'],
        BILLING_PROFILE_UNAVAILABLE: [422, 'This billing profile is no longer available to your account.'],
        INVALID_EVENT_TIME: [422, 'Choose a valid venue booking start and end time.'],
        VENUE_NOT_FOUND: [404, 'The selected venue is unavailable.'],
        EVENT_NOT_FOUND: [404, 'Event not found or not managed by you.'],
      };
      const failure = failures[error.code];
      return failure ? res.status(failure[0]).json({ code: error.code, error: failure[1] }) : null;
    };
    const createRichDraft = async (req, res, groupId = req.body.groupId) => {
      try {
        await ensureTable();
        if (groupId && (!Number.isInteger(Number(groupId)) || !await this.queries.canManageGroup(Number(groupId), req.user.id, req.user.role))) return res.status(403).json({ error: 'You can only post events in groups you manage.' });
        const validation = await validateRichEvent(req.body);
        if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event draft is invalid.', fields: validation.errors });
        const draft = richEventData({ ...req.body, groupId }, req.user.id, validation);
        const organizationId = req.body.organizerOrganizationId;
        if (organizationId != null && organizationId !== '') {
          if (!Number.isSafeInteger(Number(organizationId)) || Number(organizationId) < 1) throw accessError('INVALID_OWNER', 'Choose a valid organizer.', 422);
          await this.subscriptions.access.authorizeOwner({ type: 'organization', id: Number(organizationId) }, req.user.id);
          draft.organizerOrganizationId = Number(organizationId);
        }
        const series = await this.queries.createRichEventSeries(draft, { bookVenue: true, role: req.user.role, buyerBillingProfileId: req.body.buyerBillingProfileId });
        const event = await this.queries.richEvent(series.eventIds[0], req.user.id, req.user.role);
        const booking = draft.venueId && draft.startsAt && draft.endsAt ? await this.queries.eventVenueBooking(series.eventIds[0], req.user.id, req.user.role) : null;
        return res.status(201).json({ ...decorateEventImage(event, { userId: req.user.id, role: req.user.role }), venueBooking: booking, seriesId: series.seriesId, occurrenceIds: series.eventIds });
      } catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl });
        if (bookingFailure(res, error)) return;
        console.error('Rich event creation failed:', error);
        return res.status(500).json({ error: 'Unable to create event draft.' });
      }
    };
    app.post('/api/events/drafts', authenticate, requireVerifiedUser, ...creationGuards, (req, res) => createRichDraft(req, res));
    app.post('/api/groups/:id/events/drafts', authenticate, ...creationGuards, (req, res) => createRichDraft(req, res, req.params.id));
    app.post('/api/events/:id/cover', authenticate, parseEventCover, async (req, res) => { if (!req.file) return res.status(400).json({ error: 'A JPEG, PNG, or WebP cover image is required.' }); try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user.id, req.user.role); if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' }); const coverImage = await this.eventFtpService.uploadEventCover(req.params.id, req.file); if (!await this.queries.setEventCover(req.params.id, req.user.id, req.user.role, coverImage)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); return res.json({ coverImage }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(400).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Event image storage is not configured.' }); console.error('Event cover upload failed:', error); return res.status(502).json({ error: 'Unable to upload event cover.' }); } });
    app.patch('/api/events/:id/schedule', authenticate, async (req, res) => {
      const eventId = Number(req.params.id); const venueId = Number(req.body.venueId);
      const startsAt = utcDateTime(req.body.startsAtUtc); const endsAt = utcDateTime(req.body.endsAtUtc);
      if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(venueId) || venueId < 1 || !startsAt || !endsAt || startsAt >= endsAt) return res.status(422).json({ error: 'Venue schedule requires UTC start/end timestamps and a venue.' });
      try {
        await ensureTable();
        const venue = await this.queries.eventLocationVenue(venueId);
        if (!venue) return res.status(404).json({ error: 'Venue not found or unavailable.' });
        if (!await this.queries.updateEventSchedule(eventId, req.user.id, req.user.role, { startsAt, endsAt, venueId, timezone: venue.timezone })) return res.status(404).json({ error: 'Event not found or not managed by you.' });
        return res.json(decorateEventImage(await this.queries.richEvent(eventId, req.user.id, req.user.role), { userId: req.user.id, role: req.user.role }));
      } catch (error) { console.error('Event schedule update failed:', error.message); return res.status(500).json({ error: 'Unable to update the event schedule.' }); }
    });
    app.patch('/api/events/:id', authenticate, ...updateGuards, async (req, res) => {
      try {
        await ensureTable();
        const validation = await validateRichEvent(req.body);
        if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event draft is invalid.', fields: validation.errors });
        const draft = richEventData(req.body, req.user.id, validation);
        if ('organizerOrganizationId' in req.body) {
          const existing = await this.queries.richEvent(req.params.id, req.user.id, req.user.role);
          if (Number(existing?.organizerOrganizationId || 0) !== Number(req.body.organizerOrganizationId || 0)) throw accessError('ORGANIZER_IMMUTABLE', 'The organizing account cannot be changed after a draft is created.', 422);
        }
        if (!await this.queries.updateRichEventAndBooking(req.params.id, req.user.id, req.user.role, draft, req.body.buyerBillingProfileId)) return res.status(404).json({ error: 'Event not found or not managed by you.' });
        const event = await this.queries.richEvent(req.params.id, req.user.id, req.user.role);
        const booking = draft.venueId ? await this.queries.eventVenueBooking(req.params.id, req.user.id, req.user.role) : null;
        return res.json({ ...decorateEventImage(event, { userId: req.user.id, role: req.user.role }), venueBooking: booking });
      } catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl });
        if (bookingFailure(res, error)) return;
        console.error('Rich event update failed:', error.message);
        return res.status(500).json({ error: 'Unable to update event.' });
      }
    });
    app.post('/api/events/:id/publish', authenticate, async (req, res) => { try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user.id, req.user.role); if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' }); if (event.status === 'Completed') return res.status(409).json({ error: 'A finished event cannot be republished.' }); if ((event.venue?.id || event.venueId) && event.venueBookingStatus !== 'confirmed') return res.status(409).json({ code: 'VENUE_BOOKING_NOT_CONFIRMED', error: 'The venue owner must confirm the booking before this event can be published.' }); await this.subscriptions.access.requirePublication(req.params.id, req.user.id, req.user.role); const validation = await validateRichEvent(event, { publishing: true }); if (!event.coverImage) validation.errors.coverImage = 'A cover image is required before publication.'; if (!event.categoryId || !event.typeId) validation.errors.taxonomy = 'Category and event type are required before publication.'; if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event cannot be published.', fields: validation.errors }); await this.queries.publishRichEvent(req.params.id, req.user.id, req.user.role); if (event.groupId && event.status !== 'Published') await notifyGroupEventMembers(req.params.id); return res.json(decorateEventImage(await this.queries.richEvent(req.params.id, req.user.id, req.user.role), { userId: req.user.id, role: req.user.role })); } catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl }); console.error('Rich event publication failed:', error.message); return res.status(500).json({ error: 'Unable to publish event.' }); } });
    app.get('/api/events', optionalAuthenticate, async (req, res) => { const categorySlug = req.query.category == null ? null : String(req.query.category).trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); if (req.query.category != null && !categorySlug) return res.status(422).json({ error: 'category must be a valid category slug.' }); try { await ensureTable(); const viewer = { userId: req.user?.id ?? null, role: req.user?.role ?? null }; return res.json(decorateEventImages(await this.queries.eventsForViewer(viewer.userId, viewer.role, { categorySlug }), viewer)); } catch (error) { console.error('Event lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load events.' }); } });
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
    app.put('/api/organizations/:id', authenticate, requireVerifiedUser, async (req, res) => {
      const id = Number(req.params.id);
      const name = String(req.body.name || '').trim(); const slug = venueSlug(req.body.slug || name);
      const websiteUrl = String(req.body.websiteUrl || '').trim() || null;
      const contactEmail = String(req.body.contactEmail || '').trim().toLowerCase() || null;
      const description = String(req.body.description || '').trim() || null; const phone = String(req.body.phone || '').trim() || null;
      if (!Number.isInteger(id) || id < 1 || name.length < 2 || name.length > 160 || !slug || slug.length > 180
        || (websiteUrl && (websiteUrl.length > 1024 || !/^https:\/\//i.test(websiteUrl)))
        || (contactEmail && (contactEmail.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)))
        || (phone && phone.length > 50) || (description && description.length > 5000)) return res.status(422).json({ error: 'Organization is invalid. Check its name, website, and contact details.' });
      try {
        await ensureTable();
        const organization = await this.queries.updateOrganization(id, req.user.id, req.user.role, { name, slug, description, websiteUrl, phone, contactEmail });
        if (!organization) return res.status(403).json({ error: 'Organization management access is required.' });
        return res.json(organization);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That organization URL name is already in use.' });
        console.error('Organization update failed:', error.message); return res.status(500).json({ error: 'Unable to update organization.' });
      }
    });
    app.get('/api/my/organizations', authenticate, async (req, res) => {
      try { await ensureTable(); return res.json(await this.queries.managedOrganizations(req.user.id, req.user.role)); }
      catch (error) { console.error('Managed organization lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load organizations.' }); }
    });
    app.put('/api/organizations/:id/members/:userId', authenticate, requireVerifiedUser, async (req, res) => { const organizationId = Number(req.params.id); const userId = Number(req.params.userId); const role = String(req.body.role || ''); if (!Number.isInteger(organizationId) || !Number.isInteger(userId) || !['owner', 'admin', 'manager', 'staff'].includes(role)) return res.status(422).json({ error: 'A valid organization member and role are required.' }); try { await ensureTable(); if (!await this.queries.setOrganizationMember(organizationId, req.user.id, req.user.role, userId, role)) return res.status(403).json({ error: 'Organization owner or admin access is required.' }); return res.json({ organizationId, userId, role }); } catch (error) { console.error('Organization member update failed:', error.message); return res.status(500).json({ error: 'Unable to update organization member.' }); } });
    app.get('/api/me/billing-profiles', authenticate, async (req, res) => {
      try { await ensureTable(); return res.json(await this.queries.billingProfiles(req.user.id, req.user.role)); }
      catch (error) { console.error('Billing profile lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load billing profiles.' }); }
    });
    app.post('/api/me/billing-profiles', authenticate, requireVerifiedUser, async (req, res) => {
      const { data, errors } = billingProfileData(req.body); if (Object.keys(errors).length) return res.status(422).json({ error: 'Billing profile is invalid.', fields: errors });
      try { await ensureTable(); const profile = await this.queries.saveBillingProfile(req.user.id, req.user.role, null, data); return profile ? res.status(201).json(profile) : res.status(403).json({ error: 'You cannot create a billing profile for this organization.' }); }
      catch (error) { console.error('Billing profile creation failed:', error.message); return res.status(500).json({ error: 'Unable to save billing profile.' }); }
    });
    app.put('/api/me/billing-profiles/:id', authenticate, requireVerifiedUser, async (req, res) => {
      const id = Number(req.params.id); const { data, errors } = billingProfileData(req.body); if (!Number.isInteger(id) || id < 1 || Object.keys(errors).length) return res.status(422).json({ error: 'Billing profile is invalid.', fields: errors });
      try { await ensureTable(); const profile = await this.queries.saveBillingProfile(req.user.id, req.user.role, id, data); return profile ? res.json(profile) : res.status(403).json({ error: 'Billing profile not found or not available to you.' }); }
      catch (error) { console.error('Billing profile update failed:', error.message); return res.status(500).json({ error: 'Unable to update billing profile.' }); }
    });
    app.delete('/api/me/billing-profiles/:id', authenticate, async (req, res) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid billing profile is required.' }); try { await ensureTable(); const result = await this.queries.archiveBillingProfile(id, req.user.id, req.user.role); if (result?.error === 'REFERENCED') return res.status(409).json({ error: 'This billing profile is referenced by financial records and cannot be archived.' }); return result ? res.status(204).end() : res.status(403).json({ error: 'Billing profile not found or not available to you.' }); } catch (error) { return res.status(500).json({ error: 'Unable to archive billing profile.' }); } });
    app.get('/api/me/billing-profiles/:id/payment-accounts', authenticate, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid billing profile is required.' });
      try {
        await ensureTable();
        const accounts = await this.queries.paymentAccounts(id, req.user.id, req.user.role);
        if (accounts === null) return res.status(403).json({ error: 'Billing profile not available to you.' });
        // Read fresh Stripe status after hosted onboarding; its redirect does not prove readiness.
        const result = await Promise.all(accounts.map(async (account) => {
          if (account.provider !== 'stripe' || !this.stripe.configured()) return account;
          const remote = await this.refreshStripeAccount(account.providerAccountId);
          return { ...account, onboardingStatus: remote.onboarding_status, chargesEnabled: remote.charges_enabled, payoutsEnabled: remote.payouts_enabled, detailsSubmitted: remote.details_submitted, requirementsStatus: remote.requirements_status, testMode: this.stripe.testMode() };
        }));
        return res.json(result);
      } catch (error) { console.error('Payment account refresh failed:', error.message); return res.status(502).json({ error: 'Unable to refresh payment accounts from Stripe. Verify that the seller account belongs to the configured Stripe environment.' }); }
    });
    app.post('/api/me/billing-profiles/:id/payment-accounts', authenticate, requireVerifiedUser, async (req, res) => {
      const profileId = Number(req.params.id); if (!Number.isInteger(profileId) || profileId < 1) return res.status(422).json({ error: 'A valid billing profile is required.' });
      if (!this.stripe.configured()) return res.status(503).json({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Connected payments are not configured.' });
      try { await ensureTable(); const profile = await this.queries.billingProfile(profileId, req.user.id, req.user.role); if (!profile) return res.status(403).json({ error: 'Billing profile not found or not available to you.' }); const stripeAccount = await this.stripe.createConnectedAccount(profile); const account = await this.queries.createPaymentAccount(profileId, req.user.id, req.user.role, { provider: 'stripe', providerAccountId: stripeAccount.id }); const base = `${this.config.site.siteUrl}/billing/payment-account`; const link = await this.stripe.createOnboardingLink(stripeAccount.id, { refreshUrl: `${base}/refresh?accountId=${account.id}`, returnUrl: `${base}/complete?accountId=${account.id}` }); return res.status(201).json({ account, onboardingUrl: this.stripe.onboardingUrl(link) }); }
      catch (error) { console.error('Stripe connected-account creation failed:', error.message); if (error.code === 'UNSUPPORTED_STRIPE_COUNTRY') return res.status(422).json({ code: error.code, error: error.message }); if (['accounts_v2_access_blocked', 'account_create_activation_required', 'connect_profile_not_submitted'].includes(error.code)) return res.status(422).json({ code: 'STRIPE_CONNECT_NOT_READY', error: 'Stripe Connect Accounts v2 is not ready for this sandbox. Activate Connect and complete the platform profile in Stripe before onboarding a seller.' }); return res.status(502).json({ error: 'Unable to start payment-account onboarding.' }); }
    });
    app.post('/api/payment-accounts/:id/onboarding-link', authenticate, async (req, res) => {
      const accountId = Number(req.params.id); if (!Number.isInteger(accountId) || accountId < 1) return res.status(422).json({ error: 'A valid payment account is required.' });
      if (!this.stripe.configured()) return res.status(503).json({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Connected payments are not configured.' });
      try { await ensureTable(); const account = await this.queries.paymentAccount(accountId, req.user.id, req.user.role); if (!account || account.provider !== 'stripe') return res.status(404).json({ error: 'Payment account not found or not available to you.' }); const stripeAccount = await this.refreshStripeAccount(account.providerAccountId); if (stripeAccount.charges_enabled) return res.json({ account: { ...account, onboardingStatus: stripeAccount.onboarding_status, chargesEnabled: true }, onboardingUrl: null }); const base = `${this.config.site.siteUrl}/billing/payment-account`; const link = await this.stripe.createOnboardingLink(account.providerAccountId, { refreshUrl: `${base}/refresh?accountId=${account.id}`, returnUrl: `${base}/complete?accountId=${account.id}` }); return res.json({ onboardingUrl: this.stripe.onboardingUrl(link) }); }
      catch (error) { console.error('Stripe onboarding link creation failed:', error.message); if (['accounts_v2_access_blocked', 'account_create_activation_required', 'connect_profile_not_submitted'].includes(error.code)) return res.status(422).json({ code: 'STRIPE_CONNECT_NOT_READY', error: 'Stripe Connect Accounts v2 is not ready for this sandbox. Activate Connect and complete the platform profile in Stripe before onboarding a seller.' }); return res.status(502).json({ error: 'Unable to create payment-account onboarding link.' }); }
    });
    app.get('/api/payment-accounts/:id/status', authenticate, async (req, res) => {
      const accountId = Number(req.params.id); if (!Number.isInteger(accountId) || accountId < 1) return res.status(422).json({ error: 'A valid payment account is required.' });
      try {
        await ensureTable(); const account = await this.queries.paymentAccount(accountId, req.user.id, req.user.role);
        if (!account || account.provider !== 'stripe') return res.status(404).json({ error: 'Payment account not found or not available to you.' });
        if (!this.stripe.configured()) return res.status(503).json({ error: 'Connected payments are not configured.' });
        const remote = await this.refreshStripeAccount(account.providerAccountId);
        return res.json({ id: account.id, testMode: this.stripe.testMode(), onboardingStatus: remote.onboarding_status, chargesEnabled: remote.charges_enabled, payoutsEnabled: remote.payouts_enabled, detailsSubmitted: remote.details_submitted, requirementsStatus: remote.requirements_status, needsOnboarding: !remote.charges_enabled });
      } catch (error) { console.error('Stripe account status lookup failed:', error.message); return res.status(502).json({ error: 'Unable to read payment-account status from Stripe.' }); }
    });
    app.get('/api/events/:id/payment-settings', authenticate, async (req, res) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid event id is required.' }); try { await ensureTable(); const settings = await this.queries.eventPaymentSettings(id, req.user.id, req.user.role); return settings ? res.json(settings) : res.json({ eventId: id, sellerBillingProfileId: null, paymentAccountId: null, paymentsEnabled: false, ticketSalesEnabled: false }); } catch (error) { return res.status(500).json({ error: 'Unable to load event payment settings.' }); } });
    app.get('/api/events/:id/financial-readiness', authenticate, async (req, res) => { const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid event id is required.' }); try { await ensureTable(); return res.json(await this.queries.eventFinancialReadiness(id, req.user.id, req.user.role)); } catch (error) { return res.status(500).json({ error: 'Unable to load event financial readiness.' }); } });
    app.put('/api/events/:id/payment-settings', authenticate, requireManager, async (req, res) => { const id = Number(req.params.id); const sellerBillingProfileId = req.body.sellerBillingProfileId == null || req.body.sellerBillingProfileId === '' ? null : Number(req.body.sellerBillingProfileId); const paymentAccountId = req.body.paymentAccountId == null || req.body.paymentAccountId === '' ? null : Number(req.body.paymentAccountId); const sellerCapacity = req.body.sellerCapacity == null || req.body.sellerCapacity === '' ? null : String(req.body.sellerCapacity); const currency = req.body.currency ? String(req.body.currency).toUpperCase() : null; const refundPolicy = req.body.refundPolicy == null ? null : req.body.refundPolicy; if (!Number.isInteger(id) || id < 1 || (sellerBillingProfileId !== null && (!Number.isInteger(sellerBillingProfileId) || sellerBillingProfileId < 1)) || (paymentAccountId !== null && (!Number.isInteger(paymentAccountId) || paymentAccountId < 1)) || (sellerCapacity !== null && !['trader', 'private'].includes(sellerCapacity)) || (currency && !/^[A-Z]{3}$/.test(currency)) || (refundPolicy !== null && (typeof refundPolicy !== 'object' || Array.isArray(refundPolicy)))) return res.status(422).json({ error: 'Payment settings are invalid.' }); try { await ensureTable(); const result = await this.queries.saveEventPaymentSettings(id, req.user.id, req.user.role, { sellerBillingProfileId, paymentAccountId, sellerCapacity, currency, refundPolicy, paymentsEnabled: Boolean(req.body.paymentsEnabled), ticketSalesEnabled: Boolean(req.body.ticketSalesEnabled) }); const messages = { EVENT_NOT_FOUND: 'Event not found or not managed by you.', SELLER_PROFILE_UNAVAILABLE: 'This billing profile is no longer available to your account.', PAYMENT_ACCOUNT_MISMATCH: 'The payment account must belong to the selected seller billing profile.', PAYMENT_ACCOUNT_NOT_READY: 'Complete payment setup before starting ticket sales.', PAYMENT_SETUP_REQUIRED: 'Select a seller billing profile and ready payment account before starting ticket sales.', SELLER_CAPACITY_REQUIRED: 'Choose whether you are selling as a trader or a private individual before starting ticket sales.' }; return result?.error ? res.status(result.error === 'EVENT_NOT_FOUND' ? 404 : 422).json({ code: result.error, error: messages[result.error] }) : res.json(result); } catch (error) { return res.status(500).json({ error: 'Unable to save event payment settings.' }); } });
    app.get('/api/events/:id/ticket-types', async (req, res) => { const eventId = Number(req.params.id); if (!Number.isInteger(eventId) || eventId < 1) return res.status(422).json({ error: 'A valid event id is required.' }); try { await ensureTable(); if (!await this.queries.ticketCheckoutContext(eventId)) return res.status(404).json({ error: 'Paid ticket sales are not available for this event.' }); return res.json(await this.queries.ticketTypes(eventId, { publicOnly: true })); } catch (error) { return res.status(500).json({ error: 'Unable to load ticket types.' }); } });
    app.get('/api/events/:id/ticket-types/manage', authenticate, async (req, res) => {
      const eventId = Number(req.params.id);
      if (!Number.isInteger(eventId) || eventId < 1) return res.status(422).json({ error: 'A valid event id is required.' });
      try {
        await ensureTable();
        const tickets = await this.queries.managedTicketTypes(eventId, req.user.id, req.user.role);
        return tickets === null ? res.status(404).json({ error: 'Event not found or not managed by you.' }) : res.json(tickets);
      } catch (error) { return res.status(500).json({ error: 'Unable to load ticket types.' }); }
    });
    app.get('/api/events/:id/ticket-checkout', async (req, res) => {
      const eventId = Number(req.params.id);
      if (!Number.isInteger(eventId) || eventId < 1) return res.status(422).json({ error: 'A valid event id is required.' });
      try {
        await ensureTable();
        const context = await this.queries.ticketCheckoutContext(eventId);
        if (!context) return res.status(404).json({ error: 'Ticket sales are not open yet. The organizer must finish payment setup and open ticket sales.' });
        if (!this.stripe.configured()) return res.status(503).json({ error: 'Ticket payments are not configured. Set STRIPE_SECRET_KEY on the API server.' });
        return res.json({ eventId, title: context.title, currency: context.paymentCurrency || context.currency, seller: { legalName: context.seller.legalName, capacity: context.seller.capacity }, refundPolicy: context.refundPolicy, tickets: await this.queries.ticketTypes(eventId, { publicOnly: true }), paymentProvider: 'stripe', testMode: this.stripe.testMode() });
      } catch (error) { return res.status(500).json({ error: 'Unable to load ticket checkout.' }); }
    });
    app.post('/api/events/:id/ticket-types', authenticate, requireManager, async (req, res) => { const eventId = Number(req.params.id); const ticket = { name: String(req.body.name || '').trim(), description: req.body.description == null ? null : String(req.body.description).trim() || null, price: Number(req.body.price), currency: String(req.body.currency || '').toUpperCase(), quantityAvailable: req.body.quantityAvailable == null || req.body.quantityAvailable === '' ? null : Number(req.body.quantityAvailable), salesStartAt: req.body.salesStartAt || null, salesEndAt: req.body.salesEndAt || null, isActive: req.body.isActive !== false }; if (!Number.isInteger(eventId) || eventId < 1 || !ticket.name || ticket.name.length > 160 || !Number.isFinite(ticket.price) || ticket.price < 0 || !/^[A-Z]{3}$/.test(ticket.currency) || (ticket.quantityAvailable !== null && (!Number.isInteger(ticket.quantityAvailable) || ticket.quantityAvailable < 1))) return res.status(422).json({ error: 'Ticket type is invalid.' }); try { await ensureTable(); const result = await this.queries.saveTicketType(eventId, req.user.id, req.user.role, null, ticket); return result ? res.status(201).json(result) : res.status(404).json({ error: 'Event not found or not managed by you.' }); } catch (error) { return res.status(500).json({ error: 'Unable to save ticket type.' }); } });
    app.post('/api/events/:id/ticket-checkout', authenticate, requireVerifiedUser, async (req, res) => {
      const eventId = Number(req.params.id);
      const selections = Array.isArray(req.body.items) ? req.body.items : [];
      const checkoutKey = String(req.body.checkoutKey || '');
      if (!Number.isInteger(eventId) || eventId < 1 || !selections.length || selections.length > 10 ||
        selections.some((item) => !item || !Number.isInteger(item.ticketTypeId) || item.ticketTypeId < 1 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) ||
        !/^[a-zA-Z0-9_-]{16,100}$/.test(checkoutKey)) return res.status(422).json({ error: 'Choose valid tickets and retry checkout.' });
      if (!this.stripe.configured()) return res.status(503).json({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Set STRIPE_SECRET_KEY on the API server to enable ticket payments.' });
      try {
        await ensureTable();
        const context = await this.queries.ticketCheckoutContext(eventId);
        if (!context || context.provider !== 'stripe') return res.status(422).json({ code: 'PAYMENT_SETUP_REQUIRED', error: 'Ticket payments are not available for this event.' });
        const seller = await this.refreshStripeAccount(context.providerAccountId);
        if (!seller.charges_enabled) return res.status(422).json({ error: 'The organizer must complete Stripe onboarding before selling tickets.' });
        const order = await this.queries.createTicketOrder(eventId, { userId: req.user.id, email: req.user.email }, selections, checkoutKey);
        if (order.error) return res.status(422).json({ code: order.error, error: 'Selected tickets are unavailable or sales have ended. Refresh and choose available tickets.' });
        if (order.paymentStatus !== 'pending') return res.status(409).json({ error: 'This checkout is already completed or expired. Check My tickets before starting another purchase.', orderId: order.id });
        // Return destinations are generated by the server and contain only this buyer's order.
        const successUrl = `${this.config.site.siteUrl}/tickets/${order.id}?checkout=success`;
        const cancelUrl = `${this.config.site.siteUrl}/tickets/${order.id}?checkout=cancelled`;
        const existing = await this.ticketSales.checkoutOrder(order.id);
        const checkout = existing?.checkoutSessionId
          ? await this.stripe.checkoutSession(existing.checkoutSessionId, existing.providerAccountId)
          : await this.stripe.createDirectCheckout({ order, context, successUrl, cancelUrl });
        if (!checkout.url || checkout.status === 'expired') return res.status(409).json({ error: 'Checkout has expired. Start a new purchase.' });
        await this.ticketSales.attachCheckout(order.id, checkout);
        return res.status(201).json({ orderId: order.id, orderNumber: order.orderNumber, checkoutUrl: checkout.url, testMode: this.stripe.testMode() });
      } catch (error) { console.error('Stripe ticket checkout failed:', error.message); return res.status(502).json({ error: this.stripe.testMode() ? 'Unable to start test checkout. Check the sandbox API key, connected account onboarding, and ticket currency on the server.' : 'Unable to start ticket checkout. Please try again.' }); }
    });
    app.get('/api/me/representative-events', authenticate, async (req, res) => {
      try { await ensureTable(); return res.json(await this.queries.representativeEvents(req.user.id)); }
      catch { return res.status(500).json({ error: 'Unable to load assigned events.' }); }
    });
    app.get('/api/events/:id/check-in', authenticate, async (req, res) => {
      const eventId = Number(req.params.id);
      if (!Number.isSafeInteger(eventId) || eventId < 1) return res.status(422).json({ error: 'A valid event id is required.' });
      try {
        await ensureTable();
        const event = await this.queries.eventCheckInContext(eventId, req.user.id, req.user.role);
        return event ? res.json(event) : res.status(403).json({ error: 'Ticket check-in is unavailable. Ask the event organizer to assign you as a representative.' });
      } catch { return res.status(500).json({ error: 'Unable to load ticket check-in.' }); }
    });
    const representatives = (action) => async (req, res) => {
      const eventId = Number(req.params.id);
      const userId = Number(req.params.userId);
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      if (!Number.isSafeInteger(eventId) || eventId < 1 || (action === 'remove' && (!Number.isSafeInteger(userId) || userId < 1)) ||
          (action === 'add' && (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) return res.status(422).json({ error: 'Provide a valid event and representative email or user id.' });
      try {
        await ensureTable();
        const result = await this.queries.manageEventRepresentatives(eventId, req.user.id, req.user.role, { action, email, userId });
        const failures = {
          EVENT_NOT_MANAGED: [403, 'Only the event organizer or a manager can manage representatives.'],
          VERIFIED_ACCOUNT_REQUIRED: [422, 'This email must belong to an existing, verified YKCircle account. Ask the person to register and verify their email first.'],
          ALREADY_MANAGER: [409, 'This person already has full management access to this event.'],
        };
        if (result.error) { const [status, error] = failures[result.error] || [409, 'Unable to update representatives.']; return res.status(status).json({ code: result.error, error }); }
        return res.status(action === 'add' && !result.alreadyAssigned ? 201 : 200).json(result);
      } catch { return res.status(500).json({ error: 'Unable to manage event representatives.' }); }
    };
    app.get('/api/events/:id/representatives', authenticate, representatives('list'));
    app.post('/api/events/:id/representatives', authenticate, representatives('add'));
    app.delete('/api/events/:id/representatives/:userId', authenticate, representatives('remove'));
    app.post('/api/events/:id/tickets/check-in', authenticate, async (req, res) => {
      const eventId = Number(req.params.id);
      const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      if (!Number.isSafeInteger(eventId) || eventId < 1 || !/^YK-[A-F0-9]{32}$/.test(code)) return res.status(422).json({ error: 'Scan a ticket QR code or enter a valid ticket code.' });
      try {
        await ensureTable();
        const result = await this.queries.checkInTicket(eventId, req.user.id, req.user.role, code);
        const failures = {
          EVENT_NOT_MANAGED: [403, 'Only the event organizer, an assigned representative, or a manager can check in tickets.'],
          EVENT_NOT_OPEN: [409, 'Tickets cannot be checked in for an unpublished, cancelled, or archived event.'],
          TICKET_NOT_FOUND: [404, 'This ticket was not found for this event. Check that you are scanning the correct event’s ticket.'],
          TICKET_NOT_PAID: [409, 'This ticket is not valid for admission. Its payment is unpaid, refunded, cancelled, or disputed.'],
          ATTENDEE_UNAVAILABLE: [409, 'This ticket no longer has an available participant.'],
          REGISTRATION_INACTIVE: [409, 'This participant’s registration has been cancelled, declined, or withdrawn.'],
        };
        if (result.error) { const [status, error] = failures[result.error] || [409, 'Unable to check in this ticket.']; return res.status(status).json({ code: result.error, error }); }
        return res.json(result);
      } catch (error) { console.error('Ticket check-in failed:', error.message); return res.status(500).json({ error: 'Unable to check in the ticket. Please try again.' }); }
    });
    app.get('/api/me/tickets', authenticate, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.ticketOrdersForAttendee(req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load tickets.' }); } });
    app.get('/api/ticket-orders/:id', authenticate, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid ticket order is required.' });
      try {
        await ensureTable();
        const order = await this.queries.ticketOrder(id, req.user.id, req.user.role);
        res.set('Cache-Control', 'private, no-store');
        return order ? res.json(await this.ticketSales.details(order)) : res.status(404).json({ error: 'Ticket order not found or not available to you.' });
      } catch (error) { return res.status(500).json({ error: 'Unable to load ticket order.' }); }
    });
    app.post('/api/ticket-orders/:id/confirm', authenticate, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid ticket order is required.' });
      try {
        await ensureTable();
        const order = await this.queries.ticketOrder(id, req.user.id, req.user.role);
        if (!order || Number(order.attendeeUserId) !== Number(req.user.id)) return res.status(404).json({ error: 'Ticket order not found.' });
        if (!this.stripe.configured()) return res.status(503).json({ error: 'Ticket payments are not configured.' });
        await this.ticketSales.confirm(id);
        res.set('Cache-Control', 'private, no-store');
        return res.json(await this.ticketSales.details(await this.queries.ticketOrder(id, req.user.id, req.user.role)));
      } catch (error) { console.error('Ticket confirmation failed:', error.message); return res.status(502).json({ error: 'Payment confirmation is still pending. Your tickets will be emailed after Stripe confirms payment.' }); }
    });
    app.post('/api/ticket-orders/:id/resend', authenticate, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid ticket order is required.' });
      try {
        await ensureTable();
        const order = await this.queries.ticketOrder(id, req.user.id, req.user.role);
        if (!order || Number(order.attendeeUserId) !== Number(req.user.id)) return res.status(404).json({ error: 'Ticket order not found.' });
        if (order.paymentStatus !== 'paid') return res.status(409).json({ error: 'Only paid tickets can be emailed.' });
        const [result] = await this.database.execute(`UPDATE ticket_email_deliveries SET sent_at=NULL,next_attempt_at=NOW()
          WHERE ticket_order_id=? AND sent_at<DATE_SUB(NOW(),INTERVAL 5 MINUTE)`, [id]);
        if (!result.affectedRows) return res.status(429).json({ error: 'Your email is already queued or was sent recently. Please wait five minutes.' });
        await this.ticketSales.deliver(id);
        return res.json({ message: 'Your ticket email has been queued.' });
      } catch (error) { return res.status(500).json({ error: 'Unable to resend tickets.' }); }
    });
    for (const action of ['checkout', 'cancel']) app.post(`/api/ticket-orders/:id/${action}`, authenticate, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(422).json({ error: 'A valid ticket order is required.' });
      try {
        await ensureTable();
        const order = await this.ticketSales.checkoutOrder(id);
        if (!order || Number(order.attendeeUserId) !== Number(req.user.id)) return res.status(404).json({ error: 'Ticket order not found.' });
        if (order.paymentStatus !== 'pending' || !order.checkoutSessionId) return res.status(409).json({ error: 'No open Stripe checkout is available for this order.' });
        if (!this.stripe.configured()) return res.status(503).json({ error: 'Ticket payments are not configured.' });
        const session = await this.stripe.checkoutSession(order.checkoutSessionId, order.providerAccountId);
        if (action === 'checkout' && session.status === 'open') return res.json({ checkoutUrl: session.url });
        if (action === 'cancel' && session.status === 'open') {
          // Expire at Stripe before releasing stock, so the old payment link cannot charge later.
          await this.stripe.stripeClient.checkout.sessions.expire(session.id, {}, { stripeAccount: order.providerAccountId });
        }
        await this.ticketSales.confirm(id);
        return res.json({ message: 'Order status updated.' });
      } catch (error) { return res.status(502).json({ error: 'Unable to update checkout. Refresh payment status and try again.' }); }
    });
    app.post('/api/ticket-orders/:id/refunds', authenticate, async (req, res) => { const orderId = Number(req.params.id); const amount = req.body.amount == null || req.body.amount === '' ? null : Number(req.body.amount); if (!Number.isInteger(orderId) || orderId < 1 || (amount !== null && (!Number.isFinite(amount) || amount <= 0))) return res.status(422).json({ error: 'Refund request is invalid.' }); if (!this.stripe.configured()) return res.status(503).json({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Ticket payments are not configured.' }); try { await ensureTable(); const order = await this.queries.ticketRefundContext(orderId, req.user.id, req.user.role); if (!order || order.provider !== 'stripe') return res.status(404).json({ error: 'Ticket order not found or not managed by you.' }); if (order.paymentStatus !== 'paid' || !order.providerPaymentId) return res.status(409).json({ error: 'Only a paid ticket order can be refunded.' }); if (amount !== null && amount > Number(order.totalAmount)) return res.status(422).json({ error: 'Refund amount exceeds the ticket order total.' }); const refund = await this.stripe.createDirectRefund(order.providerPaymentId, order.providerAccountId, amount === null ? null : Math.round(amount * 100)); return res.status(202).json({ refundId: refund.id, status: refund.status }); } catch (error) { console.error('Stripe direct refund creation failed:', error.message); return res.status(502).json({ error: 'Unable to create organizer refund.' }); } });
    app.get('/api/invoices', authenticate, async (req, res) => {
      const venueId = req.query.venueId == null || req.query.venueId === '' ? null : Number(req.query.venueId);
      if (venueId !== null && (!Number.isInteger(venueId) || venueId < 1)) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); return res.json(await this.queries.invoicesForViewer(req.user.id, req.user.role, { venueId })); }
      catch (error) { console.error('Invoice list failed:', error.message); return res.status(500).json({ error: 'Unable to load invoices.' }); }
    });
    app.get('/api/invoices/:id', authenticate, async (req, res) => {
      const invoiceId = Number(req.params.id); if (!Number.isInteger(invoiceId) || invoiceId < 1) return res.status(422).json({ error: 'A valid invoice id is required.' });
      try { await ensureTable(); const invoice = await this.queries.invoice(invoiceId, req.user.id, req.user.role); return invoice ? res.json(invoice) : res.status(403).json({ error: 'Invoice not found or not available to you.' }); }
      catch (error) { console.error('Invoice lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load invoice.' }); }
    });
    const downloadInvoicePdf = async (req, res) => {
      const invoiceId = Number(req.params.id); if (!Number.isInteger(invoiceId) || invoiceId < 1) return res.status(422).json({ error: 'A valid invoice id is required.' });
      try { await ensureTable(); const invoice = await this.queries.invoice(invoiceId, req.user.id, req.user.role); if (!invoice) return res.status(403).json({ error: 'Invoice not found or not available to you.' }); const generated = renderInvoicePdf(invoice); const hash = crypto.createHash('sha256').update(generated).digest('hex'); const document = await this.queries.storeInvoiceDocument(invoiceId, generated, hash); const pdf = document.pdfDocument; res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="invoice-${invoice.invoiceNumber || invoiceId}.pdf"`, 'Cache-Control': 'private, no-store', ETag: `"${document.pdfHash}"` }); return res.send(pdf); }
      catch (error) { console.error('Invoice PDF generation failed:', error.message); return res.status(500).json({ error: 'Unable to download invoice.' }); }
    };
    app.get('/api/invoices/:id/download', authenticate, downloadInvoicePdf);
    app.get('/api/invoices/:id/pdf', authenticate, downloadInvoicePdf);
    const testPaymentsEnabled = process.env.NODE_ENV !== 'production' || process.env.PAYMENTS_TEST_MODE === 'true';
    app.post('/api/test-payments', authenticate, async (req, res) => {
      if (!testPaymentsEnabled) return res.status(404).json({ error: 'Test payments are unavailable.' });
      const invoiceId = Number(req.body.invoiceId); const outcome = String(req.body.outcome || 'succeeded'); if (!Number.isInteger(invoiceId) || invoiceId < 1 || !['succeeded', 'failed'].includes(outcome)) return res.status(422).json({ error: 'A valid invoice and test outcome are required.' });
      try { await ensureTable(); const result = await this.queries.simulatePayment(invoiceId, req.user.id, req.user.role, outcome === 'succeeded'); if (result?.error === 'INVALID_STATE') return res.status(409).json({ error: 'Only issued invoices can be simulated.' }); if (!result) return res.status(403).json({ error: 'Invoice not found or not available to you.' }); return res.status(201).json(result); }
      catch (error) { console.error('Test payment simulation failed:', error.message); return res.status(500).json({ error: 'Unable to simulate payment.' }); }
    });
    app.post('/api/invoices/:id/mark-paid', authenticate, requireVenueOwner, async (req, res) => {
      const invoiceId = Number(req.params.id); const paymentMethod = String(req.body.paymentMethod || ''); const paymentReference = req.body.paymentReference == null ? null : String(req.body.paymentReference).trim() || null; const paidDate = req.body.paidDate == null || req.body.paidDate === '' ? null : String(req.body.paidDate); const internalNote = req.body.internalNote == null ? null : String(req.body.internalNote).trim() || null;
      if (!Number.isInteger(invoiceId) || invoiceId < 1 || !['bank_transfer', 'bankgiro', 'plusgiro', 'swish', 'cash', 'other'].includes(paymentMethod) || paymentReference?.length > 255 || (paidDate && !/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) || internalNote?.length > 5000 || req.body.confirmReceived !== true) return res.status(422).json({ error: 'Confirm receipt and provide a valid payment date, method, and optional reference.' });
      try { await ensureTable(); const result = await this.queries.markInvoicePaid(invoiceId, req.user.id, req.user.role, { paymentMethod, paymentReference, paidDate, internalNote }); if (result?.error === 'INVALID_STATE') return res.status(409).json({ error: 'Only issued invoices can be marked paid.' }); if (!result) return res.status(403).json({ error: 'Invoice not found or not available to you.' }); return res.json({ id: invoiceId, status: 'paid', paymentSource: 'confirmed_by_venue' }); }
      catch (error) { console.error('Invoice payment update failed:', error.message); return res.status(500).json({ error: 'Unable to mark invoice paid.' }); }
    });
    app.get('/api/platform/products', async (_req, res) => {
      try { await ensureTable(); return res.json(await this.queries.platformProducts()); }
      catch (error) { console.error('Platform products lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load platform products.' }); }
    });
    app.post('/api/admin/platform/billing-profile', authenticate, requireAdmin, async (req, res) => {
      const billingProfileId = Number(req.body.billingProfileId); if (!Number.isInteger(billingProfileId) || billingProfileId < 1) return res.status(422).json({ error: 'A valid platform billing profile is required.' });
      try { await ensureTable(); return await this.queries.setPlatformBillingProfile(billingProfileId, req.user.id) ? res.status(204).end() : res.status(422).json({ error: 'The platform billing profile must be active.' }); }
      catch (error) { return res.status(500).json({ error: 'Unable to configure the platform billing profile.' }); }
    });
    app.post('/api/admin/platform/products', authenticate, requirePlatformStaff, async (req, res) => {
      const product = { productType: String(req.body.productType || ''), code: String(req.body.code || '').trim().toLowerCase(), name: String(req.body.name || '').trim(), description: req.body.description == null ? null : String(req.body.description).trim() || null, entitlementFeature: req.body.entitlementFeature == null ? null : String(req.body.entitlementFeature).trim() || null, isActive: req.body.isActive !== false };
      if (!['subscription', 'event_fee', 'featured_listing', 'other'].includes(product.productType) || !/^[a-z0-9][a-z0-9_-]{1,99}$/.test(product.code) || !product.name || product.name.length > 255) return res.status(422).json({ error: 'Platform product is invalid.' });
      try { await ensureTable(); const result = await this.queries.savePlatformProduct(null, product, req.user.id); return res.status(201).json(result); }
      catch (error) { return res.status(500).json({ error: 'Unable to create platform product.' }); }
    });
    app.put('/api/admin/platform/products/:id', authenticate, requirePlatformStaff, async (req, res) => {
      const id = Number(req.params.id); const product = { productType: String(req.body.productType || ''), code: String(req.body.code || '').trim().toLowerCase(), name: String(req.body.name || '').trim(), description: req.body.description == null ? null : String(req.body.description).trim() || null, entitlementFeature: req.body.entitlementFeature == null ? null : String(req.body.entitlementFeature).trim() || null, isActive: req.body.isActive !== false };
      if (!Number.isInteger(id) || id < 1 || !['subscription', 'event_fee', 'featured_listing', 'other'].includes(product.productType) || !/^[a-z0-9][a-z0-9_-]{1,99}$/.test(product.code) || !product.name || product.name.length > 255) return res.status(422).json({ error: 'Platform product is invalid.' });
      try { await ensureTable(); const result = await this.queries.savePlatformProduct(id, product, req.user.id); return result ? res.json(result) : res.status(404).json({ error: 'Platform product not found.' }); }
      catch (error) { return res.status(500).json({ error: 'Unable to update platform product.' }); }
    });
    app.post('/api/admin/platform/products/:id/prices', authenticate, requirePlatformStaff, async (req, res) => {
      const productId = Number(req.params.id); const price = { currency: String(req.body.currency || '').toUpperCase(), amount: Number(req.body.amount), billingInterval: req.body.billingInterval == null || req.body.billingInterval === '' ? null : String(req.body.billingInterval), providerPriceId: req.body.providerPriceId == null ? null : String(req.body.providerPriceId).trim() || null, isActive: req.body.isActive !== false };
      if (!Number.isInteger(productId) || productId < 1 || !/^[A-Z]{3}$/.test(price.currency) || !Number.isFinite(price.amount) || price.amount < 0 || ![null, 'month', 'year'].includes(price.billingInterval)) return res.status(422).json({ error: 'Platform price is invalid.' });
      try { await ensureTable(); const result = await this.queries.savePlatformPrice(productId, price, req.user.id); return result ? res.status(201).json(result) : res.status(404).json({ error: 'Platform product not found.' }); }
      catch (error) { return res.status(500).json({ error: 'Unable to create platform price.' }); }
    });
    app.post('/api/platform/orders', authenticate, requireVerifiedUser, async (req, res) => {
      const idempotencyKey = req.get('idempotency-key') || null; const request = { buyerBillingProfileId: Number(req.body.buyerBillingProfileId), productId: Number(req.body.productId), priceId: Number(req.body.priceId), eventId: req.body.eventId == null || req.body.eventId === '' ? null : Number(req.body.eventId), buyerCapacity: String(req.body.buyerCapacity || ''), termsVersion: req.body.termsVersion == null ? null : String(req.body.termsVersion).trim() || null, idempotencyKey };
      if (!Number.isInteger(request.buyerBillingProfileId) || !Number.isInteger(request.productId) || !Number.isInteger(request.priceId) || (request.eventId !== null && !Number.isInteger(request.eventId)) || !['consumer', 'business'].includes(request.buyerCapacity) || (idempotencyKey !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))) return res.status(422).json({ error: 'Platform order is invalid.' });
      try { await ensureTable(); const result = await this.queries.createPlatformOrder(req.user.id, req.user.role, request); const messages = { BUYER_PROFILE_UNAVAILABLE: 'This billing profile is not available to your account.', PRODUCT_UNAVAILABLE: 'This platform product or price is unavailable.', INVALID_PRODUCT_CONTEXT: 'This product cannot be purchased for an event.', EVENT_UNAVAILABLE: 'The event is not found or not managed by you.' }; return result.error ? res.status(422).json({ code: result.error, error: messages[result.error] }) : res.status(201).json(result); }
      catch (error) { return res.status(500).json({ error: 'Unable to create platform order.' }); }
    });
    app.post('/api/platform/orders/:id/checkout', authenticate, requireVerifiedUser, async (req, res) => {
      const orderId = Number(req.params.id); const successUrl = typeof req.body.successUrl === 'string' ? req.body.successUrl : `${this.config.site.siteUrl}/billing/success`; const cancelUrl = typeof req.body.cancelUrl === 'string' ? req.body.cancelUrl : `${this.config.site.siteUrl}/billing`;
      if (!Number.isInteger(orderId) || orderId < 1 || !sameSiteUrl(successUrl) || !sameSiteUrl(cancelUrl)) return res.status(422).json({ error: 'Platform checkout is invalid.' });
      if (!this.stripe.configured()) return res.status(503).json({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Platform payments are not configured.' });
      try { await ensureTable(); if (!await this.queries.platformBillingProfileReady()) return res.status(422).json({ code: 'PLATFORM_BILLING_INCOMPLETE', error: 'Platform billing is not configured yet.' }); const order = await this.queries.platformOrderForBuyer(orderId, req.user.id, req.user.role); if (!order) return res.status(404).json({ error: 'Platform order not found.' }); if (order.product?.productType === 'subscription') return res.status(409).json({ code: 'USE_SUBSCRIPTION_CHECKOUT', error: 'Use the Subscribe page for subscriptions.' }); if (order.paymentStatus !== 'pending') return res.status(409).json({ error: 'This platform order is no longer payable.' }); const checkout = await this.stripe.createPlatformCheckout({ order, successUrl, cancelUrl }); await this.queries.attachPlatformProviderPayment(order.id, 'stripe', checkout.id); return res.status(201).json({ orderId: order.id, checkoutUrl: checkout.url, publishableKey: this.stripe.publishableKey }); }
      catch (error) { console.error('Stripe platform checkout creation failed:', error.message); return res.status(502).json({ error: 'Unable to start platform checkout.' }); }
    });
    app.get('/api/platform/subscriptions', authenticate, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.platformSubscriptions(req.user.id, req.user.role)); } catch (error) { return res.status(500).json({ error: 'Unable to load subscriptions.' }); } });
    app.post('/api/platform/subscriptions/:id/cancel', authenticate, async (req, res) => { const subscriptionId = Number(req.params.id); if (!Number.isInteger(subscriptionId) || subscriptionId < 1) return res.status(422).json({ error: 'A valid subscription is required.' }); try { await ensureTable(); const subscription = await this.queries.subscriptionForViewer(subscriptionId, req.user.id, req.user.role); if (!subscription) return res.status(404).json({ error: 'Subscription not found.' }); if (subscription.provider === 'stripe' && subscription.providerSubscriptionId) { if (!this.stripe.configured()) return res.status(503).json({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Platform payments are not configured.' }); await this.stripe.cancelSubscriptionAtPeriodEnd(subscription.providerSubscriptionId); } await this.queries.markSubscriptionCancellation(subscriptionId); return res.json({ id: subscriptionId, cancelAtPeriodEnd: true }); } catch (error) { console.error('Subscription cancellation failed:', error.message); return res.status(502).json({ error: 'Unable to cancel subscription.' }); } });
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
    app.get('/api/my/venues', authenticate, async (req, res) => {
      try { await ensureTable(); return sendVenueList(res, await this.queries.venuesForViewer(req.user.id, req.user.role, { ownedOnly: true })); }
      catch (error) { console.error('Owned venue lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load your venues.' }); }
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
      try { await ensureTable(); if (!await this.queries.moderateVenue(venueId, moderationStatus, verificationStatus, isActive)) return res.status(404).json({ error: 'Venue not found.' }); return sendVenue(res, await this.queries.venue(venueId, req.user.id, req.user.role)); }
      catch (error) { console.error('Venue moderation update failed:', error.message); return res.status(500).json({ error: 'Unable to update venue moderation.' }); }
    });
    app.post('/api/venues/:id/submit-for-review', authenticate, requireVerifiedUser, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        if (!await this.queries.canManageVenue(venueId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        if (!await this.queries.submitVenueForModeration(venueId)) return res.status(409).json({ error: 'Only draft or rejected venues can be submitted for review.' });
        return sendVenue(res, await this.queries.venue(venueId, req.user.id, req.user.role));
      } catch (error) { console.error('Venue review submission failed:', error.message); return res.status(500).json({ error: 'Unable to submit venue for review.' }); }
    });
    app.post('/api/venues', authenticate, requireVerifiedUser, requireVenueOwner, ...creationGuards, async (req, res) => {
      const { data, errors } = venueData(req.body);
      if (Object.keys(errors).length) return res.status(422).json({ error: 'Venue is invalid.', fields: errors });
      try { await ensureTable(); if (data.organizationId && !await this.queries.canManageOrganization(data.organizationId, req.user.id, req.user.role)) return res.status(403).json({ error: 'Organization not found or not managed by you.' }); const profile = data.billingProfileId && await this.queries.billingProfile(data.billingProfileId, req.user.id, req.user.role); if (data.billingProfileId && (!profile || Number(profile.ownerOrganizationId) !== Number(data.organizationId))) return res.status(403).json({ error: 'The seller billing profile must belong to the Venue organization.' }); const id = await this.queries.createVenue(req.user.id, data); return sendVenue(res, await this.queries.venue(id, req.user.id, req.user.role), 201); }
      catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That venue slug is already in use.' }); console.error('Venue creation failed:', error.message); return res.status(500).json({ error: 'Unable to create venue.' }); }
    });
    app.post('/api/venues/:id/media', authenticate, requireVenueOwner, parseVenueImage, async (req, res) => {
      const venueId = Number(req.params.id); const altText = String(req.body.altText || '').trim(); const caption = req.body.caption == null ? null : String(req.body.caption).trim() || null; const isCover = req.body.kind === 'cover';
      if (!Number.isInteger(venueId) || venueId < 1 || !req.file || altText.length < 3 || altText.length > 200 || caption?.length > 500 || !['cover', 'gallery'].includes(req.body.kind)) return res.status(422).json({ error: 'Venue image is invalid.' });
      try { await ensureTable(); if (!await this.queries.canManageVenue(venueId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Venue not found or not managed by you.' }); const filename = await this.venueFtpService.uploadVenueImage(venueId, req.file); const id = await this.queries.addVenueMedia(venueId, filename, altText, caption, isCover); return res.status(201).json({ id, filename, url: venueImageUrl(filename, venueImageToken(filename)), altText, caption, isCover }); }
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
    app.get('/api/venues/:id/availability', optionalAuthenticate, async (req, res) => {
      const venueId = Number(req.params.id);
      const range = availabilityRange(req.query.from, req.query.to);
      if (req.query.from !== undefined || req.query.to !== undefined) {
        if (!Number.isInteger(venueId) || venueId < 1 || !range) return res.status(422).json({ error: 'Provide a valid date range of at most 94 days.' });
        try { await ensureTable(); const availability = await this.queries.calculateVenueAvailability(venueId, range.from, range.to); if (!availability) return res.status(404).json({ error: 'Venue not found or unavailable.' }); res.set('Cache-Control', 'public, max-age=60'); return res.json(availability); }
        catch (error) { console.error('Venue availability lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue availability.' }); }
      }
      const date = requestedAvailabilityDate(req.query.date);
      if (!Number.isInteger(venueId) || venueId < 1 || !date) return res.status(422).json({ error: 'Provide a valid availability date between today and one year from today.' });
      try {
        await ensureTable();
        const availability = await this.queries.calculateVenueAvailability(venueId, date, date);
        if (!availability) return res.status(404).json({ error: 'Venue not found or unavailable.' });
        const day = availability.dates[0];
        let nextAvailable = null;
        if (!day.availableIntervals.length) {
          const nextDates = await this.queries.calculateVenueAvailability(venueId, addDateDays(date, 1), addDateDays(date, 14));
          const nextDay = nextDates?.dates.find((item) => item.availableIntervals.length);
          if (nextDay) {
            const interval = nextDay.availableIntervals[0];
            nextAvailable = { date: nextDay.date, startTime: interval.start, endTime: interval.end };
          }
        }
        // Keep the original `slots` shape for existing event editors, but make
        // it represent bookable intervals rather than the venue's opening hours.
        return res.json({ venueId, date, timezone: availability.timezone, slots: day.availableIntervals.map((slot) => ({ startTime: slot.start, endTime: slot.end })), unavailableSlots: (day.unavailableIntervals || []).map((slot) => ({ startTime: slot.start, endTime: slot.end })), nextAvailable, availabilityStatus: day.availabilityStatus, bookingMode: availability.bookingMode, slotIncrementMinutes: availability.slotIncrementMinutes, minimumBookingMinutes: availability.minimumBookingMinutes, maximumBookingMinutes: availability.maximumBookingMinutes, bufferBeforeMinutes: availability.bufferBeforeMinutes, bufferAfterMinutes: availability.bufferAfterMinutes });
      } catch (error) { console.error('Venue availability lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue availability.' }); }
    });
    app.get('/api/venues/:id/calendar', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const range = availabilityRange(req.query.from ?? req.query.startDate, req.query.to ?? req.query.endDate);
      if (!Number.isInteger(venueId) || venueId < 1 || !range) return res.status(422).json({ error: 'Provide a valid date range of at most 94 days.' });
      try { await ensureTable(); const calendar = await this.queries.venueCalendar(venueId, req.user.id, req.user.role, range.from, range.to); if (!calendar) return res.status(403).json({ error: 'Venue manager access is required.' }); res.set('Cache-Control', 'private, no-store'); return res.json(calendar); }
      catch (error) { console.error('Venue calendar lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue calendar.' }); }
    });
    app.get('/api/venues/:id/booking-settings', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); if (!await this.queries.canManageVenue(venueId, req.user.id, req.user.role)) return res.status(403).json({ error: 'Venue manager access is required.' }); return res.json(await this.queries.venueBookingSettings(venueId)); }
      catch (error) { console.error('Booking settings lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load booking settings.' }); }
    });
    app.put('/api/venues/:id/booking-settings', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); const existing = await this.queries.venueBookingSettings(venueId); const { data, errors } = bookingSettingsData(req.body, existing || {}); if (Object.keys(errors).length) return res.status(422).json({ error: 'Booking settings are invalid.', fields: errors }); if (!await this.queries.updateVenueBookingSettings(venueId, req.user.id, req.user.role, data)) return res.status(403).json({ error: 'Venue manager access is required.' }); return res.json(data); }
      catch (error) { console.error('Booking settings update failed:', error.message); return res.status(500).json({ error: 'Unable to update booking settings.' }); }
    });
    app.get('/api/venues/:id/financial-settings', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); const settings = await this.queries.venueFinancialSettings(venueId, req.user.id, req.user.role); return settings ? res.json(settings) : res.status(403).json({ error: 'Venue billing access is required.' }); }
      catch (error) { console.error('Venue financial settings lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load Venue billing settings.' }); }
    });
    app.put('/api/venues/:id/financial-settings', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try {
        await ensureTable();
        const existing = await this.queries.venueFinancialSettings(venueId, req.user.id, req.user.role);
        if (!existing) return res.status(403).json({ error: 'Venue billing access is required.' });
        const { data, errors } = venueFinancialSettingsData(req.body, existing);
        if (Object.keys(errors).length) return res.status(422).json({ error: 'Venue billing settings are invalid.', fields: errors });
        const result = await this.queries.saveVenueFinancialSettings(venueId, req.user.id, req.user.role, data);
        if (result?.error === 'SELLER_PROFILE_ORGANIZATION_MISMATCH') return res.status(422).json({ code: result.error, error: 'Choose an active organization Billing Profile owned by this Venue organization.' });
        if (result?.error) return res.status(result.error === 'NOT_FOUND' ? 404 : 403).json({ code: result.error, error: 'Venue billing settings could not be saved.' });
        return res.json(result);
      } catch (error) { console.error('Venue financial settings update failed:', error.message); return res.status(500).json({ error: 'Unable to save Venue billing settings.' }); }
    });
    app.get('/api/venues/:id/financial-readiness', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); const readiness = await this.queries.getVenueFinancialReadiness(venueId, req.user.id, req.user.role); return readiness ? res.json(readiness) : res.status(403).json({ error: 'Venue billing access is required.' }); }
      catch (error) { console.error('Venue financial readiness lookup failed:', error.message); return res.status(500).json({ error: 'Unable to check Venue financial readiness.' }); }
    });
    app.put('/api/venues/:id/availability-overrides', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const validated = availabilityOverrides(req.body.overrides);
      if (!Number.isInteger(venueId) || venueId < 1 || validated.error) return res.status(422).json({ error: validated.error || 'A valid venue id is required.' });
      try { await ensureTable(); if (!await this.queries.replaceVenueAvailabilityOverrides(venueId, req.user.id, req.user.role, validated.overrides)) return res.status(403).json({ error: 'Venue manager access is required.' }); return res.json({ venueId, overrides: validated.overrides }); }
      catch (error) { console.error('Availability override update failed:', error.message); return res.status(500).json({ error: 'Unable to update availability overrides.' }); }
    });
    app.post('/api/venues/:id/availability-blocks', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const interval = await venueInterval(venueId, req.body); const startAt = interval?.startAt; const endAt = interval?.endAt; const reason = req.body.reason == null ? null : String(req.body.reason).trim() || null;
      if (!Number.isInteger(venueId) || venueId < 1 || !startAt || !endAt || startAt >= endAt || reason?.length > 5000) return res.status(422).json({ error: 'A valid future block interval is required.' });
      try { await ensureTable(); const id = await this.queries.createVenueAvailabilityBlock(venueId, req.user.id, req.user.role, { startAt, endAt, reason }); if (!id) return res.status(403).json({ error: 'Venue manager access is required.' }); return res.status(201).json({ id, venueId, startAt, endAt }); }
      catch (error) { console.error('Availability block creation failed:', error.message); return res.status(500).json({ error: 'Unable to create availability block.' }); }
    });
    app.post('/api/venues/:id/blocks', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const interval = await venueInterval(venueId, req.body); const startAt = interval?.startAt; const endAt = interval?.endAt; const reason = req.body.reason == null ? null : String(req.body.reason).trim() || null;
      if (!Number.isInteger(venueId) || venueId < 1 || !startAt || !endAt || startAt >= endAt || reason?.length > 5000) return res.status(422).json({ error: 'A valid future block interval is required.' });
      try { await ensureTable(); const id = await this.queries.createVenueAvailabilityBlock(venueId, req.user.id, req.user.role, { startAt, endAt, reason }); if (!id) return res.status(403).json({ error: 'Venue manager access is required.' }); return res.status(201).json({ id, venueId, startAt, endAt }); }
      catch (error) { console.error('Availability block creation failed:', error.message); return res.status(500).json({ error: 'Unable to create availability block.' }); }
    });
    app.delete('/api/venues/:id/availability-blocks/:blockId', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const blockId = Number(req.params.blockId); if (!Number.isInteger(venueId) || !Number.isInteger(blockId)) return res.status(422).json({ error: 'Valid venue and block ids are required.' });
      try { await ensureTable(); if (!await this.queries.deleteVenueAvailabilityBlock(venueId, blockId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Block not found or not managed by you.' }); return res.status(204).send(); }
      catch (error) { console.error('Availability block deletion failed:', error.message); return res.status(500).json({ error: 'Unable to delete availability block.' }); }
    });
    app.post('/api/venues/:id/external-reservations', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const interval = await venueInterval(venueId, req.body); const startAt = interval?.startAt; const endAt = interval?.endAt; const source = String(req.body.source || 'external'); const title = req.body.title == null ? null : String(req.body.title).trim() || null; const notes = req.body.notes == null ? null : String(req.body.notes).trim() || null;
      if (!Number.isInteger(venueId) || venueId < 1 || !startAt || !endAt || startAt >= endAt || !['external', 'internal', 'phone', 'email', 'other_platform', 'other'].includes(source) || title?.length > 255 || notes?.length > 5000) return res.status(422).json({ error: 'External reservation is invalid.' });
      try { await ensureTable(); const result = await this.queries.createExternalReservation(venueId, req.user.id, req.user.role, { startAt, endAt, source, title, notes }); if (result.error === 'CONFLICT') return res.status(409).json({ error: 'The venue is already occupied for this time.' }); if (result.error) return res.status(result.error === 'FORBIDDEN' ? 403 : 404).json({ error: 'Venue not found or not managed by you.' }); return res.status(201).json({ id: result.id, venueId, startAt, endAt, source, title }); }
      catch (error) { console.error('External reservation creation failed:', error.message); return res.status(500).json({ error: 'Unable to create external reservation.' }); }
    });
    app.post('/api/venues/:id/reservations', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const interval = await venueInterval(venueId, req.body); const startAt = interval?.startAt; const endAt = interval?.endAt; const source = String(req.body.source || 'external'); const title = req.body.title == null ? null : String(req.body.title).trim() || null; const notes = req.body.notes == null ? null : String(req.body.notes).trim() || null;
      if (!Number.isInteger(venueId) || venueId < 1 || !startAt || !endAt || startAt >= endAt || !['external', 'internal', 'phone', 'email', 'other_platform', 'other'].includes(source) || title?.length > 255 || notes?.length > 5000) return res.status(422).json({ error: 'External reservation is invalid.' });
      try { await ensureTable(); const result = await this.queries.createExternalReservation(venueId, req.user.id, req.user.role, { startAt, endAt, source, title, notes }); if (result.error === 'CONFLICT') return res.status(409).json({ error: 'The venue is already occupied for this time.' }); if (result.error) return res.status(result.error === 'FORBIDDEN' ? 403 : 404).json({ error: 'Venue not found or not managed by you.' }); return res.status(201).json({ id: result.id, venueId, startAt, endAt, source, title }); }
      catch (error) { console.error('External reservation creation failed:', error.message); return res.status(500).json({ error: 'Unable to create external reservation.' }); }
    });
    app.post('/api/venues/:id/external-reservations/:reservationId/cancel', authenticate, requireVenueOwner, async (req, res) => {
      const venueId = Number(req.params.id); const reservationId = Number(req.params.reservationId); if (!Number.isInteger(venueId) || !Number.isInteger(reservationId)) return res.status(422).json({ error: 'Valid venue and reservation ids are required.' });
      try { await ensureTable(); if (!await this.queries.cancelExternalReservation(venueId, reservationId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Future external reservation not found or not managed by you.' }); return res.status(204).send(); }
      catch (error) { console.error('External reservation cancellation failed:', error.message); return res.status(500).json({ error: 'Unable to cancel external reservation.' }); }
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
        if (data.organizationId && !await this.queries.canManageOrganization(data.organizationId, req.user.id, req.user.role)) return res.status(403).json({ error: 'Organization not found or not managed by you.' });
        const profile = data.billingProfileId && await this.queries.billingProfile(data.billingProfileId, req.user.id, req.user.role);
        if (data.billingProfileId && (!profile || Number(profile.ownerOrganizationId) !== Number(data.organizationId))) return res.status(403).json({ error: 'The seller billing profile must belong to the Venue organization.' });
        if (!await this.queries.updateVenue(venueId, req.user.id, req.user.role, data)) return res.status(404).json({ error: 'Venue not found or not managed by you.' });
        return sendVenue(res, await this.queries.venue(venueId, req.user.id, req.user.role));
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
    app.get('/api/venues/slug/:slug', optionalAuthenticate, async (req, res) => { const slug = venueSlug(req.params.slug); if (!slug) return res.status(422).json({ error: 'A valid venue slug is required.' }); try { await ensureTable(); const venue = await this.queries.venueBySlug(slug, req.user?.id ?? null, req.user?.role ?? null); return venue ? sendVenue(res, venue) : res.status(404).json({ error: 'Venue not found.' }); } catch (error) { console.error('Venue slug lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue.' }); } });
    app.get('/api/venues/:id', optionalAuthenticate, async (req, res) => {
      const venueId = Number(req.params.id);
      if (!Number.isInteger(venueId) || venueId < 1) return res.status(422).json({ error: 'A valid venue id is required.' });
      try { await ensureTable(); const venue = await this.queries.venue(venueId, req.user?.id ?? null, req.user?.role ?? null); return venue ? sendVenue(res, venue) : res.status(404).json({ error: 'Venue not found.' }); }
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
        const availability = await eventFitsVenueAvailability(context.event, context.venue);
        if (availability.error) return res.status(availability.unavailable ? 409 : 422).json({ error: availability.error });
        const result = await this.queries.requestVenueBooking(eventId, venueId, context.event.managerId, req.user.role, req.body.buyerBillingProfileId);
        if (result.error === 'EVENT_ALREADY_BOOKED') return res.status(409).json({ error: 'This event already has an active venue booking.' });
        if (result.error === 'VENUE_UNAVAILABLE') return res.status(409).json({ error: 'The venue is already booked for this time.' });
        if (result.error === 'BILLING_PROFILE_REQUIRED') return res.status(422).json({ code: result.error, error: 'Add billing details before requesting this paid venue.' });
        if (result.error === 'BILLING_PROFILE_UNAVAILABLE') return res.status(422).json({ code: result.error, error: 'This billing profile is no longer available to your account.' });
        if (result.error) return res.status(404).json({ error: 'Event or venue not found.' });
        return res.status(201).json(await this.queries.eventVenueBooking(eventId, req.user.id, req.user.role));
      } catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl }); console.error('Venue booking request failed:', error.message); return res.status(500).json({ error: 'Unable to request venue booking.' }); }
    });
    app.get('/api/events/:id/venue-booking', authenticate, async (req, res) => {
      try { await ensureTable(); const booking = await this.queries.eventVenueBooking(req.params.id, req.user.id, req.user.role); return booking ? res.json(booking) : res.status(404).json({ error: 'Venue booking not found or not available to you.' }); }
      catch (error) { console.error('Venue booking lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load venue booking.' }); }
    });
    app.get('/api/venue-bookings/:id/billing-readiness', authenticate, async (req, res) => {
      const bookingId = Number(req.params.id); if (!Number.isInteger(bookingId) || bookingId < 1) return res.status(422).json({ error: 'A valid booking id is required.' });
      try { await ensureTable(); if (!await this.queries.canAccessVenueBooking(bookingId, req.user.id, req.user.role)) return res.status(403).json({ error: 'This booking is not available to you.' }); const readiness = await this.queries.getVenueBookingBillingReadiness(bookingId); return readiness ? res.json(readiness) : res.status(404).json({ error: 'Booking not found.' }); }
      catch (error) { console.error('Booking billing readiness lookup failed:', error.message); return res.status(500).json({ error: 'Unable to check booking billing readiness.' }); }
    });
    app.get('/api/venue-bookings/:id/external-invoice', authenticate, async (req, res) => {
      const bookingId = Number(req.params.id); if (!Number.isInteger(bookingId) || bookingId < 1) return res.status(422).json({ error: 'A valid booking id is required.' });
      try { await ensureTable(); const invoice = await this.queries.externalInvoice(bookingId, req.user.id, req.user.role); return invoice ? res.json(invoice) : res.status(404).json({ error: 'External invoice not found or not available to you.' }); }
      catch (error) { console.error('External invoice lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load the external invoice.' }); }
    });
    app.patch('/api/venue-bookings/:id/buyer-billing-profile', authenticate, async (req, res) => {
      const bookingId = Number(req.params.id); const buyerBillingProfileId = Number(req.body.buyerBillingProfileId);
      if (!Number.isInteger(bookingId) || bookingId < 1 || !Number.isInteger(buyerBillingProfileId) || buyerBillingProfileId < 1) return res.status(422).json({ error: 'Choose a valid buyer Billing Profile.' });
      try {
        await ensureTable();
        const result = await this.queries.updateVenueBookingBuyerBillingProfile(bookingId, req.user.id, req.user.role, buyerBillingProfileId);
        if (result?.error === 'BUYER_PROFILE_INCOMPLETE') return res.status(422).json({ code: result.error, missing: result.missing || [], error: 'Complete the selected buyer Billing Profile before using it for this Venue.' });
        if (result?.error === 'BILLING_PROFILE_UNAVAILABLE') return res.status(422).json({ code: result.error, error: 'This Billing Profile is not available to you.' });
        if (result?.error) return res.status(409).json({ code: result.error, error: 'Only the event organizer can update a requested booking.' });
        return res.json({ booking: await this.queries.eventVenueBooking(result.eventId, req.user.id, req.user.role) });
      } catch (error) { console.error('Venue booking buyer Billing Profile update failed:', error.message); return res.status(500).json({ error: 'Unable to update the booking buyer.' }); }
    });
    app.put('/api/venue-bookings/:id/external-invoice', authenticate, requireVenueOwner, async (req, res) => {
      const bookingId = Number(req.params.id); const externalInvoiceNumber = req.body.externalInvoiceNumber == null ? null : String(req.body.externalInvoiceNumber).trim() || null; const externalInvoiceDate = req.body.externalInvoiceDate == null || req.body.externalInvoiceDate === '' ? null : String(req.body.externalInvoiceDate); const amount = req.body.amount == null || req.body.amount === '' ? null : Number(req.body.amount); const currency = req.body.currency == null || req.body.currency === '' ? null : String(req.body.currency).toUpperCase(); const dueDate = req.body.dueDate == null || req.body.dueDate === '' ? null : String(req.body.dueDate); const externalInvoiceUrl = req.body.externalInvoiceUrl == null || req.body.externalInvoiceUrl === '' ? null : String(req.body.externalInvoiceUrl).trim();
      const validUrl = !externalInvoiceUrl || (() => { try { return new URL(externalInvoiceUrl).protocol === 'https:'; } catch { return false; } })();
      if (!Number.isInteger(bookingId) || bookingId < 1 || externalInvoiceNumber?.length > 120 || (externalInvoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(externalInvoiceDate)) || (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) || (amount !== null && (!Number.isFinite(amount) || amount < 0)) || (currency && !/^[A-Z]{3}$/.test(currency)) || !validUrl || externalInvoiceUrl?.length > 2048) return res.status(422).json({ error: 'External invoice details are invalid.' });
      try { await ensureTable(); const result = await this.queries.saveExternalInvoice(bookingId, req.user.id, req.user.role, { externalInvoiceNumber, externalInvoiceDate, amount, currency, dueDate, externalInvoiceUrl }); if (result?.error === 'INVALID_MODE') return res.status(409).json({ error: 'This Venue uses YKCircle-generated invoices.' }); if (result?.error) return res.status(403).json({ error: 'This booking is not managed by you.' }); return res.json(result); }
      catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl }); console.error('External invoice update failed:', error.message); return res.status(500).json({ error: 'Unable to save the external invoice.' }); }
    });
    app.post('/api/venue-bookings/:id/external-invoice/mark-paid', authenticate, requireVenueOwner, async (req, res) => {
      const bookingId = Number(req.params.id); if (!Number.isInteger(bookingId) || bookingId < 1 || req.body.confirmReceived !== true) return res.status(422).json({ error: 'Confirm that the Venue received this payment.' });
      try { await ensureTable(); return await this.queries.markExternalInvoicePaid(bookingId, req.user.id, req.user.role) ? res.json({ bookingId, status: 'paid', paymentSource: 'confirmed_by_venue' }) : res.status(403).json({ error: 'External invoice not found or not managed by you.' }); }
      catch (error) { console.error('External invoice payment update failed:', error.message); return res.status(500).json({ error: 'Unable to mark the external invoice paid.' }); }
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
      try {
        await ensureTable();
        const result = await this.queries.reviewVenueBooking(bookingId, req.user.id, req.user.role, status, ownerNote);
        if (result?.error === 'CONFLICT') return res.status(409).json({ error: 'The venue is already occupied for this time.' });
        if (['SELLER_PROFILE_INCOMPLETE', 'FINANCIAL_SETUP_INCOMPLETE'].includes(result?.error)) return res.status(422).json({ code: result.error, missing: result.missing || [], error: 'Complete the Venue invoicing setup before approving this paid booking.' });
        if (result?.error === 'BUYER_PROFILE_INCOMPLETE') return res.status(422).json({ code: result.error, error: 'Select who is paying for this Venue before approval.' });
        if (result?.error === 'BILLING_PERMISSION_REQUIRED') return res.status(403).json({ code: result.error, error: 'Organization owner or billing admin permission is required to issue this invoice.' });
        if (['PRICE_NOT_CONFIGURED', 'INVALID_BOOKING_INTERVAL', 'INVALID_TAX_CONFIGURATION'].includes(result?.error)) return res.status(422).json({ code: result.error, error: 'The authoritative booking price or tax configuration is incomplete.' });
        if (!result) return res.status(404).json({ error: 'Pending venue booking not found or not managed by you.' });
        let warning = result.warning || null;
        if (result.invoiceId) {
          try {
            const invoice = await this.queries.invoice(result.invoiceId, req.user.id, req.user.role);
            const pdf = renderInvoicePdf(invoice);
            await this.queries.storeInvoiceDocument(result.invoiceId, pdf, crypto.createHash('sha256').update(pdf).digest('hex'));
          } catch (pdfError) {
            warning = 'INVOICE_DOCUMENT_GENERATION_FAILED';
            await this.queries.markVenueInvoiceGenerationFailed(bookingId, pdfError.message);
          }
        }
        return res.json({ id: bookingId, status, ownerNote, invoiceId: result.invoiceId || null, externalInvoiceId: result.externalInvoiceId || null, invoiceMode: result.invoiceMode || null, invoiceGenerationStatus: warning ? 'failed' : 'succeeded', warning });
      }
      catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl }); console.error('Venue booking review failed:', error.message); return res.status(500).json({ error: 'Unable to review venue booking.' }); }
    });
    app.get('/api/venue-bookings/:id/messages', authenticate, async (req, res) => {
      const bookingId = Number(req.params.id); if (!Number.isInteger(bookingId) || bookingId < 1) return res.status(422).json({ error: 'A valid booking id is required.' });
      try { await ensureTable(); const messages = await this.queries.venueBookingMessages(bookingId, req.user.id, req.user.role); return messages === null ? res.status(403).json({ error: 'This booking conversation is not available to you.' }) : res.json(messages); }
      catch (error) { console.error('Venue booking messages lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load booking messages.' }); }
    });
    app.post('/api/venue-bookings/:id/messages', authenticate, async (req, res) => {
      const bookingId = Number(req.params.id); const body = String(req.body.body || '').trim();
      if (!Number.isInteger(bookingId) || bookingId < 1 || !body || body.length > 5000) return res.status(422).json({ error: 'A booking id and message of up to 5,000 characters are required.' });
      try { await ensureTable(); const message = await this.queries.createVenueBookingMessage(bookingId, req.user.id, req.user.role, body); return message ? res.status(201).json(message) : res.status(403).json({ error: 'This booking conversation is not available to you.' }); }
      catch (error) { console.error('Venue booking message creation failed:', error.message); return res.status(500).json({ error: 'Unable to send booking message.' }); }
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
    app.patch('/api/auth/profile/timezone-preference', authenticate, async (req, res) => {
      const timezoneDisplayMode = String(req.body.timezoneDisplayMode || 'device');
      const preferredTimezone = req.body.preferredTimezone == null || req.body.preferredTimezone === '' ? null : String(req.body.preferredTimezone);
      if (!['device', 'fixed'].includes(timezoneDisplayMode) || (timezoneDisplayMode === 'fixed' && !isValidIanaTimezone(preferredTimezone))) return res.status(422).json({ error: 'Use device mode or a valid fixed IANA timezone.' });
      try { await ensureTable(); if (!await this.queries.updateTimezonePreference(req.user.id, timezoneDisplayMode, timezoneDisplayMode === 'fixed' ? preferredTimezone : null)) return res.status(404).json({ error: 'User profile not found.' }); return res.json({ timezoneDisplayMode, preferredTimezone: timezoneDisplayMode === 'fixed' ? preferredTimezone : null }); }
      catch (error) { return res.status(500).json({ error: 'Unable to update timezone preference.' }); }
    });
    
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
    
    app.get('/api/admin/contact-messages', authenticate, requirePlatformStaff, async (_req, res) => {
      try { await ensureTable(); return res.json(await this.queries.contactMessages()); }
      catch (error) { console.error('Contact message lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load contact messages.' }); }
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
    app.get('/api/my/articles', authenticate, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.articles({ editorId: req.user.id, editorRole: req.user.role, limit: 50 })); } catch (error) { console.error('My article lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load your articles.' }); } });
    app.post('/api/articles', authenticate, requireVerifiedUser, async (req, res) => { const article = articleInput(req.body); if (req.user.role !== 'admin') article.isIndexable = true; const fields = validateArticle(article, req.user.role === 'admin'); if (Object.keys(fields).length) return res.status(422).json({ error: 'Article is invalid.', fields }); const slug = articleSlug(req.body.slug || article.title); if (!slug || slug.length > 180) return res.status(422).json({ error: 'Article is invalid.', fields: { slug: 'Provide a valid slug up to 180 characters.' } }); try { await ensureTable(); const id = await this.articlePublishing.create({ ...article, slug, authorUserId: req.user.id }); await this.queries.syncArticleTags(id, article.tags); return res.status(201).json(await this.queries.articleBySlug(slug, req.user.id, req.user.role)); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, code: error.code, subscribeUrl: error.subscribeUrl, resetsAt: error.resetsAt }); if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An article with this slug already exists.' }); console.error('Article creation failed:', error.message); return res.status(500).json({ error: 'Unable to create article.' }); } });
    app.patch('/api/articles/:id', authenticate, requireVerifiedUser, async (req, res) => { const id = Number(req.params.id); const article = articleInput(req.body); if (req.user.role !== 'admin') article.isIndexable = true; const fields = validateArticle(article, req.user.role === 'admin'); if (!Number.isInteger(id) || id < 1 || Object.keys(fields).length) return res.status(422).json({ error: 'Article is invalid.', fields }); try { await ensureTable(); if (!await this.queries.updateArticle(id, req.user.id, req.user.role, [article.categoryId, article.title, article.excerpt, article.body, article.isIndexable])) return res.status(404).json({ error: 'Article not found or not owned by you.' }); await this.queries.syncArticleTags(id, article.tags); const editor = await this.queries.articleForEditor(id, req.user.id, req.user.role); return res.json(await this.queries.articleBySlug(editor.slug, req.user.id, req.user.role)); } catch (error) { console.error('Article update failed:', error.message); return res.status(500).json({ error: 'Unable to update article.' }); } });
    app.patch('/api/articles/:id/status', authenticate, requireVerifiedUser, async (req, res) => { const id = Number(req.params.id); const status = String(req.body.status || ''); const allowed = req.user.role === 'admin' ? ['draft', 'published', 'archived', 'removed'] : ['draft', 'published', 'archived']; if (!Number.isInteger(id) || id < 1 || !allowed.includes(status)) return res.status(422).json({ error: 'Invalid article status.' }); try { await ensureTable(); if (!(status === 'published' ? await this.articlePublishing.publish(id, req.user.id, req.user.role, req.user.role === 'admin' && typeof req.body.isIndexable === 'boolean' ? req.body.isIndexable : null) : await this.queries.setArticleStatus(id, req.user.id, req.user.role, status, req.user.role === 'admin' && typeof req.body.isIndexable === 'boolean' ? req.body.isIndexable : null))) return res.status(404).json({ error: 'Article not found or not owned by you.' }); return res.json({ id, status }); } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message, code: error.code, subscribeUrl: error.subscribeUrl, resetsAt: error.resetsAt }); console.error('Article status update failed:', error.message); return res.status(500).json({ error: 'Unable to update article status.' }); } });
    app.post('/api/articles/:id/cover', authenticate, requireVerifiedUser, parseArticleImage, async (req, res) => { const id = Number(req.params.id); const altText = String(req.body.altText || '').trim(); if (!Number.isInteger(id) || id < 1 || !req.file || altText.length < 3 || altText.length > 200) return res.status(422).json({ error: 'Cover image is invalid.', fields: { altText: 'Alt text must be between 3 and 200 characters.' } }); try { await ensureTable(); const article = await this.queries.articleForEditor(id, req.user.id, req.user.role); if (!article) return res.status(404).json({ error: 'Article not found or not owned by you.' }); const filename = await this.articleFtpService.uploadArticleImage(id, req.file); if (!await this.queries.setArticleCover(id, req.user.id, req.user.role, filename, altText)) { await this.articleFtpService.deleteArticleImage(filename); return res.status(404).json({ error: 'Article not found or not owned by you.' }); } if (article.coverImage) { try { await this.articleFtpService.deleteArticleImage(article.coverImage); } catch (error) { console.error('Previous article cover cleanup failed:', error.message); } } return res.json({ coverImage: articleImageUrl(filename), coverAltText: altText }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Article image storage is not configured.' }); return res.status(502).json({ error: 'Unable to upload article image.' }); } });
    app.post('/api/articles/:id/media', authenticate, requireVerifiedUser, parseArticleImage, async (req, res) => { const id = Number(req.params.id); const altText = String(req.body.altText || '').trim(); const caption = req.body.caption == null ? null : String(req.body.caption).trim() || null; if (!Number.isInteger(id) || id < 1 || !req.file || altText.length < 3 || altText.length > 200 || caption?.length > 500) return res.status(422).json({ error: 'Article image is invalid.' }); try { await ensureTable(); if (!await this.queries.articleForEditor(id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Article not found or not owned by you.' }); const filename = await this.articleFtpService.uploadArticleImage(id, req.file); const mediaId = await this.queries.addArticleMedia(id, filename, altText, caption); return res.status(201).json({ id: mediaId, filename, url: articleImageUrl(filename), altText, caption }); } catch (error) { if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Article image storage is not configured.' }); return res.status(502).json({ error: 'Unable to upload article image.' }); } });
    app.delete('/api/articles/:articleId/media/:mediaId', authenticate, requireVerifiedUser, async (req, res) => { const articleId = Number(req.params.articleId); const mediaId = Number(req.params.mediaId); if (!Number.isInteger(articleId) || !Number.isInteger(mediaId)) return res.status(404).json({ error: 'Article image not found.' }); try { await ensureTable(); if (!await this.queries.articleForEditor(articleId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Article not found or not owned by you.' }); const media = await this.queries.articleMediaItem(mediaId, articleId); if (!media) return res.status(404).json({ error: 'Article image not found.' }); await this.queries.deleteArticleMedia(mediaId, articleId); try { await this.articleFtpService.deleteArticleImage(media.filename); } catch (error) { console.error('Article image cleanup failed:', error.message); } return res.json({ message: 'Article image deleted.' }); } catch { return res.status(500).json({ error: 'Unable to delete article image.' }); } });


    const groupInput = (body) => ({ name: String(body.name || '').trim(), description: body.description == null ? null : String(body.description).trim() || null, visibility: body.visibility || 'Public' });
    const validateGroup = (group) => {
      const fields = {};
      if (group.name.length < 3 || group.name.length > 120) fields.name = 'Name must be between 3 and 120 characters.';
      if (group.description?.length > 10000) fields.description = 'Description must not exceed 10,000 characters.';
      if (!['Public', 'Private'].includes(group.visibility)) fields.visibility = 'Visibility must be Public or Private.';
      return fields;
    };
    const groupSlug = (value) => String(value).trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    app.get('/api/groups', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const viewer = { userId: req.user?.id ?? null, role: req.user?.role ?? null }; return res.json(decorateGroups(await this.queries.groupsForViewer(viewer.userId, viewer.role), viewer)); } catch (error) { console.error('Group lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load groups.' }); } });
    app.get('/api/my/groups', authenticate, async (req, res) => { try { await ensureTable(); const viewer = { userId: req.user.id, role: req.user.role }; return res.json(decorateGroups(await this.queries.groupsForViewer(viewer.userId, viewer.role, { membershipOnly: true }), viewer)); } catch (error) { return res.status(500).json({ error: 'Unable to load your groups.' }); } });
    app.get('/api/my/groups/managed', authenticate, async (req, res) => { try { await ensureTable(); const viewer = { userId: req.user.id, role: req.user.role }; return res.json(decorateGroups(await this.queries.groupsForViewer(viewer.userId, viewer.role, { managedOnly: true }), viewer)); } catch (error) { return res.status(500).json({ error: 'Unable to load managed groups.' }); } });
    app.post('/api/groups', authenticate, async (req, res) => { if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before creating a group.' }); const group = groupInput(req.body); const fields = validateGroup(group); if (Object.keys(fields).length) return res.status(422).json({ error: 'Group is invalid.', fields }); const slug = groupSlug(req.body.slug || group.name); if (!slug || slug.length > 140) return res.status(422).json({ error: 'Group is invalid.', fields: { slug: 'Provide a valid slug up to 140 characters.' } }); try { await ensureTable(); const id = await this.queries.createGroup({ organizerId: req.user.id, ...group, slug }); return res.status(201).json(decorateGroup(await this.queries.group(id, req.user.id, req.user.role), { userId: req.user.id, role: req.user.role })); } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A group with this name or slug already exists.' }); console.error('Group creation failed:', error.message); return res.status(500).json({ error: 'Unable to create group.' }); } });
    const requireManagedGroup = async (req, res, next) => { try { await ensureTable(); if (!await this.queries.groupExists(req.params.id)) return res.status(404).json({ error: 'Group not found.' }); if (!await this.queries.canManageGroup(req.params.id, req.user.id, req.user.role)) return res.status(403).json({ error: 'You do not manage this group.' }); req.managedGroup = await this.queries.group(req.params.id, req.user.id, req.user.role); return next(); } catch (error) { return res.status(500).json({ error: 'Unable to validate group access.' }); } };
    app.post('/api/group-invitations/respond', async (req, res) => { const token = String(req.body.token || ''); const action = String(req.body.action || ''); if (!token || !['accept', 'decline'].includes(action)) return res.status(422).json({ error: 'A valid invitation token and action are required.' }); try { await ensureTable(); const result = await this.queries.respondToGroupInvitation(token, action); if (result.error === 'INVALID') return res.status(400).json({ error: 'This group invitation is invalid, expired, or has already been used.' }); if (result.error === 'ACCOUNT_REQUIRED') return res.status(409).json({ code: 'ACCOUNT_REQUIRED', error: 'Create an account with the invited email address before accepting this invitation.', email: result.email }); if (result.error === 'EMAIL_NOT_VERIFIED') return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify the invited email address before accepting this invitation.' }); return res.json({ message: result.status === 'accepted' ? 'You joined the group.' : 'Invitation declined.', status: result.status, groupId: result.groupId, groupName: result.groupName }); } catch (error) { console.error('Group invitation response failed:', error.message); return res.status(500).json({ error: 'Unable to respond to this group invitation.' }); } });
    app.post('/api/groups/:id/invitations', authenticate, requireManagedGroup, async (req, res) => { if (Number(req.managedGroup.organizerId) !== req.user.id) return res.status(403).json({ error: 'Only the group organizer can invite members.' }); const rawUserId = req.body.userId; const email = String(req.body.email || '').trim(); const hasUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== ''; const hasEmail = Boolean(email); if (hasUserId === hasEmail) return res.status(422).json({ error: 'Invitation is invalid.', fields: { invitee: 'Provide exactly one of userId or email.' } }); const userId = hasUserId ? Number(rawUserId) : null; if (hasUserId && (!Number.isInteger(userId) || userId < 1)) return res.status(422).json({ error: 'Invitation is invalid.', fields: { userId: 'userId must be a positive integer.' } }); if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(422).json({ error: 'Invitation is invalid.', fields: { email: 'Provide a valid email address.' } }); try { const token = crypto.randomBytes(32).toString('base64url'); const result = await this.queries.createGroupInvitation(Number(req.params.id), req.user.id, { userId, email }, crypto.createHash('sha256').update(token).digest('hex')); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' }); if (result.error === 'NOT_PRIVATE') return res.status(409).json({ error: 'Only private groups use invitations; users can join public groups directly.' }); if (result.error === 'ALREADY_MEMBER') return res.status(409).json({ error: 'This user is already an active group member.' }); if (result.error === 'USER_NOT_FOUND') return res.status(404).json({ error: 'No user or valid email was found for this invitation.' }); await this.emailService.sendGroupInvitation(result.recipient.email, result.recipient.name, result.group, token); return res.status(201).json({ message: 'Group invitation sent.', invitation: result.invitation }); } catch (error) { console.error('Group invitation failed:', error.message); return res.status(502).json({ error: 'Unable to send group invitation.' }); } });
    app.get('/api/groups/:id/invitations', authenticate, requireManagedGroup, async (req, res) => { if (Number(req.managedGroup.organizerId) !== req.user.id) return res.status(403).json({ error: 'Only the group organizer can view invitations.' }); try { return res.json(await this.queries.groupInvitations(Number(req.params.id))); } catch (error) { return res.status(500).json({ error: 'Unable to load group invitations.' }); } });
    app.post('/api/groups/:id/cover', authenticate, requireManagedGroup, parseGroupCover, async (req, res) => { if (!req.file) return res.status(422).json({ error: 'Group cover is invalid.', fields: { coverImage: 'A JPEG, PNG, or WebP image is required.' } }); let coverImage; let coverPersisted = false; try { coverImage = await this.groupFtpService.uploadGroupCover(req.params.id, req.file); if (!await this.queries.setGroupCover(req.params.id, req.user.id, req.user.role, coverImage)) { await this.groupFtpService.deleteGroupCover(coverImage); return res.status(404).json({ error: 'Group not found or not managed by you.' }); } coverPersisted = true; const group = await this.queries.group(req.params.id, req.user.id, req.user.role); if (req.managedGroup.coverImage) { try { await this.groupFtpService.deleteGroupCover(req.managedGroup.coverImage); } catch (cleanupError) { console.error('Previous group cover cleanup failed:', cleanupError.message); } } return res.json(decorateGroup(group, { userId: req.user.id, role: req.user.role })); } catch (error) { if (coverImage && !coverPersisted) { try { await this.groupFtpService.deleteGroupCover(coverImage); } catch (cleanupError) { console.error('New group cover cleanup failed:', cleanupError.message); } } if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: 'Group cover is invalid.', fields: { coverImage: error.message } }); if (error.code === 'FTP_NOT_CONFIGURED') return res.status(503).json({ error: 'Group image storage is not configured.' }); console.error('Group cover upload failed:', error.message); return res.status(502).json({ error: 'Unable to upload group cover.' }); } });
    app.get('/api/groups/:id', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const group = await this.queries.group(req.params.id, req.user?.id ?? null, req.user?.role ?? null); if (!group) return res.status(404).json({ error: 'Group not found.' }); group.events = await this.queries.groupEvents(group.id, req.user?.id ?? null, req.user?.role ?? null); return res.json(decorateGroup(group, { userId: req.user?.id ?? null, role: req.user?.role ?? null })); } catch (error) { console.error('Group detail lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load group.' }); } });
    app.get('/api/groups/:id/threads', authenticate, async (req, res) => { const groupId = Number(req.params.id); if (!Number.isInteger(groupId) || groupId < 1) return res.status(404).json({ error: 'Group not found.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or you are not a member.' }); return res.json(await this.queries.forumThreads('group', groupId, req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load group threads.' }); } });
    app.post('/api/groups/:id/threads', authenticate, async (req, res) => { const groupId = Number(req.params.id); const title = String(req.body.title || '').trim(); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(groupId) || groupId < 1 || title.length < 3 || title.length > 180 || !body || body.length > 4000) return res.status(422).json({ error: 'Thread title must be 3–180 characters and body must be 1–4,000 characters.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or you are not a member.' }); const id = await this.queries.createForumThread('group', groupId, req.user.id, title, body); return res.status(201).json({ id, groupId, title, status: 'active' }); } catch (error) { return res.status(500).json({ error: 'Unable to create group thread.' }); } });
    app.get('/api/groups/:groupId/threads/:threadId/messages', authenticate, async (req, res) => { const groupId = Number(req.params.groupId); const threadId = Number(req.params.threadId); if (!Number.isInteger(groupId) || !Number.isInteger(threadId)) return res.status(404).json({ error: 'Group thread not found.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role) || !await this.queries.forumThread('group', groupId, threadId)) return res.status(404).json({ error: 'Group thread not found.' }); const messages = await this.queries.forumMessages('group', threadId); await this.queries.markForumThreadRead('group', threadId, req.user.id, messages.at(-1)?.id); return res.json(messages); } catch (error) { return res.status(500).json({ error: 'Unable to load thread messages.' }); } });
    app.post('/api/groups/:groupId/threads/:threadId/messages', authenticate, async (req, res) => { const groupId = Number(req.params.groupId); const threadId = Number(req.params.threadId); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(groupId) || !Number.isInteger(threadId) || !body || body.length > 4000) return res.status(422).json({ error: 'Message must be between 1 and 4,000 characters.' }); try { await ensureTable(); if (!await this.queries.groupForumAccess(groupId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or you are not a member.' }); const thread = await this.queries.forumThread('group', groupId, threadId); if (!thread) return res.status(404).json({ error: 'Group thread not found.' }); if (thread.status !== 'active') return res.status(409).json({ error: 'This group thread is locked.' }); const id = await this.queries.addForumMessage('group', threadId, req.user.id, body); return res.status(201).json({ id, threadId, body }); } catch (error) { return res.status(500).json({ error: 'Unable to send thread message.' }); } });
    app.patch('/api/groups/:groupId/threads/:threadId', authenticate, async (req, res) => { const groupId = Number(req.params.groupId); const threadId = Number(req.params.threadId); const status = String(req.body.status || ''); if (!Number.isInteger(groupId) || !Number.isInteger(threadId) || !['active', 'locked', 'removed'].includes(status)) return res.status(422).json({ error: 'Invalid thread status.' }); try { await ensureTable(); if (!await this.queries.canManageGroup(groupId, req.user.id, req.user.role) || !await this.queries.forumThread('group', groupId, threadId)) return res.status(404).json({ error: 'Group thread not found or not managed by you.' }); await this.queries.setForumThreadStatus('group', threadId, status); return res.json({ id: threadId, status }); } catch (error) { return res.status(500).json({ error: 'Unable to moderate group thread.' }); } });
    app.patch('/api/groups/:id', authenticate, requireManagedGroup, async (req, res) => { const group = groupInput(req.body); const fields = validateGroup(group); if (Object.keys(fields).length) return res.status(422).json({ error: 'Group is invalid.', fields }); try { await ensureTable(); if (!await this.queries.updateGroup(req.params.id, req.user.id, req.user.role, group)) return res.status(404).json({ error: 'Group not found or not managed by you.' }); return res.json(decorateGroup(await this.queries.group(req.params.id, req.user.id, req.user.role), { userId: req.user.id, role: req.user.role })); } catch (error) { return res.status(500).json({ error: 'Unable to update group.' }); } });
    app.delete('/api/groups/:id', authenticate, requireManagedGroup, async (req, res) => { try { await ensureTable(); if (!await this.queries.deleteGroup(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or not managed by you.' }); return res.json({ message: 'Group deleted.' }); } catch (error) { return res.status(500).json({ error: 'Unable to delete group.' }); } });
    app.post('/api/groups/:id/join', authenticate, async (req, res) => { if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before joining a group.' }); try { await ensureTable(); const result = await this.queries.joinGroup(req.params.id, req.user.id); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' }); if (result.error === 'PRIVATE') return res.status(403).json({ error: 'This private group cannot be joined directly.' }); return res.status(result.joined ? 201 : 200).json({ message: result.joined ? 'You joined the group.' : 'You are already a member.', isMember: true }); } catch (error) { return res.status(500).json({ error: 'Unable to join group.' }); } });
    app.delete('/api/groups/:id/membership', authenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.leaveGroup(req.params.id, req.user.id)) return res.status(409).json({ error: 'You are not a member, or you own this group.' }); return res.json({ message: 'You left the group.', isMember: false }); } catch (error) { return res.status(500).json({ error: 'Unable to leave group.' }); } });
    app.get('/api/groups/:id/members', authenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.canManageGroup(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Group not found or not managed by you.' }); return res.json(await this.queries.groupMembers(req.params.id, req.user.id, req.user.role)); } catch (error) { return res.status(500).json({ error: 'Unable to load group members.' }); } });
    app.post('/api/groups/:id/members', authenticate, requireManagedGroup, async (req, res) => { const rawUserId = req.body.userId; const email = String(req.body.email || '').trim(); const hasUserId = rawUserId !== undefined && rawUserId !== null && rawUserId !== ''; const hasEmail = Boolean(email); if (hasUserId === hasEmail) return res.status(422).json({ error: 'Member is invalid.', fields: { member: 'Provide exactly one of userId or email.' } }); const userId = hasUserId ? Number(rawUserId) : null; if (hasUserId && (!Number.isInteger(userId) || userId < 1)) return res.status(422).json({ error: 'Member is invalid.', fields: { userId: 'userId must be a positive integer.' } }); if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(422).json({ error: 'Member is invalid.', fields: { email: 'Provide a valid email address.' } }); try { const result = await this.queries.addGroupMember(req.params.id, { userId, email }); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Group not found.' }); if (result.error === 'PRIVATE') return res.status(409).json({ error: 'Invite private-group members through POST /api/groups/:id/invitations.' }); if (result.error === 'USER_NOT_FOUND') return res.status(404).json({ error: 'No registered user matches this member.' }); if (result.error === 'EMAIL_NOT_VERIFIED') return res.status(409).json({ code: 'EMAIL_NOT_VERIFIED', error: 'This user must verify their email before joining a group.' }); return res.status(result.added ? 201 : 200).json({ message: result.added ? 'Member added.' : 'This user is already a member.', member: result.member }); } catch (error) { console.error('Group member addition failed:', error.message); return res.status(500).json({ error: 'Unable to add group member.' }); } });
    app.delete('/api/groups/:id/members/:userId', authenticate, requireManagedGroup, async (req, res) => { const userId = Number(req.params.userId); if (!Number.isInteger(userId) || userId < 1) return res.status(404).json({ error: 'Member not found.' }); try { const result = await this.queries.removeGroupMember(req.params.id, userId); if (result.error === 'NOT_FOUND') return res.status(404).json({ error: 'Member not found.' }); if (result.error === 'OWNER') return res.status(409).json({ error: 'The group owner cannot be removed.' }); return res.json({ message: 'Member removed.', userId }); } catch (error) { console.error('Group member removal failed:', error.message); return res.status(500).json({ error: 'Unable to remove group member.' }); } });

    app.get('/api/events/:id', optionalAuthenticate, async (req, res) => { try { await ensureTable(); const event = await this.queries.richEvent(req.params.id, req.user?.id ?? null, req.user?.role ?? null); if (!event) return res.status(404).json({ error: 'Event not found.' }); const canViewArchived = ['manager', 'admin'].includes(req.user?.role) || event.managerId === req.user?.id; if (event.status === 'Archived' && !canViewArchived) return res.status(404).json({ error: 'Event not found.' }); event.participants = await this.queries.publicEventParticipants(req.params.id); if (req.user) event.myParticipantStatus = await this.queries.eventParticipantStatus(event.id, req.user.id); return res.json(decorateEventImage(event, { userId: req.user?.id ?? null, role: req.user?.role ?? null })); } catch (error) { console.error('Event detail lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load event.' }); } });
    app.get('/api/events/:id/rating', optionalAuthenticate, async (req, res) => { const eventId = Number(req.params.id); if (!Number.isInteger(eventId) || eventId < 1) return res.status(404).json({ error: 'Event not found.' }); try { await ensureTable(); const summary = await this.queries.eventRatingSummary(eventId, req.user?.id ?? null); if (!summary) return res.status(404).json({ error: 'Event not found.' }); return res.json(summary); } catch (error) { return res.status(500).json({ error: 'Unable to load event rating.' }); } });
    app.put('/api/events/:id/rating', authenticate, async (req, res) => { const eventId = Number(req.params.id); const rating = Number(req.body.rating); if (!Number.isInteger(eventId) || eventId < 1 || !Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(422).json({ error: 'rating must be an integer from 1 to 5.' }); try { await ensureTable(); const result = await this.queries.rateEvent(eventId, req.user.id, rating); if (result.error === 'NO_SHOW') return res.status(403).json({ code: 'EVENT_RATING_NO_SHOW', error: 'No-show participants cannot rate this event.' }); if (result.error === 'NOT_ATTENDED') return res.status(403).json({ code: 'EVENT_RATING_REQUIRES_ATTENDANCE', error: 'Only participants marked as Attended can rate this event.' }); return res.json(result.summary); } catch (error) { return res.status(500).json({ error: 'Unable to save event rating.' }); } });
    app.get('/api/events/:id/threads', optionalAuthenticate, async (req, res) => { const eventId = Number(req.params.id); if (!Number.isInteger(eventId) || eventId < 1) return res.status(404).json({ error: 'Event not found.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user?.id ?? null, req.user?.role ?? null)) return res.status(404).json({ error: 'Event forum not found.' }); return res.json(await this.queries.forumThreads('event', eventId, req.user?.id ?? null)); } catch (error) { return res.status(500).json({ error: 'Unable to load event threads.' }); } });
    app.post('/api/events/:id/threads', authenticate, async (req, res) => { const eventId = Number(req.params.id); const title = String(req.body.title || '').trim(); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(eventId) || eventId < 1 || title.length < 3 || title.length > 180 || !body || body.length > 4000) return res.status(422).json({ error: 'Thread title must be 3-180 characters and body must be 1-4,000 characters.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event forum not found.' }); const id = await this.queries.createForumThread('event', eventId, req.user.id, title, body); return res.status(201).json({ id, eventId, title, status: 'active' }); } catch (error) { return res.status(500).json({ error: 'Unable to create event thread.' }); } });
    app.get('/api/events/:eventId/threads/:threadId/messages', optionalAuthenticate, async (req, res) => { const eventId = Number(req.params.eventId); const threadId = Number(req.params.threadId); if (!Number.isInteger(eventId) || !Number.isInteger(threadId)) return res.status(404).json({ error: 'Event thread not found.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user?.id ?? null, req.user?.role ?? null)) return res.status(404).json({ error: 'Event forum not found.' }); const thread = await this.queries.forumThread('event', eventId, threadId); if (!thread || thread.status === 'removed') return res.status(404).json({ error: 'Event thread not found.' }); const messages = await this.queries.forumMessages('event', threadId); if (req.user) await this.queries.markForumThreadRead('event', threadId, req.user.id, messages.at(-1)?.id); return res.json(messages); } catch (error) { return res.status(500).json({ error: 'Unable to load thread messages.' }); } });
    app.post('/api/events/:eventId/threads/:threadId/messages', authenticate, async (req, res) => { const eventId = Number(req.params.eventId); const threadId = Number(req.params.threadId); const body = String(req.body.body || '').trim(); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Verify your email before posting.' }); if (!Number.isInteger(eventId) || !Number.isInteger(threadId) || !body || body.length > 4000) return res.status(422).json({ error: 'Message must be between 1 and 4,000 characters.' }); try { await ensureTable(); if (!await this.queries.eventForumAccess(eventId, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event forum not found.' }); const thread = await this.queries.forumThread('event', eventId, threadId); if (!thread || thread.status === 'removed') return res.status(404).json({ error: 'Event thread not found.' }); if (thread.status !== 'active') return res.status(409).json({ error: 'This event thread is locked.' }); const id = await this.queries.addForumMessage('event', threadId, req.user.id, body); return res.status(201).json({ id, threadId, body }); } catch (error) { return res.status(500).json({ error: 'Unable to send thread message.' }); } });
    app.patch('/api/events/:eventId/threads/:threadId', authenticate, async (req, res) => { const eventId = Number(req.params.eventId); const threadId = Number(req.params.threadId); const status = String(req.body.status || ''); if (!Number.isInteger(eventId) || !Number.isInteger(threadId) || !['active', 'locked', 'removed'].includes(status)) return res.status(422).json({ error: 'Invalid thread status.' }); try { await ensureTable(); if (!await this.queries.canManageEventForum(eventId, req.user.id, req.user.role) || !await this.queries.forumThread('event', eventId, threadId)) return res.status(404).json({ error: 'Event thread not found or not managed by you.' }); await this.queries.setForumThreadStatus('event', threadId, status); return res.json({ id: threadId, status }); } catch (error) { return res.status(500).json({ error: 'Unable to moderate event thread.' }); } });
    app.delete('/api/events/:id', authenticate, async (req, res) => { try { await ensureTable(); if (!await this.queries.softDeleteEvent(req.params.id, req.user.id, req.user.role)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); return res.json({ message: 'Event deleted.' }); } catch (error) { return res.status(500).json({ error: 'Unable to delete event.' }); } });
    app.get('/api/my/events', authenticate, async (req, res) => { try { await ensureTable(); const viewer = { userId: req.user.id, role: req.user.role }; return res.json(decorateEventImages(await this.queries.eventsForViewer(req.user.id, req.user.role, { managedOnly: true, categorySlug: req.query.category ? String(req.query.category) : null }), viewer)); } catch (error) { return res.status(500).json({ error: 'Unable to load your events.' }); } });
    app.get('/api/my/attending-events', authenticate, async (req, res) => { try { await ensureTable(); const events = await this.queries.attendingEvents(req.user.id, req.user.email); return res.json(decorateEventImages(events, { userId: req.user.id, role: req.user.role, attendingAccess: true })); } catch (error) { console.error('Attending event lookup failed:', error.message); return res.status(500).json({ error: 'Unable to load your events.' }); } });
    app.post('/api/events/:id/invitations', authenticate, requireManager, async (req, res) => { const { name, email } = req.body; if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: 'Name and email are required.' }); try { await ensureTable(); const invitation = await this.queries.createInvitation(req.params.id, req.user.id, name.trim(), email.trim().toLowerCase()); if (invitation.error === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Event not found.' }); if (invitation.error === 'ALREADY_INVITED') return res.status(409).json({ error: 'This customer has already been invited to the event.' }); await this.emailService.sendEventInvitation(email.trim().toLowerCase(), name.trim(), invitation); return res.status(201).json({ message: 'Invitation sent.' }); } catch (error) { console.error('Event invitation failed:', error.message); return res.status(500).json({ error: 'Unable to send event invitation.' }); } });
    app.post('/api/events/:eventId/invitations/:invitationId/resend', authenticate, requireManager, async (req, res) => { try { await ensureTable(); const invitation = await this.queries.resendInvitation(req.params.eventId, req.params.invitationId, req.user.id); if (!invitation) return res.status(404).json({ error: 'Pending invitation not found or not managed by you.' }); await this.emailService.sendEventInvitation(invitation.email, invitation.name, invitation); return res.json({ message: 'Invitation resent.' }); } catch (error) { console.error('Invitation resend failed:', error.message); return res.status(500).json({ error: 'Unable to resend invitation.' }); } });
    app.get('/api/events/:id/invitations', authenticate, requireManager, async (req, res) => { try { await ensureTable(); return res.json(await this.queries.invitations(req.params.id, req.user.id)); } catch (error) { return res.status(500).json({ error: 'Unable to load event invitations.' }); } });
    app.patch('/api/events/:eventId/invitations/:invitationId/status', authenticate, requireManager, async (req, res) => { if (!isInvitationStatus(req.body.status)) return res.status(400).json({ error: 'Invalid invitation status.' }); try { await ensureTable(); if (!await this.queries.updateInvitationStatus(req.params.invitationId, req.params.eventId, req.user.id, req.body.status)) return res.status(404).json({ error: 'Invitation not found.' }); return res.json({ message: 'Invitation status updated.', status: req.body.status }); } catch (error) { return res.status(500).json({ error: 'Unable to update invitation status.' }); } });
    app.patch('/api/events/:id/status', authenticate, requireManager, async (req, res, next) => {
      if (req.body.status !== 'Completed') return next();
      try {
        await ensureTable();
        const event = await this.queries.managedFollowupEvent(req.params.id, req.user.id, req.user.role);
        if (!event) return res.status(404).json({ error: 'Event not found or not managed by you.' });
        if (event.status !== 'Published' || !event.startsAt || asStoredUtcDate(event.endsAt || event.startsAt).getTime() > Date.now()) return res.status(409).json({ error: 'Only a published event whose scheduled time has passed can be marked finished.' });
        if (!await this.queries.finishEvent(req.params.id, req.user.id, req.user.role)) return res.status(409).json({ error: 'Event could not be marked finished. Refresh and try again.' });
        return res.json({ message: 'Event marked finished.', status: 'Completed' });
      } catch (error) { console.error('Event finish failed:', error.message); return res.status(500).json({ error: 'Unable to finish event.' }); }
    });
    app.patch('/api/events/:id/status', authenticate, requireManager, async (req, res) => { if (!isEventStatus(req.body.status)) return res.status(400).json({ error: 'Invalid event status.' }); try { await ensureTable(); const event = req.body.status === 'Published' ? await this.queries.richEvent(req.params.id, req.user.id, req.user.role) : null; if ((event?.venue?.id || event?.venueId) && event.venueBookingStatus !== 'confirmed') return res.status(409).json({ code: 'VENUE_BOOKING_NOT_CONFIRMED', error: 'The venue owner must confirm the booking before this event can be published.' }); if (req.body.status === 'Published') { if (!event) return res.status(404).json({ error: 'Event not found.' }); await this.subscriptions.access.requirePublication(req.params.id, req.user.id, req.user.role); const validation = await validateRichEvent(event, { publishing: true }); if (!event.coverImage) validation.errors.coverImage = 'A cover image is required before publication.'; if (Object.keys(validation.errors).length) return res.status(422).json({ error: 'Event cannot be published.', fields: validation.errors }); } if (!await this.queries.updateEventStatus(req.params.id, req.user.id, req.body.status, req.user.role)) return res.status(404).json({ error: 'Event not found or not managed by you.' }); if (event?.groupId && event.status !== 'Published') await notifyGroupEventMembers(req.params.id); return res.json({ message: 'Event status updated.', status: req.body.status }); } catch (error) { if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message, owner: error.owner, subscribeUrl: error.subscribeUrl }); return res.status(500).json({ error: 'Unable to update event status.' }); } });
    const followupAudience = (value) => ['attended', 'no_show'].includes(value);
    const managedCompletedEvent = async (req, res) => {
      const event = await this.queries.managedFollowupEvent(req.params.id, req.user.id, req.user.role);
      if (!event) { res.status(404).json({ error: 'Event not found or not managed by you.' }); return null; }
      if (event.status !== 'Completed') { res.status(409).json({ error: 'Mark this event finished before preparing follow-up emails.' }); return null; }
      return event;
    };
    app.get('/api/events/:id/followups', authenticate, requireManager, async (req, res) => {
      try { await ensureTable(); if (!await managedCompletedEvent(req, res)) return; return res.json(await this.queries.eventFollowupOverview(req.params.id)); }
      catch (error) { console.error('Follow-up overview failed:', error.message); return res.status(500).json({ error: 'Unable to load follow-up emails.' }); }
    });
    app.put('/api/events/:id/followups/:audience', authenticate, requireManager, async (req, res) => {
      if (!followupAudience(req.params.audience)) return res.status(404).json({ error: 'Unknown attendance group.' });
      const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
      const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
      if (!subject || subject.length > 180 || /[\r\n]/.test(subject) || !body || body.length > 5000) return res.status(422).json({ error: 'Enter a one-line subject (up to 180 characters) and message (up to 5,000 characters).' });
      try {
        await ensureTable(); if (!await managedCompletedEvent(req, res)) return;
        if (!await this.queries.saveEventFollowupTemplate(req.params.id, req.params.audience, subject, body)) return res.status(409).json({ error: 'This follow-up has already started and its message is locked.' });
        return res.json(await this.queries.eventFollowupOverview(req.params.id));
      } catch (error) { console.error('Follow-up template save failed:', error.message); return res.status(500).json({ error: 'Unable to save follow-up email.' }); }
    });
    app.post('/api/events/:id/followups/:audience/send', authenticate, requireManager, async (req, res) => {
      if (!followupAudience(req.params.audience)) return res.status(404).json({ error: 'Unknown attendance group.' });
      try {
        await ensureTable();
        const event = await managedCompletedEvent(req, res);
        if (!event) return;
        const overview = await this.queries.eventFollowupOverview(req.params.id);
        const template = overview.templates[req.params.audience];
        if (!template) return res.status(409).json({ error: 'Save this follow-up message before sending.' });
        const recipients = await this.queries.queueEventFollowup(req.params.id, req.params.audience);
        let sent = 0; let failed = 0;
        for (const recipient of recipients) {
          if (!await this.queries.claimEventFollowupDelivery(recipient.id)) continue;
          let accepted = false;
          try {
            await this.emailService.sendEventFollowup(recipient.email, recipient.name, event, req.params.audience, template.subject, template.body, recipient.id);
            accepted = true;
            await this.queries.finishEventFollowupDelivery(recipient.id);
            sent += 1;
          } catch (error) {
            console.error('Event follow-up delivery failed:', { eventId: event.id, deliveryId: recipient.id, error: error.message });
            // Keep an accepted message in 'sending' if the database write fails;
            // retrying it automatically could send a duplicate email.
            if (accepted) throw error;
            await this.queries.finishEventFollowupDelivery(recipient.id, error.message);
            failed += 1;
          }
        }
        return res.json({ sent, failed, ...(await this.queries.eventFollowupOverview(req.params.id)) });
      } catch (error) { console.error('Event follow-up send failed:', error.message); return res.status(500).json({ error: 'Unable to send follow-up emails.' }); }
    });
    app.post('/api/events/:id/registrations', authenticate, async (req, res) => { if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Your account is not permitted to register for events.' }); if (!req.user.isEmailConfirmed) return res.status(403).json({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before registering for an event.' }); try { await ensureTable(); if (!await this.queries.canAcceptPaidRegistrations(req.params.id)) return res.status(422).json({ code: 'PAYMENT_SETUP_REQUIRED', error: 'Complete payment setup before starting ticket sales.' }); const result = await this.queries.registerForEvent(req.params.id, req.user.id, req.user.email); if (result.error === 'EVENT_UNAVAILABLE') return res.status(409).json({ error: 'Event is not available for registration.' }); if (result.error === 'ALREADY_REGISTERED') return res.status(409).json({ error: 'You are already registered for this event.' }); const user = await this.queries.profile(req.user.id); try { await this.emailService.sendRegistrationConfirmation(user.email, user.name, result); } catch (emailError) { console.error('Registration confirmation email failed:', emailError.message); } try { await this.emailService.sendManagerRegistrationNotification(result.managerEmail, result.managerName, user.name, user.email, result.title, result.eventId, result.id); } catch (emailError) { console.error('Manager registration notification failed:', emailError.message); } return res.status(201).json({ id: result.id, status: 'Pending' }); } catch (error) { console.error('Event registration failed:', error.message); return res.status(500).json({ error: 'Unable to register for event.' }); } });
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
