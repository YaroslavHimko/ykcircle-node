import {
  emailPreferences,
  updateEmailPreferences,
} from '../../../database/repositories/accounts/email-preferences.repository.js';
export function registerEmailPreferenceRoutes(app, { authenticate, ensureTable, database }) {
  app.get('/api/auth/profile/email-preferences', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await emailPreferences(database, req.user.id));
    } catch {
      return res.status(500).json({ error: 'Unable to load email preferences.' });
    }
  });
  app.patch('/api/auth/profile/email-preferences', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(await updateEmailPreferences(database, req.user.id, req.body));
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.status === 400 ? error.message : 'Unable to update email preferences.',
      });
    }
  });
}
