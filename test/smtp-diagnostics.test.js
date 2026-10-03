import assert from 'node:assert/strict';
import test from 'node:test';
import { Resolver } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { checkSmtpConnection } from '../server/smtp-diagnostics.js';

test('startup SMTP diagnostics exclude credentials and tolerate a failed configured handshake', async t => {
  t.mock.method(Resolver.prototype, 'resolve4', async () => ['192.0.2.1']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const options = [];
  let closed = 0;
  t.mock.method(nodemailer, 'createTransport', settings => {
    options.push(settings);
    return {
      verify: async () => {
        if (settings.secure) throw Object.assign(new Error('wrong version number'), { code: 'ESOCKET' });
        return true;
      },
      close: () => { closed++; },
    };
  });
  const exitCode = process.exitCode;
  const result = await checkSmtpConnection({
    host: 'smtp.example.test', port: 587, secure: true,
    verification: { user: 'private-user', password: 'private-password' },
  });
  assert.equal(result, false);
  assert.equal(process.exitCode, exitCode);
  assert.deepEqual(options.map(value => value.secure), [true, false]);
  assert.equal(options[1].requireTLS, true);
  assert.equal(closed, 2);
  for (const settings of options) {
    assert.equal(settings.auth, undefined);
    assert.equal(settings.logger, false);
    assert.equal(settings.debug, false);
  }
  assert.ok(!JSON.stringify({ logs, options }).includes('private-'));
});
