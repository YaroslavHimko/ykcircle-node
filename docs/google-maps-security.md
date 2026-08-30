# Google Maps security release checklist

The browser key is intentionally returned by `GET /api/maps/config`; it is not
a secret. Its protection must be enforced in Google Cloud, not by hiding it in
frontend code or the API response.

Before enabling Maps in production:

1. Create a dedicated browser key and restrict it by HTTP referrer to only
   `https://ykcircle.com/*`, `https://www.ykcircle.com/*`, and any explicitly
   approved staging host. Remove localhost restrictions from the production
   key.
2. Restrict that key to only Maps JavaScript API, Places API (New), and Maps
   Embed API when the embed implementation uses it. Prefer a dedicated Embed
   key if the frontend needs that API separately.
3. In Google Cloud Billing, set a budget and budget alerts. Set per-API daily
   quotas at a level that permits normal traffic but limits financial exposure.
4. Configure Firebase App Check for Maps JavaScript API, add the frontend
   provider, observe metrics, and enforce it once legitimate traffic is
   verified.
5. Never use a browser key for server-side Google web services. If such a
   service is later introduced, create a different key with server IP
   restrictions and only the required API enabled.
6. Rotate keys immediately if a key is committed, added to a template file, or
   otherwise shared outside the intended deployment system.

Backend controls implemented here:

- The Maps configuration endpoint is limited to 30 requests per IP per 15
  minutes and returns `429` with `Retry-After` when exceeded.
- Its result is cacheable for five minutes, reducing normal client traffic.
- The server Maps key is never included in an API response.
- Production startup fails when Maps are enabled without a browser key, and
  refuses a configuration that reuses a server key as the browser key.

The in-memory endpoint limiter is per API instance. Production deployments
with multiple instances should also configure an edge/CDN or load-balancer
rate limit for `GET /api/maps/config` using the same or a stricter threshold.
