export function registerMapsConfigRoutes(app, { config }) {
  app.get('/api/maps/config', (_req, res) => {
    const maps = config.runtime.maps || {};
    // Browser keys are designed to be visible to clients and must be
    // referrer/API-restricted in Google Cloud. The server key is never sent.
    res.set({
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
      'X-Robots-Tag': 'noindex, noarchive',
    });
    return res.json({
      enabled: Boolean(maps.enabled && maps.browserApiKey),
      browserApiKey: maps.enabled ? maps.browserApiKey || null : null,
      requiresConsent: Boolean(maps.requiresConsent),
    });
  });
}
