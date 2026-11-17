import { Database } from '../database/database.js';
import { Queries } from '../database/queries.js';
import { EmailService } from '../services/email/email-service.js';
import { FtpService } from '../services/storage/ftp-service.js';
import { Api } from '../api/api.js';
/** Composition root: concrete adapters are constructed here, never inside routes. */
export function createServices(config) {
  const database = new Database(config.database);
  const queries = new Queries(database);
  const emailService = new EmailService({
    smtp: config.email.smtp,
    domain: config.site.domain,
    siteUrl: config.site.siteUrl,
    verificationUrl: config.email.urls.verification,
    passwordResetUrl: config.email.urls.passwordReset,
    managerEventUrl: config.email.urls.managerEvent,
    eventDetailsUrl: config.email.urls.eventDetails,
    invitationResponseUrl: config.email.urls.invitationResponse,
    groupInvitationUrl: config.email.urls.groupInvitation,
    unsubscribeEndpointUrl: config.email.urls.unsubscribeEndpoint,
    unsubscribeSecret: config.runtime.authSecret,
    brandName: config.site.brandName,
    noReplyFrom: config.email.from.noReply,
    notificationFrom: config.email.from.notification,
    invitationFrom: config.email.from.invitation,
    replyTo: config.email.replyTo,
    privacyReplyTo: config.operator.privacyEmail,
    database,
  });
  const ftpService = new FtpService(config.ftp.profilePictures);
  const eventFtpService = new FtpService(config.ftp.events);
  const venueFtpService = new FtpService(config.ftp.venues);
  const groupFtpService = new FtpService(config.ftp.groups);
  const articleFtpService = new FtpService(config.ftp.articles);
  const api = new Api({
    config,
    database,
    queries,
    emailService,
    ftpService,
    eventFtpService,
    venueFtpService,
    groupFtpService,
    articleFtpService,
  });

  return { database, queries, api };
}
