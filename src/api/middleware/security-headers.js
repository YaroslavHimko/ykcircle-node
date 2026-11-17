import crypto from 'node:crypto';
export const createSecurityHeaders =
  ({ production = false } = {}) =>
  (req, res, next) => {
    req.cspNonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self' 'nonce-${req.cspNonce}'; style-src 'self' 'unsafe-inline'`,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      ...(production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    });
    next();
  };
