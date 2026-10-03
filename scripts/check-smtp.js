import { resolve4, resolve6 } from 'node:dns/promises';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';

// This diagnostic deliberately excludes authentication and never sends mail.
// Run in the deployed application's environment, or use Node's --env-file flag.
const require = createRequire(import.meta.url);

async function probe(host, port, secure, label) {
  const transport = nodemailer.createTransport({
    host, port, secure,
    requireTLS: !secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
  });
  try {
    await transport.verify();
    console.info(JSON.stringify({ label, port, secure, result: 'TLS and SMTP handshake succeeded; authentication and delivery were not tested' }));
    return true;
  } catch (error) {
    // Do not dump transport options, environment variables or protocol traffic.
    console.info(JSON.stringify({ label, port, secure, result: 'failed', code: error.code, command: error.command, reason: error.reason, message: error.message }));
    return false;
  } finally {
    transport.close();
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.info('Run npm run smtp:check in the deployed environment. Reads only SMTP_HOST, SMTP_PORT and SMTP_SECURE. For a local .env: node --env-file=.env scripts/check-smtp.js. No authentication or email sending.');
    return;
  }
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secureValue = (process.env.SMTP_SECURE || 'false').trim().toLowerCase();
  if (!host || !/^[a-z0-9.:-]+$/i.test(host)) throw new Error('Set SMTP_HOST to a hostname or IP address, without a URL or credentials.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be a valid port number.');
  if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(secureValue)) throw new Error('Set SMTP_SECURE to true or false.');
  const secure = ['true', '1', 'yes', 'on'].includes(secureValue);
  console.info(JSON.stringify({ host, port, secure, node: process.version, openssl: process.versions.openssl, nodemailer: require('nodemailer/package.json').version }));
  // These are DNS answers, not proof of which address the transport selected.
  const dns = await Promise.allSettled([resolve4(host), resolve6(host)]);
  console.info(JSON.stringify({ dnsAnswers: dns.map((result, index) => ({ family: index ? 6 : 4, ...(result.status === 'fulfilled' ? { addresses: result.value } : { error: result.reason.code }) })) }));
  const configuredSucceeded = await probe(host, port, secure, 'configured');
  if ((port === 587 && secure) || (port === 465 && !secure)) {
    await probe(host, port, port === 465, 'standard TLS mode for this port');
  }
  // An alternate mode succeeding does not mean the deployed settings are fixed.
  if (!configuredSucceeded) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
