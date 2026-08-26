# Cookie and deployment audit

Run this checklist against the deployed public website before every beta release.

- Capture a fresh browser network trace before consent, after Reject non-essential, and after Accept all.
- Record every cookie, local-storage value, SDK, pixel, iframe, map, video embed, error-monitoring script and CDN feature.
- Verify that analytics and marketing tools do not load before the corresponding opt-in, and that Reject is as easy as Accept.
- Implement a persistent Cookie Settings link in the actual frontend footer. This API repository contains no frontend cookie banner.
- Confirm TLS certificates, HTTP-to-HTTPS redirect/proxy handling, HSTS, production CORS origins, trusted-proxy configuration and backup restore testing.
- Confirm FTP storage is private at the hosting-provider level; API authorization cannot protect files exposed directly by a web server or CDN.
- Verify public/private pages emit appropriate `noindex` and do not place private URLs, titles or images in a sitemap, Open Graph tags, structured data or caches.
