import { createApp } from '../api/create-app.js';
import { createServices } from './create-services.js';
import { startBackgroundJobs } from './background-jobs.js';
import {
  legalDocument,
  legalDocuments,
  checkLegalStartup,
} from '../services/legal/legal-documents.js';

/** Initialize external resources and begin listening. Importing this module starts nothing. */
export async function startApplication({
  config,
  services = createServices(config),
  environment = process.env,
  logger = console,
}) {
  const { database, queries, api } = services;
  let server;
  let stopJobs = async () => {};
  try {
    const app = createApp({ config, api, environment });
    await queries.initialize();
    for (const descriptor of legalDocuments()) {
      await queries.ensureLegalDocumentVersion(await legalDocument(descriptor.slug, config));
    }
    await checkLegalStartup(config, logger);
    await queries.configureRetentionPolicies(config.runtime.retention);
    try {
      await queries.applyRetentionPolicies(config.runtime.retention);
    } catch (error) {
      logger.error('Retention cleanup failed:', error.message);
    }

    server = await new Promise((resolve, reject) => {
      const listener = app.listen(config.runtime.port);
      listener.once('error', reject);
      listener.once('listening', () => {
        listener.removeListener('error', reject);
        resolve(listener);
      });
    });
    stopJobs = startBackgroundJobs({ config, queries, api, logger });
    logger.info(`API listening on port ${server.address().port}`);
    if (environment.SMTP_DIAGNOSTICS === 'true') {
      void import('../services/email/smtp-diagnostics.js')
        .then(({ checkSmtpConnection }) => checkSmtpConnection(config.email.smtp))
        .catch((error) => logger.error('SMTP diagnostic failed:', error.message));
    }

    let closing;
    const close = () => {
      closing ||= (async () => {
        try {
          await Promise.all([
            stopJobs(),
            new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
          ]);
        } finally {
          await database.close();
        }
      })();
      return closing;
    };
    return { app, server, close };
  } catch (error) {
    await stopJobs();
    if (server) await new Promise((resolve) => server.close(resolve));
    await database.close();
    throw error;
  }
}
