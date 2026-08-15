import nodemailer from 'nodemailer';
import crypto from 'node:crypto';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const eventFee = (event) => Number(event.fee) > 0 ? `\nFee: ${Number(event.fee).toFixed(2)} SEK` : '';
const eventFeeHtml = (event) => Number(event.fee) > 0 ? `<br><strong>Fee:</strong> ${escapeHtml(Number(event.fee).toFixed(2))} SEK` : '';

export class EmailService {
  constructor({ smtp, domain, brandName, noReplyFrom, verificationUrl, applicationUrl, managerEventUrl, eventDetailsUrl, invitationResponseUrl, loginUrl, unsubscribeUrl, unsubscribeEndpointUrl, unsubscribeSecret, notificationFrom, invitationFrom, database }) {
    this.domain = domain;
    this.brandName = brandName;
    this.noReplyFrom = noReplyFrom;
    this.smtp = smtp;
    this.verificationUrl = verificationUrl;
    this.applicationUrl = applicationUrl;
    this.managerEventUrl = managerEventUrl;
    this.eventDetailsUrl = eventDetailsUrl;
    this.invitationResponseUrl = invitationResponseUrl;
    this.loginUrl = loginUrl;
    this.notificationFrom = notificationFrom;
    this.invitationFrom = invitationFrom;
    this.database = database;
    this.unsubscribeUrl = unsubscribeUrl;
    this.unsubscribeEndpointUrl = unsubscribeEndpointUrl;
    this.unsubscribeSecret = unsubscribeSecret;
    this.mailer = this.createMailer(smtp.verification);
    this.notificationMailer = this.createMailer(smtp.applicationNotification);
    this.invitationMailer = this.createMailer(smtp.invitation);
    for (const transport of [this.mailer, this.notificationMailer, this.invitationMailer]) {
      const sendMail = transport.sendMail.bind(transport);
      transport.sendMail = async (message) => {
        const recipients = (Array.isArray(message.to) ? message.to : [message.to]).map((value) => typeof value === 'string' ? value : value?.address).filter(Boolean);
        if (!recipients.length) return { accepted: [], rejected: [] };
        const [blocked] = await this.database.execute(`SELECT email FROM unsubscribed_emails WHERE LOWER(email) IN (${recipients.map(() => '?').join(',')})`, recipients.map((email) => email.toLowerCase()));
        const blockedSet = new Set(blocked.map(({ email }) => email.toLowerCase()));
        const allowed = recipients.filter((email) => !blockedSet.has(email.toLowerCase()));
        if (!allowed.length) return { accepted: [], rejected: recipients, suppressed: true };
        const token = this.unsubscribeToken(allowed[0]);
        const unsubscribeLink = `${this.unsubscribeEndpointUrl}?token=${encodeURIComponent(token)}`;
        return sendMail({ ...message, to: allowed, text: `${message.text || ''}\n\nUnsubscribe from future emails: ${unsubscribeLink}`, html: `${message.html || ''}<p style="font-size:12px;color:#8994a8;text-align:center;margin-top:28px"><a href="${escapeHtml(unsubscribeLink)}">Unsubscribe from future emails</a></p>` });
      };
    }
  }

  unsubscribeToken(email) { const payload = Buffer.from(email.trim().toLowerCase()).toString('base64url'); const signature = crypto.createHmac('sha256', this.unsubscribeSecret).update(payload).digest('base64url'); return `${payload}.${signature}`; }

  createMailer(credentials) {
    return nodemailer.createTransport({ host: this.smtp.host, port: this.smtp.port, secure: this.smtp.secure,
      auth: credentials?.user ? { user: credentials.user, pass: credentials.password } : undefined });
  }

  layout(content, subtitle = '') {
    const brandName = escapeHtml(this.brandName);
    return `<div style="margin:0;background:#f5f7fb;padding:40px 16px;font-family:Arial,sans-serif;color:#172033"><div style="max-width:600px;margin:auto;background:#fff;border:1px solid #e7ebf3;border-radius:16px;overflow:hidden"><div style="background:#172033;padding:28px 32px"><div style="font-size:22px;font-weight:700;color:#fff">${brandName}</div>${subtitle ? `<div style="color:#b9c5d8;font-size:13px;margin-top:8px">${subtitle}</div>` : ''}</div><div style="padding:36px 32px">${content}</div><div style="border-top:1px solid #e7ebf3;padding:20px 32px;font-size:12px;color:#8994a8">© ${brandName}</div></div></div>`;
  }

  sendVerification(email, name, token) {
    const url = `${this.verificationUrl}?token=${encodeURIComponent(token)}`;
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Verify your ${this.brandName} email address`,
      text: `Hi ${name},\n\nVerify your email address by opening this link:\n${url}\n\nThis link expires in 24 hours.`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1 style="font-size:28px;line-height:1.2;margin:0 0 16px">Confirm your email address</h1><p style="font-size:16px;line-height:1.6;color:#526078">Thanks for creating your account. Click the button below to verify your email and finish setting up your profile.</p><p style="margin:28px 0"><a href="${url}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Verify my email</a></p><p style="font-size:13px;line-height:1.5;color:#7b879b">This verification link expires in 24 hours. If you did not create this account, you can safely ignore this email.</p>`) });
  }

  sendAccountDeleted(email, name) {
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Your ${this.brandName} account was deleted`,
      text: `Hi ${name},\n\nYour ${this.brandName} account has been deleted successfully. If you did not request this, please contact us immediately.`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Account deleted</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your ${escapeHtml(this.brandName)} account has been deleted successfully. You will no longer be able to sign in with this account.</p><p style="font-size:13px;color:#7b879b">If you did not request this change, please contact us immediately.</p>`) });
  }

  sendApplicationReceived(email, activity) {
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `We received your ${this.brandName} application`,
      text: `Thanks for your application.\n\nWe received your application for: ${activity}.\n\nUse the same email address when you register or log in.\n\nLog in to track your application: ${this.loginUrl}`,
      html: this.layout(`<h1>Application received</h1><p style="font-size:16px;line-height:1.6;color:#526078">Thanks for getting in touch. We have received your application and our team will review it shortly.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;margin:24px 0;font-size:15px"><span style="color:#718096">Activity</span><br><strong>${escapeHtml(activity)}</strong></div><p style="font-size:16px;line-height:1.6;color:#526078">Use the same email address you entered in the contact form when you register or log in.</p><p style="margin:28px 0"><a href="${escapeHtml(this.loginUrl)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Log in to track status</a></p>`) });
  }

  sendRegistrationConfirmation(email, name, event) {
    const start = new Date(event.startsAt).toLocaleString();
    const end = event.endsAt ? new Date(event.endsAt).toLocaleString() : null;
    const details = `Event: ${event.title}\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}\nCapacity: ${event.capacity ?? 'Unlimited'}${eventFee(event)}\nRegistration status: Pending`;
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Registration received: ${event.title}`,
      text: `Hi ${name},\n\nYour registration has been received and is pending manager confirmation.\n\n${details}`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Registration received</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your registration is pending manager confirmation.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><span style="color:#526078">${escapeHtml(event.description || 'Event registration')}</span><br><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}<br><strong>Capacity:</strong> ${escapeHtml(String(event.capacity ?? 'Unlimited'))}${eventFeeHtml(event)}<br><strong>Status:</strong> Pending</div>`) });
  }

  sendRegistrationApproved(email, name, event) {
    const start = new Date(event.startsAt).toLocaleString();
    const end = event.endsAt ? new Date(event.endsAt).toLocaleString() : null;
    const details = `Event: ${event.title}\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}\nCapacity: ${event.capacity ?? 'Unlimited'}${eventFee(event)}\nRegistration status: Confirmed`;
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Registration confirmed: ${event.title}`,
      text: `Hi ${name},\n\nYour registration has been confirmed by the event manager.\n\n${details}`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Registration confirmed</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your registration has been confirmed by the event manager. We look forward to seeing you there.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><span style="color:#526078">${escapeHtml(event.description || 'Event registration')}</span><br><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}<br><strong>Capacity:</strong> ${escapeHtml(String(event.capacity ?? 'Unlimited'))}${eventFeeHtml(event)}<br><strong>Status:</strong> Confirmed</div>`) });
  }

  sendRegistrationWithdrawal(email, name, event) {
    const start = new Date(event.startsAt).toLocaleString();
    const end = event.endsAt ? new Date(event.endsAt).toLocaleString() : null;
    return this.mailer.sendMail({ from: this.noReplyFrom, to: email, subject: `Withdrawal received: ${event.title}`,
      text: `Hi ${name},\n\nYour withdrawal from ${event.title} has been received.\n\nEvent: ${event.title}\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}\nStatus: Withdrawn`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>Withdrawal received</h1><p style="font-size:16px;line-height:1.6;color:#526078">Your withdrawal from this event has been received successfully.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}<br><strong>Status:</strong> Withdrawn</div>`) });
  }

  sendEventInvitation(email, name, event) {
    const eventUrl = `${this.eventDetailsUrl.replace(/\/$/, '')}/${event.id}`;
    const acceptUrl = `${this.invitationResponseUrl}?token=${encodeURIComponent(event.invitationToken)}&action=accept`;
    const declineUrl = `${this.invitationResponseUrl}?token=${encodeURIComponent(event.invitationToken)}&action=decline`;
    const start = new Date(event.startsAt).toLocaleString();
    return this.invitationMailer.sendMail({ from: this.invitationFrom, to: email, subject: `You are invited to ${event.title}`,
      text: `Hi ${name},\n\nYou have been invited to ${event.title}.\n\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}\n\nConfirm invitation: ${acceptUrl}\nDecline invitation: ${declineUrl}\nView event and register: ${eventUrl}`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>You are invited</h1><p style="font-size:16px;line-height:1.6;color:#526078">You have been invited to <strong>${escapeHtml(event.title)}</strong>.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}</div><p style="margin:28px 0 12px"><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;vertical-align:middle;line-height:20px;background:#16a34a;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Confirm invitation</a></p><p style="margin:12px 0"><a href="${escapeHtml(declineUrl)}" style="display:inline-block;vertical-align:middle;line-height:20px;background:#dc2626;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">Decline invitation</a></p><p style="margin:20px 0"><a href="${escapeHtml(eventUrl)}" style="display:inline-block;vertical-align:middle;line-height:20px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View event and register</a></p>`) });
  }

  sendGroupEventNotification(email, name, group, event) {
    const eventUrl = `${this.eventDetailsUrl.replace(/\/$/, '')}/${event.eventId || event.id}`;
    const start = new Date(event.startsAt).toLocaleString();
    const end = event.endsAt ? new Date(event.endsAt).toLocaleString() : null;
    return this.notificationMailer.sendMail({ from: this.notificationFrom, to: email, subject: `New event in ${group.name}: ${event.title}`,
      text: `Hi ${name},\n\n${group.name} has posted a new event: ${event.title}.\n\nLocation: ${event.location || 'To be announced'}\nStarts: ${start}${end ? `\nEnds: ${end}` : ''}\n\nView event: ${eventUrl}`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(name)},</p><h1>New group event</h1><p style="font-size:16px;line-height:1.6;color:#526078"><strong>${escapeHtml(group.name)}</strong> has posted a new event for its members.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px;line-height:1.7"><strong>${escapeHtml(event.title)}</strong><br><span style="color:#526078">${escapeHtml(event.description || 'Event details are available on the event page.')}</span><br><br><strong>Location:</strong> ${escapeHtml(event.location || 'To be announced')}<br><strong>Starts:</strong> ${escapeHtml(start)}${end ? `<br><strong>Ends:</strong> ${escapeHtml(end)}` : ''}</div><p style="margin:28px 0"><a href="${escapeHtml(eventUrl)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View event</a></p>`, 'Group update') });
  }

  async sendManagerRegistrationNotification(email, managerName, customerName, customerEmail, eventTitle, eventId, registrationId) {
    const [owners] = await this.database.execute('SELECT role FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    if (owners[0]?.role !== 'organizer') return;
    const [events] = await this.database.execute('SELECT participation_fee AS fee FROM events WHERE id = ?', [eventId]);
    const fee = Number(events[0]?.fee) > 0 ? ` Fee: ${Number(events[0].fee).toFixed(2)} SEK.` : '';
    const registrationUrl = `${this.managerEventUrl.replace(/\/$/, '')}/${eventId}/registrations/${registrationId}`;
    return this.notificationMailer.sendMail({ from: this.notificationFrom, to: email, subject: `New registration for ${eventTitle}`,
      text: `Hi ${managerName},\n\n${customerName} (${customerEmail}) has registered for your event: ${eventTitle}.${fee}`,
      html: this.layout(`<p style="font-size:17px">Hi ${escapeHtml(managerName)},</p><h1>New event registration</h1><p style="font-size:16px;line-height:1.6;color:#526078">A new customer has registered for your event.</p><div style="background:#f8fafc;border-radius:10px;padding:16px;font-size:15px"><strong>Event</strong><br>${escapeHtml(eventTitle)}${Number(events[0]?.fee) > 0 ? `<br><strong>Fee:</strong> ${escapeHtml(Number(events[0].fee).toFixed(2))} SEK` : ''}<br><br><strong>Customer</strong><br>${escapeHtml(customerName)}<br>${escapeHtml(customerEmail)}</div><p style="margin:28px 0"><a href="${escapeHtml(registrationUrl)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View registration</a></p>`, 'Event management') });
  }

  async notifyAdmins({ applicationId, email, phone, activity, additionalInformation }) {
    if (!this.smtp.host) throw new Error('SMTP_HOST is not configured');
    const [admins] = await this.database.execute("SELECT email FROM users WHERE role = 'admin'");
    if (!admins.length) return;
    const url = `${this.applicationUrl.replace(/\/$/, '')}/${applicationId}`;
    const phoneText = phone || 'Not provided';
    const notesText = additionalInformation || 'None';
    return this.notificationMailer.sendMail({ from: this.notificationFrom, to: admins.map(({ email: address }) => address), subject: 'New application received',
      text: `A new application was received.\n\nApplicant email: ${email}\nPhone: ${phoneText}\nActivity: ${activity}\nAdditional notes: ${notesText}\n\nView application: ${url}`,
      html: this.layout(`<div style="display:inline-block;background:#e0f2fe;color:#0369a1;border-radius:999px;padding:6px 11px;font-size:12px;font-weight:700">NEW APPLICATION</div><h1>A new application has arrived</h1><table style="width:100%;border-collapse:collapse;font-size:15px"><tr><td style="padding:13px 0;color:#718096">Applicant email</td><td style="padding:13px 0;font-weight:700">${escapeHtml(email)}</td></tr><tr><td style="padding:13px 0;color:#718096">Phone</td><td style="padding:13px 0">${escapeHtml(phoneText)}</td></tr><tr><td style="padding:13px 0;color:#718096">Activity</td><td style="padding:13px 0">${escapeHtml(activity)}</td></tr></table><div style="margin-top:24px"><div style="font-size:13px;color:#718096;margin-bottom:8px">Additional notes</div><div style="background:#f8fafc;border-radius:10px;padding:16px;white-space:pre-wrap">${escapeHtml(notesText)}</div></div><p style="margin:28px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:9px;padding:14px 22px;font-weight:700">View application</a></p>`, 'Application management') });
  }
}
