import { logoImage } from './branding.js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const eventFee = (event) => Number(event.fee) > 0 ? `\nFee: ${Number(event.fee).toFixed(2)} SEK` : '';
const eventFeeHtml = (event) => Number(event.fee) > 0 ? `<br><strong>Fee:</strong> ${escapeHtml(Number(event.fee).toFixed(2))} SEK` : '';
const formatEventDate = (date, timezone = 'UTC') => {
  const text = String(date || '').replace(' ', 'T');
  const instant = date instanceof Date ? date : new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}Z`);
  return Number.isNaN(instant.getTime()) ? 'To be announced' : instant.toLocaleString(undefined, { timeZone: timezone || 'UTC', timeZoneName: 'short' });
};
const brandEmailHtml = (html = '') => {
  const colors = {
    '#f5f7fb': '#f8f5f1', '#172033': '#251e18', '#e7ebf3': '#dfd2c7',
    '#b9c5d8': '#e7d9cc', '#8994a8': '#76675e', '#0ea5e9': '#c94b1b', '#526078': '#665a52',
    '#7b879b': '#76675e', '#f8fafc': '#f2e9e1', '#718096': '#76675e', '#e0f2fe': '#dce9e5',
    '#0369a1': '#316f68', '#16a34a': '#316f68', '#dc2626': '#c94b1b',
  };
  return Object.entries(colors).reduce((result, [from, to]) => result.replaceAll(from, to), String(html)).replace(/#fff(?![0-9a-f])/gi, '#fffdfa');
};

export class EmailService {
  constructor({ smtp, domain, brandName, noReplyFrom, verificationUrl, passwordResetUrl, managerEventUrl, eventDetailsUrl, invitationResponseUrl, groupInvitationUrl, unsubscribeUrl, unsubscribeEndpointUrl, unsubscribeSecret, notificationFrom, invitationFrom, database }) {
    this.domain = domain;
    this.brandName = brandName;
    this.noReplyFrom = noReplyFrom;
    this.smtp = smtp;
    this.verificationUrl = verificationUrl;
    this.passwordResetUrl = passwordResetUrl;
    this.managerEventUrl = managerEventUrl;
    this.eventDetailsUrl = eventDetailsUrl;
    this.invitationResponseUrl = invitationResponseUrl;
    this.groupInvitationUrl = groupInvitationUrl;
    this.notificationFrom = notificationFrom;
    this.invitationFrom = invitationFrom;
    this.database = database;
    this.unsubscribeUrl = unsubscribeUrl;
    this.unsubscribeEndpointUrl = unsubscribeEndpointUrl;
    this.unsubscribeSecret = unsubscribeSecret;
    this.mailer = this.createMailer(smtp.verification);
    this.notificationMailer = this.createMailer(smtp.notification || smtp.applicationNotification);
    this.invitationMailer = this.createMailer(smtp.invitation);
  }

  unsubscribeToken(email) { const payload = Buffer.from(email.trim().toLowerCase()).toString('base64url'); const signature = crypto.createHmac('sha256', this.unsubscribeSecret).update(payload).digest('base64url'); return `${payload}.${signature}`; }

  async sendMarketing(message) {
    const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map((value) => typeof value === 'string' ? value : value?.address).filter(Boolean);
    const allowed = [];
    for (const email of recipients) {
      const [rows] = await this.database.execute('SELECT marketing_opt_in AS marketingOptIn FROM marketing_email_preferences WHERE LOWER(email) = LOWER(?)', [email]);
      if (rows[0]?.marketingOptIn) allowed.push(email);
    }
    if (!allowed.length) return { accepted: [], rejected: recipients, suppressed: true };
    const unsubscribeLink = `${this.unsubscribeEndpointUrl}?token=${encodeURIComponent(this.unsubscribeToken(allowed[0]))}`;
    return this.notificationMailer.sendMail({ ...message, to: allowed, text: `${message.text || ''}\n\nUnsubscribe from marketing emails: ${unsubscribeLink}`, html: `${brandEmailHtml(message.html)}<p><a href="${escapeHtml(unsubscribeLink)}">Unsubscribe from marketing emails</a></p>` });
  }

  createMailer(credentials) {
    return nodemailer.createTransport({ host: this.smtp.host, port: this.smtp.port, secure: this.smtp.secure,
      auth: credentials?.user ? { user: credentials.user, pass: credentials.password } : undefined });
  }

  layout(content, subtitle = '') {
    const brandName = escapeHtml(this.brandName);
    const brandUrl = `https://${this.domain}`;
    return `<div style="margin:0;background:#f8f5f1;padding:40px 16px;font-family:Arial,sans-serif;color:#251e18"><div style="max-width:600px;margin:auto;background:#fffdfa;border:1px solid #dfd2c7;border-radius:4px;overflow:hidden"><div style="height:6px;background:#c94b1b"></div><div style="background:#f8f5f1;border-bottom:1px solid #dfd2c7;padding:28px 32px"><a href="${escapeHtml(brandUrl)}" style="font-family:Georgia,serif;font-size:24px;font-weight:700;letter-spacing:-0.3px;color:#c94b1b;text-decoration:none">${brandName}</a>${subtitle ? `<div style="color:#76675e;font-size:13px;margin-top:8px">${subtitle}</div>` : ''}</div><div style="padding:36px 32px"><style>h1{font-family:Georgia,serif;color:#251e18;font-size:28px;line-height:1.2;margin:0 0 16px}a{color:#316f68}</style>${content}</div><div style="border-top:1px solid #dfd2c7;padding:20px 32px;font-size:12px;color:#76675e">&copy; ${brandName}</div></div></div>`;
  }

  customerLayout(branding, content, subtitle = '') {
    const name = escapeHtml(branding.brandName || branding.managerName || branding.legalName || branding.title || 'Event organizer');
    const logo = logoImage(branding.logoImage);
    return `<div style="margin:0;background:#f5f5f5;padding:32px 16px;font-family:Arial,sans-serif;color:#202020"><div style="max-width:600px;margin:auto;background:#fff;border:1px solid #ddd"><header style="padding:28px 32px;border-bottom:1px solid #ddd">${logo ? `<img src="cid:customer-logo" alt="${name} logo" width="${Math.round(logo.width * Math.min(240 / logo.width, 88 / logo.height, 1))}" height="${Math.round(logo.height * Math.min(240 / logo.width, 88 / logo.height, 1))}" style="display:block;max-width:100%;object-fit:contain;margin-bottom:16px">` : ''}<div style="font-size:24px;font-weight:700;color:#202020">${name}</div>${subtitle ? `<p style="font-size:13px;color:#666">${escapeHtml(subtitle)}</p>` : ''}</header><div style="padding:28px 32px">${content}</div><footer style="padding:16px 32px;border-top:1px solid #eee;font-size:11px;color:#777">Delivered via <a href="https://${escapeHtml(this.domain)}" style="color:#777">${escapeHtml(this.brandName)}</a></footer></div></div>`;
  }

  sendCustomerMail(mailer, branding, message) {
    const name = branding.brandName || branding.managerName || branding.legalName || branding.title || 'Event organizer';
    const logo = logoImage(branding.logoImage);
    const { offlineTickets, ...mail } = message;
    const attachments = [...(mail.attachments || [])];
    if (offlineTickets) attachments.push({ filename: 'tickets.html', content: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Event tickets</title></head><body>${mail.html.replace('cid:customer-logo', branding.logoImage || '')}</body></html>`, contentType: 'text/html; charset=utf-8' });
    if (logo) attachments.push({ filename: 'logo.jpg', content: logo.bytes, contentType: 'image/jpeg', cid: 'customer-logo', contentDisposition: 'inline' });
    // Keep the configured, authenticated sender address; change only its label.
    const configured = mail.from;
    const address = typeof configured === 'string' ? (configured.match(/<([^>]+)>/)?.[1] || configured) : configured.address;
    return mailer.sendMail({ ...mail, from: { name, address }, text: `${name}\n\n${mail.text}\n\nDelivered via ${this.brandName}.`, attachments });
  }

  sendVerification(email, name, token) {
    const url = `${this.verificationUrl}?token=${encodeURIComponent(token)}`;
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Verify your ${this.brandName} email address`,
      text: `Hi ${name},\n\nVerify your email address by opening this link:\n${url}\n\nThis link expires in 24 hours.`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1 style="font-size:28px;line-height:1.2;margin:0 0 16px">Confirm your email address</h1><p style="font-size:16px;line-height:1.6;color:#526078">Thanks for creating your account. Click the button below to verify your email and finish setting up your profile.</p><p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Verify my email</a></p><p style="font-size:13px;line-height:1.5;color:#7b879b">This verification link expires in 24 hours. If you did not create this account, you can safely ignore this email.</p>`) });
  }

  async sendTickets(order, orderUrl) {
    if (!this.smtp?.host) throw new Error('Set SMTP_HOST and the transactional SMTP credentials to deliver ticket emails.');
    const branding = { ...order.seller, title: order.eventTitle };
    const when = formatEventDate(order.event?.startsAt, order.event?.timezone);
    const location = order.event?.location || 'Location to be announced';
    const testLabel = order.testMode ? 'TEST TICKETS — no real payment was taken.\n\n' : '';
    const ticketText = order.tickets.map((ticket) => `${ticket.name}: ${ticket.code}`).join('\n');
    const text = `${testLabel}Your tickets for ${order.eventTitle}\n\nOrder: ${order.orderNumber}\nWhen: ${when}\nLocation: ${location}\n\n${ticketText}\n\nTotal: ${Number(order.totalAmount).toFixed(2)} ${order.currency}\nSeller: ${order.seller?.legalName || ''}\n\nShow these ticket codes at the event.\nView your tickets: ${orderUrl}`;
    const result = await this.sendCustomerMail(this.mailer, branding, {
      from: this.noReplyFrom, to: order.attendeeEmail,
      messageId: `<ticket-order-${order.id}@${this.domain}>`,
      subject: `${order.testMode ? '[TEST] ' : ''}Your tickets: ${order.eventTitle}`,
      text,
      html: this.customerLayout(branding, `${order.testMode ? '<p><strong>TEST TICKETS — no real payment was taken.</strong></p>' : ''}<h1>Your event tickets</h1><h2>${escapeHtml(order.eventTitle)}</h2><p>${escapeHtml(when)}<br>${escapeHtml(location)}</p><p>Order: ${escapeHtml(order.orderNumber)}</p>${order.tickets.map((ticket) => `<div style="border:1px solid #dfd2c7;padding:16px;margin:12px 0"><strong>${escapeHtml(ticket.name)}</strong><p style="font-family:monospace;overflow-wrap:anywhere">${escapeHtml(ticket.code)}</p></div>`).join('')}<p>Show these codes at the event. Each code admits one person.</p><p><a href="${escapeHtml(orderUrl)}">View your tickets</a></p><p>Sold by ${escapeHtml(order.seller?.legalName)} · ${escapeHtml(Number(order.totalAmount).toFixed(2))} ${escapeHtml(order.currency)}</p>`),
      // A plain-text attachment works offline and does not load remote assets.
      offlineTickets: true,
      attachments: [{ filename: `tickets-${order.orderNumber}.txt`, content: text, contentType: 'text/plain; charset=utf-8' }],
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('The email server did not accept the ticket email.');
    return result;
  }

  sendPasswordReset(email, name, token) {
    const url = `${this.passwordResetUrl}?token=${encodeURIComponent(token)}`;
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Reset your ${this.brandName} password`,
      text: `Hi ${name},\n\nReset your password by opening this link:\n${url}\n\nThis link expires in one hour. If you did not request a password reset, you can safely ignore this email.`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1 style="font-size:28px;line-height:1.2;margin:0 0 16px">Reset your password</h1><p style="font-size:16px;line-height:1.6;color:#526078">We received a request to reset your password. Use the button below to choose a new one.</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Reset password</a></p><p style="font-size:13px;line-height:1.5;color:#7b879b">This link expires in one hour. If you did not request a password reset, you can safely ignore this email.</p>`) });
  }

  sendAccountDeleted(email, name) {
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Your ${this.brandName} account was deleted`,
      text: `Hi ${name},\n\nYour ${this.brandName} account has been deleted successfully. If you did not request this, please contact us immediately.`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Account deleted</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your ${escapeHtml(this.brandName)} account has been deleted successfully. You will no longer be able to sign in with this account.</p><p style="font-size:13px;color:#7b879b">If you did not request this change, please contact us immediately.</p>`) });
  }

  sendRegistrationConfirmation(email, name, event) {
    const start = formatEventDate(event.startsAt, event.timezone);
    const end = event.endsAt ? formatEventDate(event.endsAt, event.timezone) : null;
    const details = `Event: ${event.title}\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}${eventFee(event)}\nRegistration status: Pending`;
    return this.sendCustomerMail(this.mailer, event, { from: this.noReplyFrom, to: email, subject: `Registration received: ${event.title}`,
      text: `Hi ${name},\n\nYour registration has been received and is pending manager confirmation.\n\n${details}`,
      html: this.customerLayout(event, `<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Registration received</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your registration is pending manager confirmation.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><span style="color:#526078">${escapeHtml(event.description || 'Event registration')}</span><br><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}${eventFeeHtml(event)}<br><strong>Status:</strong> Pending</div>`) });
  }

  sendRegistrationApproved(email, name, event) {
    const start = formatEventDate(event.startsAt, event.timezone);
    const end = event.endsAt ? formatEventDate(event.endsAt, event.timezone) : null;
    const details = `Event: ${event.title}\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}${eventFee(event)}\nRegistration status: Confirmed`;
    return this.sendCustomerMail(this.mailer, event, { from: this.noReplyFrom, to: email, subject: `Registration confirmed: ${event.title}`,
      text: `Hi ${name},\n\nYour registration has been confirmed by the event manager.\n\n${details}`,
      html: this.customerLayout(event, `<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Registration confirmed</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your registration has been confirmed by the event manager. We look forward to seeing you there.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><span style="color:#526078">${escapeHtml(event.description || 'Event registration')}</span><br><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}${eventFeeHtml(event)}<br><strong>Status:</strong> Confirmed</div>`) });
  }

  sendRegistrationWithdrawal(email, name, event) {
    const start = formatEventDate(event.startsAt, event.timezone);
    const end = event.endsAt ? formatEventDate(event.endsAt, event.timezone) : null;
    return this.sendCustomerMail(this.mailer, event, { from: this.noReplyFrom, to: email, subject: `Withdrawal received: ${event.title}`,
      text: `Hi ${name},\n\nYour withdrawal from ${event.title} has been received.\n\nEvent: ${event.title}\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}\nStatus: Withdrawn`,
      html: this.customerLayout(event, `<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Withdrawal received</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your withdrawal from this event has been received successfully.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}<br><strong>Status:</strong> Withdrawn</div>`) });
  }

  async sendEventFollowup(email, name, event, audience, subject, body, deliveryId) {
    if (!this.smtp?.host) throw new Error('Email delivery is not configured.');
    const paragraphs = body.split(/\n\s*\n/).map((paragraph) => `<p style="font-size:16px;line-height:1.6">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
    const heading = audience === 'attended' ? 'Thank you for joining us' : 'We hope to see you another time';
    const result = await this.sendCustomerMail(this.notificationMailer, event, {
      from: this.notificationFrom, to: email,
      messageId: `<event-followup-${deliveryId}@${this.domain}>`,
      subject,
      text: `Hi ${name},\n\n${body}\n\n${event.title}`,
      html: this.customerLayout(event, `<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>${heading}</h1><p style="color:#666">${escapeHtml(event.title)}</p>${paragraphs}`),
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('The email server did not accept this message.');
    return result;
  }

  sendEventInvitation(email, name, event) {
    const eventUrl = `${this.eventDetailsUrl.replace(/\/$/, '')}/${event.id}`;
    const acceptUrl = `${this.invitationResponseUrl}?token=${encodeURIComponent(event.invitationToken)}&action=accept`;
    const declineUrl = `${this.invitationResponseUrl}?token=${encodeURIComponent(event.invitationToken)}&action=decline`;
    const start = formatEventDate(event.startsAt, event.timezone);
    return this.sendCustomerMail(this.invitationMailer, event, { from: this.invitationFrom, to: email, subject: `You are invited to ${event.title}`,
      text: `Hi ${name},\n\nYou have been invited to ${event.title}.\n\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}\n\nConfirm invitation: ${acceptUrl}\nDecline invitation: ${declineUrl}\nView event and register: ${eventUrl}`,
      html: this.customerLayout(event, `<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>You are invited</h1><p style="font-size:16px;line-height:1.6;color:#526078">You have been invited to <strong>${escapeHtml(event.title)}</strong>.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}</div><p style="margin:28px 0 12px"><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;vertical-align:middle;line-height:20px;background:#16a34a;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Confirm invitation</a></p><p style="margin:12px 0"><a href="${escapeHtml(declineUrl)}" style="display:inline-block;vertical-align:middle;line-height:20px;background:#dc2626;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Decline invitation</a></p><p style="margin:20px 0"><a href="${escapeHtml(eventUrl)}" style="display:inline-block;vertical-align:middle;line-height:20px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View event and register</a></p>`) });
  }

  sendGroupInvitation(email, name, group, token) {
    const responseUrl = `${this.groupInvitationUrl}?token=${encodeURIComponent(token)}`;
    const acceptUrl = `${responseUrl}&action=accept`;
    const declineUrl = `${responseUrl}&action=decline`;
    return this.invitationMailer.sendMail({ from: this.invitationFrom, to: email, subject: `You are invited to join ${group.name}`,
      text: `Hi ${name || 'there'},\n\nYou have been invited to join the private group ${group.name}.\n\nAccept invitation: ${acceptUrl}\nDecline invitation: ${declineUrl}\n\nIf you do not yet have an account, register with this email address before accepting.`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name || 'there')},</p><h1>You are invited to a private group</h1><p style="font-size:16px;line-height:1.6;color:#526078">You have been invited to join <strong>${escapeHtml(group.name)}</strong>.</p><p style="font-size:14px;line-height:1.6;color:#526078">If you do not yet have an account, register with this email address before accepting the invitation.</p><p style="margin:28px 0 12px"><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Accept invitation</a></p><p style="margin:12px 0"><a href="${escapeHtml(declineUrl)}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Decline invitation</a></p>`, 'Private group invitation') });
  }

  sendGroupEventNotification(email, name, group, event) {
    const eventUrl = `${this.eventDetailsUrl.replace(/\/$/, '')}/${event.eventId || event.id}`;
    const start = formatEventDate(event.startsAt, event.timezone);
    const end = event.endsAt ? formatEventDate(event.endsAt, event.timezone) : null;
    return this.sendCustomerMail(this.notificationMailer, event, { from: this.notificationFrom, to: email, subject: `New event in ${group.name}: ${event.title}`,
      text: `Hi ${name},\n\n${group.name} has posted a new event: ${event.title}.\n\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}\n\nView event: ${eventUrl}`,
      html: this.customerLayout(event, `<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>New group event</h1><p style="font-size:16px;line-height:1.6;color:#526078"><strong>${escapeHtml(group.name)}</strong> has posted a new event for its members.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><span style="color:#526078">${escapeHtml(event.description || 'Event details are available on the event page.')}</span><br><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}</div><p style="margin:28px 0"><a href="${escapeHtml(eventUrl)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View event</a></p>`, 'Group update') });
  }

  async sendManagerRegistrationNotification(email, managerName, customerName, customerEmail, eventTitle, eventId, registrationId) {
    const [owners] = await this.database.execute('SELECT role FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    if (!['organizer', 'venue_owner'].includes(owners[0]?.role)) return;
    const [events] = await this.database.execute('SELECT participation_fee AS fee, brand_name AS brandName, logo_image AS logoImage FROM events WHERE id = ?', [eventId]);
    const branding = { ...events[0], managerName, title: eventTitle };
    const fee = Number(events[0]?.fee) > 0 ? ` Fee: ${Number(events[0].fee).toFixed(2)} SEK.` : '';
    const registrationUrl = `${this.managerEventUrl.replace(/\/$/, '')}/${eventId}/registrations/${registrationId}`;
    return this.sendCustomerMail(this.notificationMailer, branding, { from: this.notificationFrom, to: email, subject: `New registration for ${eventTitle}`,
      text: `Hi ${managerName},\n\n${customerName} (${customerEmail}) has registered for your event: ${eventTitle}.${fee}`,
      html: this.customerLayout(branding, `<p style="font-size:17px">Hi ${escapeHtml(managerName)},</p><h1>New event registration</h1><p style="font-size:16px;line-height:1.6;color:#526078">A new customer has registered for your event.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px"><strong>Event</strong><br>${escapeHtml(eventTitle)}${Number(events[0]?.fee) > 0 ? `<br><strong>Fee:</strong> ${escapeHtml(Number(events[0].fee).toFixed(2))} SEK` : ''}<br><br><strong>Customer</strong><br>${escapeHtml(customerName)}<br>${escapeHtml(customerEmail)}</div><p style="margin:28px 0"><a href="${escapeHtml(registrationUrl)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View registration</a></p>`, 'Event management') });
  }

}
