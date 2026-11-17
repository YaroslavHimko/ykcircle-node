import { Configuration } from '../configuration/configuration.js';
import values from '../configuration/environment.js';
import { startApplication } from './bootstrap.js';

async function main() {
  const config = new Configuration(values);
  console.info('Google Maps configuration:', {
    enabled: config.runtime.maps.enabled,
    browserApiKeyPresent: Boolean(config.runtime.maps.browserApiKey),
    requiresConsent: config.runtime.maps.requiresConsent,
  });
  // Log only connection settings, never SMTP credentials or the full config.
  console.info('SMTP connection configuration:', {
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    node: process.version,
    openssl: process.versions.openssl,
  });

  const application = await startApplication({ config });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    try {
      await application.close();
    } catch (error) {
      console.error('Shutdown failed:', error);
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start API:', error);
  process.exitCode = 1;
});
