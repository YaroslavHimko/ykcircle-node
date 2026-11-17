export function registerMapsActivityRoutes(
  app,
  { authenticate, placesActivityReportLimit, anonymisedIp },
) {
  app.post('/api/maps/places-activity', authenticate, placesActivityReportLimit, (req, res) => {
    const count = Number(req.body?.count);
    const windowMs = Number(req.body?.windowMs);
    if (
      !Number.isInteger(count) ||
      count < 20 ||
      count > 500 ||
      !Number.isInteger(windowMs) ||
      windowMs < 60 * 1000 ||
      windowMs > 60 * 60 * 1000
    )
      return res.status(422).json({ error: 'Places activity report is invalid.' });
    console.warn('Unusually high client-reported Google Places activity.', {
      accountId: req.user.id,
      ipHash: anonymisedIp(req),
      route: req.originalUrl,
      action: 'places-autocomplete',
      count,
      windowMs,
    });
    return res.status(202).json({ accepted: true });
  });
}
