import express from 'express';
import path from 'node:path';
import cors from 'cors';
import { Database } from './database.js';
import { EmailService } from './email-service.js';
import { Configuration } from './configuration.js';
import { Queries } from './queries.js';
import { Api } from './api.js';
import { FtpService } from './ftp-service.js';

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
  const groupFtpService = new FtpService(config.ftp.groups);
  const articleFtpService = new FtpService(config.ftp.articles);
  const app = express();
  app.use(cors(config.runtime.allowedOrigins?.length ? { origin: config.runtime.allowedOrigins } : undefined));
  app.use(express.json());
  // Keep this before API routes and any catch-all middleware so uploads are
  // always served as files by the API process.
  app.use('/uploads', express.static(path.resolve(process.cwd(), config.runtime.uploadsDir)));
  new Api({ config, database, queries, emailService, ftpService, eventFtpService, groupFtpService, articleFtpService }).register(app);

  const server = app.listen(config.runtime.port, () => console.log(`API listening on port ${config.runtime.port}`));
  const shutdown = () => server.close(async () => { await database.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((error) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
