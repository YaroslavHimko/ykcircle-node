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
    smtp: config.smtp,
    domain: config.domain,
    verificationUrl: config.emailVerificationUrl,
    applicationUrl: config.adminApplicationUrl,
    managerEventUrl: config.managerEventUrl,
    eventDetailsUrl: config.eventDetailsUrl,
    invitationResponseUrl: config.invitationResponseUrl,
    loginUrl: config.loginUrl,
    unsubscribeUrl: config.unsubscribeUrl,
    unsubscribeEndpointUrl: config.unsubscribeEndpointUrl,
    unsubscribeSecret: config.authSecret,
    brandName: config.brandName,
    noReplyFrom: config.noReplyFrom,
    notificationFrom: config.applicationNotificationFrom,
    invitationFrom: config.invitationFrom,
    database,
  });
  const ftpService = new FtpService(config.ftp);
  const eventFtpService = new FtpService(config.ftpEvents);
  const groupFtpService = new FtpService(config.ftpGroups);
  const articleFtpService = new FtpService(config.ftpArticles);
  const app = express();
  app.use(cors(config.allowedOrigins?.length ? { origin: config.allowedOrigins } : undefined));
  app.use(express.json());
  // Keep this before API routes and any catch-all middleware so uploads are
  // always served as files by the API process.
  app.use('/uploads', express.static(path.resolve(process.cwd(), config.uploadsDir)));
  new Api({ config, database, queries, emailService, ftpService, eventFtpService, groupFtpService, articleFtpService }).register(app);

  const server = app.listen(config.port, () => console.log(`API listening on port ${config.port}`));
  const shutdown = () => server.close(async () => { await database.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((error) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
