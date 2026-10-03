import { checkSmtpConnection } from '../server/smtp-diagnostics.js';

async function main() {
  if (process.argv.includes('--help')) {
    console.info('Run npm run smtp:check in the deployed environment. Reads only SMTP_HOST, SMTP_PORT and SMTP_SECURE. For a local .env: node --env-file=.env scripts/check-smtp.js. On managed hosting without SSH Node access, deploy and set SMTP_DIAGNOSTICS=true to run from the application. No authentication or email sending.');
    return;
  }
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secureValue = (process.env.SMTP_SECURE || 'false').trim().toLowerCase();
  if (!host || !/^[a-z0-9.:-]+$/i.test(host)) throw new Error('Set SMTP_HOST to a hostname or IP address, without a URL or credentials.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port number.');
  if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(secureValue)) throw new Error('Set SMTP_SECURE to true or false.');
  const secure = ['true', '1', 'yes', 'on'].includes(secureValue);
  if (!await checkSmtpConnection({ host, port, secure })) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
