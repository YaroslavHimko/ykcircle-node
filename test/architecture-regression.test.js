import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import { Api } from '../src/api/api.js';
import { Queries } from '../src/database/queries.js';
import { createApp } from '../src/api/create-app.js';
import { startBackgroundJobs } from '../src/application/background-jobs.js';
import { startApplication } from '../src/application/bootstrap.js';

const config = () => ({
  runtime: {
    port: 0,
    authSecret: 'test-secret-for-route-inventory',
    allowedOrigins: ['https://client.test'],
    retention: {},
  },
  site: { siteUrl: 'http://localhost', domain: 'localhost', brandName: 'Test' },
});
const listen = async (t, app) => {
  const server = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};

test('feature extraction preserves every route, method, handler count and registration order', async () => {
  const ftp = { publicPath: () => '/uploads/test' };
  const api = new Api({
    config: config(),
    queries: {},
    database: {},
    emailService: {},
    ftpService: ftp,
    eventFtpService: ftp,
    venueFtpService: ftp,
    groupFtpService: ftp,
    articleFtpService: ftp,
  });
  const app = express();
  api.registerPaymentWebhooks(app);
  api.register(app);
  const routes = app._router.stack
    .filter((layer) => layer.route)
    .map(({ route }) => ({
      path: route.path,
      methods: Object.keys(route.methods),
      handlers: route.stack.length,
    }));
  const expected = JSON.parse(
    await readFile(new URL('./fixtures/http-routes.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(routes, expected);
});

test('application middleware preserves raw webhook bytes, JSON bodies, CORS and security headers', async (t) => {
  const webhookPaths = [
    '/api/payment-webhooks/stripe',
    '/api/payment-webhooks/stripe/subscriptions',
    '/api/payment-webhooks/stripe/thin',
  ];
  const api = {
    registerPaymentWebhooks(app) {
      for (const path of webhookPaths)
        app.post(path, (req, res) =>
          res.json({ raw: Buffer.isBuffer(req.body), body: req.body.toString() }),
        );
    },
    register(app) {
      app.post('/api/echo', (req, res) => res.json(req.body));
    },
  };
  const base = await listen(t, createApp({ config: config(), api, environment: {} }));
  const body = '{ "event": "example", "nested": { "id": 1 } }';
  for (const path of webhookPaths) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.deepEqual(await response.json(), { raw: true, body });
  }
  const response = await fetch(base + '/api/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://client.test' },
    body,
  });
  assert.deepEqual(await response.json(), JSON.parse(body));
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://client.test');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /nonce-/);
});

test('production application enforces HTTPS and emits HSTS for secure requests', async (t) => {
  const api = {
    registerPaymentWebhooks() {},
    register(app) {
      app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    },
  };
  const base = await listen(
    t,
    createApp({
      config: config(),
      api,
      environment: { NODE_ENV: 'production', TRUST_PROXY: 'true' },
    }),
  );
  assert.equal((await fetch(base + '/health')).status, 400);
  const response = await fetch(base + '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('strict-transport-security'), /max-age=/);
});

test('background jobs do not overlap, drain in-flight work and clear both timers', async () => {
  const scheduled = [];
  const cleared = [];
  let finish;
  let recoveries = 0;
  const stop = startBackgroundJobs({
    config: config(),
    queries: { applyRetentionPolicies: async () => {} },
    api: {
      ticketSales: {
        recover: () => {
          recoveries += 1;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    },
    timers: {
      setInterval: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearInterval: (handle) => cleared.push(handle),
    },
  });
  await Promise.resolve();
  scheduled[1]();
  assert.equal(recoveries, 1);
  const stopping = stop();
  assert.equal(stop(), stopping);
  assert.deepEqual(cleared, [1, 2]);
  let stopped = false;
  stopping.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish();
  await stopping;
  scheduled[1]();
  assert.equal(recoveries, 1);
});

test('startup failure releases the database without opening a listener', async () => {
  let closes = 0;
  const error = new Error('schema unavailable');
  await assert.rejects(
    startApplication({
      config: config(),
      services: {
        database: {
          close: async () => {
            closes += 1;
          },
        },
        queries: {
          initialize: async () => {
            throw error;
          },
        },
        api: { registerPaymentWebhooks() {}, register() {} },
      },
      environment: {},
    }),
    error,
  );
  assert.equal(closes, 1);
});

test('successful startup returns an idempotent shutdown and drains recovery before closing the database', async () => {
  const events = [];
  const application = await startApplication({
    config: config(),
    services: {
      database: { close: async () => events.push('database closed') },
      queries: {
        initialize: async () => {},
        ensureLegalDocumentVersion: async () => {},
        configureRetentionPolicies: async () => {},
        applyRetentionPolicies: async () => {},
      },
      api: {
        registerPaymentWebhooks() {},
        register() {},
        ticketSales: { recover: async () => events.push('recovery finished') },
      },
    },
    environment: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const closing = application.close();
  assert.equal(application.close(), closing);
  await closing;
  assert.equal(application.server.listening, false);
  assert.deepEqual(events, ['recovery finished', 'database closed']);
});

test('account export includes only the requested user participation and normalizes food choices', async () => {
  const queries = new Queries({
    execute: async (sql, params) => {
      if (sql.includes('FROM users WHERE')) return [[{ id: 42, email: 'member@example.test' }]];
      if (sql.includes('FROM event_participants WHERE')) {
        assert.deepEqual(params, [42]);
        return [[{ eventId: 3, selectedFoodOptions: '["vegetarian",1]' }]];
      }
      return [[]];
    },
  });
  const exported = await queries.dataExport(42);
  assert.deepEqual(exported.eventParticipation, [
    { eventId: 3, selectedFoodOptions: ['vegetarian'] },
  ]);
});
