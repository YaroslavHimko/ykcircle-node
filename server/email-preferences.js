const columns = Object.freeze({
  eventInvitations: 'event_invitations',
  groupInvitations: 'group_invitations',
  groupEventAnnouncements: 'group_event_announcements',
});
export const EMAIL_PREFERENCE_DEFAULTS = Object.freeze(Object.fromEntries(Object.keys(columns).map(key => [key, true])));

const select = Object.entries(columns).map(([key, column]) => `p.${column} AS ${key}`).join(', ');
const normalize = (row = {}) => Object.fromEntries(Object.keys(columns).map(key => [key, row[key] == null ? true : Boolean(Number(row[key]))]));

export async function emailPreferences(database, userId) {
  const [rows] = await database.execute(`SELECT ${select} FROM user_email_preferences p WHERE p.user_id=?`, [userId]);
  return normalize(rows[0]);
}

export async function updateEmailPreferences(database, userId, changes) {
  const entries = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : [];
  if (!entries.length || entries.some(([key, value]) => !Object.hasOwn(columns, key) || typeof value !== 'boolean')) {
    throw Object.assign(new Error('Choose supported email preferences using true or false.'), { status: 400 });
  }
  const names = entries.map(([key]) => columns[key]);
  await database.execute(`INSERT INTO user_email_preferences (user_id, ${names.join(', ')})
    VALUES (?, ${names.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${names.map(name => `${name}=VALUES(${name})`).join(', ')}`,
  [userId, ...entries.map(([, value]) => value)]);
  return emailPreferences(database, userId);
}

export async function optionalEmailAllowed(database, email, preference) {
  if (!Object.hasOwn(columns, preference)) throw new Error('Unknown email preference.');
  const [rows] = await database.execute(`SELECT p.${columns[preference]} AS enabled FROM users u
    LEFT JOIN user_email_preferences p ON p.user_id=u.id WHERE LOWER(u.email)=LOWER(?) AND u.deleted_at IS NULL`, [email.trim()]);
  return rows[0]?.enabled == null || Boolean(Number(rows[0].enabled));
}

export function registerEmailPreferenceRoutes(app, { authenticate, ensureTable, database }) {
  app.get('/api/auth/profile/email-preferences', authenticate, async (req, res) => {
    try { await ensureTable(); return res.json(await emailPreferences(database, req.user.id)); }
    catch { return res.status(500).json({ error: 'Unable to load email preferences.' }); }
  });
  app.patch('/api/auth/profile/email-preferences', authenticate, async (req, res) => {
    try { await ensureTable(); return res.json(await updateEmailPreferences(database, req.user.id, req.body)); }
    catch (error) { return res.status(error.status || 500).json({ error: error.status === 400 ? error.message : 'Unable to update email preferences.' }); }
  });
}
