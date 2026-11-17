import express from 'express';
import cors from 'cors';
import { createSecurityHeaders } from './middleware/security-headers.js';
import { registerRateLimits } from './middleware/rate-limits.js';
/** Construct HTTP middleware and routes without opening connections or listening. */
export function createApp({ config, api, environment = process.env }) {
  const app = express();
  if (environment.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  if (environment.NODE_ENV === 'production' && environment.REQUIRE_HTTPS !== 'false') {
    app.use((req, res, next) => {
      if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
      return res.status(400).json({ error: 'HTTPS is required.' });
    });
  }
  app.use(createSecurityHeaders({ production: environment.NODE_ENV === 'production' }));
  app.use(
    cors({
      origin: config.runtime.allowedOrigins,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 86400,
    }),
  );
  app.post('/api/payment-webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }));
  app.post(
    '/api/payment-webhooks/stripe/subscriptions',
    express.raw({ type: 'application/json', limit: '1mb' }),
  );
  app.post(
    '/api/payment-webhooks/stripe/thin',
    express.raw({ type: 'application/json', limit: '1mb' }),
  );
  api.registerPaymentWebhooks(app);
  app.use(express.json({ limit: '256kb' }));

  registerRateLimits(app);
  api.register(app);
  return app;
}
