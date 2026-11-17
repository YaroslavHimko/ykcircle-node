import crypto from 'node:crypto';
import { EVENT_STATUSES } from '../../../domain/events/event-status.js';
import { REGISTRATION_STATUSES } from '../../../domain/events/registration-status.js';
import { INVITATION_STATUSES } from '../../../domain/events/invitation-status.js';
import { PARTICIPANT_STATUSES } from '../../../domain/events/participant-status.js';
import { EMAIL_UNSUBSCRIBE_REASONS } from '../../../domain/accounts/email-unsubscribe-reasons.js';
import { legalDocument, legalDocumentIndex } from '../../../services/legal/legal-documents.js';
import { escapeHtml, legalHtml } from '../../helpers/legal/html.js';
export function registerPublicRoutes(
  app,
  {
    config,
    companyInformation,
    publishedSubprocessors,
    publicPage,
    ensureTable,
    queries,
    authSecret,
    profileUploadRoute,
    ftpService,
  },
) {
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/event-statuses', (_req, res) => res.json(EVENT_STATUSES));
  app.get('/api/registration-statuses', (_req, res) => res.json(REGISTRATION_STATUSES));
  app.get('/api/invitation-statuses', (_req, res) => res.json(INVITATION_STATUSES));
  app.get('/api/participant-statuses', (_req, res) => res.json(PARTICIPANT_STATUSES));
  app.get('/api/legal-documents', (_req, res) => res.json(legalDocumentIndex()));
  app.get('/api/legal-documents/:slug', async (req, res) => {
    try {
      const document = await legalDocument(req.params.slug, config);
      if (!document) return res.status(404).json({ error: 'Legal document not found.' });
      return res.json(document);
    } catch (error) {
      console.error('Legal document load failed:', error.message);
      return res.status(500).json({ error: 'Unable to load legal document.' });
    }
  });
  app.get(['/api/operator', '/api/company'], (_req, res) => res.json(companyInformation()));
  app.get('/api/subprocessors', (_req, res) =>
    res.json({ subprocessors: publishedSubprocessors() }),
  );
  for (const slug of legalDocumentIndex().map((document) => document.slug))
    app.get(`/${slug}`, async (_req, res) => {
      try {
        const document = await legalDocument(slug, config);
        const metadata = `<header><p>Last updated: ${escapeHtml(document.lastUpdated || 'Not stated')}</p><p>Current version: ${escapeHtml(document.version)}</p></header>`;
        return res
          .type('html')
          .send(
            publicPage(
              document.title,
              `<article>${metadata}${legalHtml(document.content)}</article>`,
            ),
          );
      } catch {
        return res
          .status(500)
          .type('html')
          .send(publicPage('Unavailable', '<h1>Document unavailable</h1>'));
      }
    });
  app.get(['/operator', '/company'], (_req, res) => {
    const company = companyInformation();
    const value = (label, content) =>
      `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(content || 'Not currently published')}</dd>`;
    return res
      .type('html')
      .send(
        publicPage(
          'Operator information',
          `<article><h1>Operator information</h1><dl>${value('Legal operator', company.legalOperatorName)}${value('Postal contact address', company.registeredAddress)}${value('Support email', company.supportEmail)}${value('Privacy contact', company.privacyEmail)}${value('Moderation contact', company.moderationEmail)}${value('Country of establishment', company.country)}</dl></article>`,
        ),
      );
  });
  app.get('/subprocessors', (_req, res) => {
    const items = publishedSubprocessors()
      .map(
        (provider) =>
          `<li>${escapeHtml(typeof provider === 'string' ? provider : provider.name || 'Unnamed provider')}${typeof provider === 'object' ? `<p>${escapeHtml(provider.purpose || '')}</p><p>Processing location: ${escapeHtml(provider.region || 'Not yet confirmed')}</p><p>Transfer arrangements: ${escapeHtml(provider.transferSafeguards || 'Not yet confirmed')}</p>` : ''}</li>`,
      )
      .join('');
    return res
      .type('html')
      .send(
        publicPage(
          'Subprocessors',
          `<article><h1>Service providers and subprocessors</h1>${items ? `<ul>${items}</ul>` : '<p>Provider details have not yet been published. Contact the privacy address for information.</p>'}</article>`,
        ),
      );
  });
  app.get('/report', (req, res) =>
    res
      .type('html')
      .send(
        publicPage(
          'Report content',
          `<h1>Report content</h1><p>Use this form to report content you believe is illegal or violates the Community Guidelines.</p><form id="report"><label>Content type<select name="entityType"><option value="event">Event</option><option value="group">Group</option><option value="profile">Profile</option><option value="image">Image</option><option value="review">Review</option><option value="organization">Venue or business listing</option></select></label><label>Content URL or ID<input name="content" required></label><label>Reason<select name="reasonCode"><option value="illegal_content">Illegal content</option><option value="harassment">Harassment</option><option value="child_safety">Child safety</option><option value="privacy">Privacy</option><option value="other">Other</option></select></label><label>Your email<input name="reporterEmail" type="email" required></label><label>Explanation<textarea name="description" required></textarea></label><label><input type="checkbox" name="goodFaithDeclared" required>I submit this report in good faith.</label><button>Submit report</button></form><p id="result"></p><script nonce="${req.cspNonce}">document.querySelector('#report').onsubmit=async(e)=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));if(/^https?:/i.test(d.content))d.contentUrl=d.content;else d.entityId=d.content;delete d.content;d.goodFaithDeclared=true;const r=await fetch('/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const out=await r.json();document.querySelector('#result').textContent=out.reference||out.error||'Unable to submit report.'}</script>`,
        ),
      ),
  );
  app.get('/contact', (req, res) =>
    res
      .type('html')
      .send(
        publicPage(
          'Contact',
          `<h1>Contact</h1><form id="contact"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Category<select name="category"><option>General</option><option>Privacy</option><option>Account</option><option>Safety</option><option>Other</option></select></label><label>Message<textarea name="message" required></textarea></label><button>Send</button></form><p id="result"></p><script nonce="${req.cspNonce}">document.querySelector('#contact').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const d=await r.json();document.querySelector('#result').textContent=d.reference?('Reference: '+d.reference):(d.error||'Unable to send request.');}</script>`,
        ),
      ),
  );
  app.get('/appeal', (_req, res) => res.redirect(302, `${config.site.siteUrl}/appeal`));
  app.get('/api/event-categories', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.eventCategories());
    } catch {
      return res.status(500).json({ error: 'Unable to load event categories.' });
    }
  });
  app.get('/api/event-types', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.eventTypes());
    } catch {
      return res.status(500).json({ error: 'Unable to load event types.' });
    }
  });
  app.get('/api/timezones', (_req, res) => {
    if (typeof Intl.supportedValuesOf !== 'function')
      return res.status(500).json({ error: 'Timezone data is unavailable on this server.' });
    return res.json(Intl.supportedValuesOf('timeZone'));
  });
  app.get('/api/email/unsubscribe-reasons', (_req, res) => res.json(EMAIL_UNSUBSCRIBE_REASONS));
  app.get('/api/email/unsubscribe', (req, res) => {
    const token = String(req.query.token || '');
    const options = EMAIL_UNSUBSCRIBE_REASONS.map(
      (reason) => `<option value="${reason.replace(/"/g, '&quot;')}">${reason}</option>`,
    ).join('');
    return res
      .type('html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;padding:32px}main{max-width:520px;margin:40px auto;background:#fff;padding:32px;border-radius:14px;box-shadow:0 4px 24px #17203318}label,select,button{display:block;width:100%;margin-top:12px}select,button{padding:12px;border-radius:8px;border:1px solid #d8deea}button{background:#0ea5e9;color:#fff;border:0;font-weight:700;cursor:pointer}</style></head><body><main><h1>Email preferences</h1><p>Why would you like to stop receiving emails?</p><form id="unsubscribe"><input type="hidden" name="token" value="${token.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/><label for="reason">Reason</label><select id="reason" name="reason" required>${options}</select><button type="submit">Unsubscribe</button></form><p id="result"></p><script nonce="${req.cspNonce}">document.getElementById('unsubscribe').addEventListener('submit',async(e)=>{e.preventDefault();const result=document.getElementById('result');const response=await fetch('/api/email/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});const data=await response.json();result.textContent=data.message||data.error||'Unable to update your preference.';});</script></main></body></html>`,
      );
  });
  app.post('/api/email/unsubscribe', async (req, res) => {
    const { token, reason } = req.body;
    if (!token || !EMAIL_UNSUBSCRIBE_REASONS.includes(reason))
      return res.status(400).json({ error: 'A valid token and unsubscribe reason are required.' });
    try {
      const [payload, signature] = token.split('.');
      const expected = crypto
        .createHmac('sha256', authSecret)
        .update(payload || '')
        .digest('base64url');
      if (
        !signature ||
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      )
        return res.status(400).json({ error: 'Invalid unsubscribe link.' });
      const email = Buffer.from(payload, 'base64url').toString();
      if (!email.includes('@')) return res.status(400).json({ error: 'Invalid unsubscribe link.' });
      await ensureTable();
      await queries.setMarketingEmailPreference(email, false, null, `unsubscribe:${reason}`);
      return res.json({
        message:
          'You have been unsubscribed from marketing emails. Transactional and security messages will still be sent when necessary.',
      });
    } catch (error) {
      return res.status(400).json({ error: 'Invalid unsubscribe link.' });
    }
  });
  app.get(profileUploadRoute, async (req, res) => {
    try {
      if (!(await ftpService.streamProfilePicture(req.params.filename, res)))
        return res.status(404).json({ error: 'Profile picture not found.' });
    } catch (error) {
      console.error('Profile picture proxy failed:', error.message);
      if (!res.headersSent)
        return res.status(502).json({ error: 'Unable to load profile picture.' });
    }
  });
  app.post('/api/invitations/respond', async (req, res) => {
    const { token, action } = req.body;
    const status = action === 'accept' ? 'Accepted' : action === 'decline' ? 'Declined' : null;
    if (!token || !status)
      return res.status(400).json({ error: 'A valid invitation token and action are required.' });
    try {
      await ensureTable();
      const invitation =
        status === 'Accepted'
          ? await queries.acceptInvitationAsParticipant(token)
          : await queries.respondToInvitation(token, status);
      if (!invitation)
        return res.status(400).json({ error: 'Invalid, expired, or already used invitation.' });
      if (invitation.alreadyRegistered)
        return res.status(409).json({
          error: 'This email or user is already registered for this event.',
          eventId: invitation.eventId,
          participantId: invitation.participantId || null,
        });
      return res.json({
        message:
          status === 'Accepted'
            ? 'Invitation accepted. Your participation is confirmed.'
            : 'Invitation declined.',
        eventId: invitation.eventId,
        registrationId: null,
        participantId: invitation.participantId || null,
        requiresRegistration: Boolean(invitation.requiresRegistration),
        status,
        paymentStatus: invitation.paymentStatus || null,
      });
    } catch (error) {
      console.error('Invitation response failed:', error.message);
      return res.status(500).json({ error: 'Unable to process invitation response.' });
    }
  });
}
