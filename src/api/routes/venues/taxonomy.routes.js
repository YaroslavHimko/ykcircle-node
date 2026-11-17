export function registerVenuesTaxonomyRoutes(app, { ensureTable, queries }) {
  app.get('/api/venue-types', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.venueTypes());
    } catch (error) {
      console.error('Venue type lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue types.' });
    }
  });
  app.get('/api/venue-event-types', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.venueEventTypes());
    } catch (error) {
      console.error('Venue event-type lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue event types.' });
    }
  });
  app.get('/api/venue-amenities', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.venueAmenities());
    } catch (error) {
      console.error('Venue amenity lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load venue amenities.' });
    }
  });
}
