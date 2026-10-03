import { Resolver } from 'node:dns/promises';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';

// This diagnostic deliberately excludes authentication and never sends mail.
// Shared by the optional startup diagnostic and the command-line check.
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
    console.info('SMTP diagnostic:', JSON.stringify({ label, port, secure, result: 'TLS and SMTP handshake succeeded; authentication and delivery were not tested' }));
    return true;
  } catch (error) {
    // Do not dump transport options, environment variables or protocol traffic.
    console.info('SMTP diagnostic:', JSON.stringify({ label, port, secure, result: 'failed', code: error.code, command: error.command, reason: error.reason, message: error.message }));
    return false;
  } finally {
    transport.close();
  }
}

export async function checkSmtpConnection({ host, port, secure }) {
  if (!host || !/^[a-z0-9.:-]+$/i.test(host)) throw new Error('SMTP diagnostic requires a hostname or IP address, without a URL or credentials.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP diagnostic requires a valid port.');
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  console.info('SMTP diagnostic:', JSON.stringify({ host, port, secure, node: process.version, openssl: process.versions.openssl, nodemailer: require('nodemailer/package.json').version }));
  // These are DNS answers, not proof of which address the transport selected.
  const dns = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  console.info('SMTP diagnostic:', JSON.stringify({ dnsAnswers: dns.map((result, index) => ({ family: index ? 6 : 4, ...(result.status === 'fulfilled' ? { addresses: result.value } : { error: result.reason.code }) })) }));
  const configuredSucceeded = await probe(host, port, secure, 'configured');
  if ((port === 587 && secure) || (port === 465 && !secure)) {
    await probe(host, port, port === 465, 'standard TLS mode for this port');
  }
  return configuredSucceeded;
}
