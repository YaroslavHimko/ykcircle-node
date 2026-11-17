import crypto from 'node:crypto';

export function registerPrivacyContactRoutes(app, { optionalAuthenticate, ensureTable, queries }) {
  app.post('/api/contact', optionalAuthenticate, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || req.user?.email || '')
      .trim()
      .toLowerCase();
    const category = String(req.body.category || 'General');
    const message = String(req.body.message || req.body.additionalInformation || '').trim();
    if (
      !name ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !['General', 'Privacy', 'Account', 'Safety', 'Other'].includes(category) ||
      !message ||
      message.length > 10000
    )
      return res.status(422).json({
        error: 'Provide your name, a valid email, category, and a message up to 10,000 characters.',
      });
    try {
      await ensureTable();
      const reference = `CON-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      await queries.createPrivacyRequest({
        reference,
        userId: req.user?.id || null,
        name,
        email,
        category,
        message,
      });
      await queries.audit(
        req.user?.id || null,
        'contact_request_created',
        'privacy_request',
        reference,
        { category },
      );
      return res.status(201).json({ reference, message: 'Your request has been received.' });
    } catch (error) {
      console.error('Contact submission failed:', error.message);
      return res.status(500).json({ error: 'Unable to save your message right now.' });
    }
  });
}
