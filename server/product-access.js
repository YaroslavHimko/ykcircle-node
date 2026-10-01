export const PUBLISH_EVENT = 'organizer.publish_event';
export const PRODUCT_DEFAULTS = Object.freeze({ subscriptionsEnabled: false, paidEventsEnabled: false, paidVenuesEnabled: false });
export const accessError = (code, message, status = 403, details = {}) => Object.assign(new Error(message), { code, status, ...details });
export const ownerKey = (owner) => `${owner.type}:${owner.id}`;
export const parseOwner = (value, userId) => {
  const owner = value ?? { type: 'user', id: userId };
  if (!['user', 'organization'].includes(owner.type) || !Number.isSafeInteger(Number(owner.id)) || Number(owner.id) < 1) throw accessError('INVALID_OWNER', 'Choose a valid organizer.', 422);
  return { type: owner.type, id: Number(owner.id) };
};

export class ProductAccess {
  constructor(database) { this.database = database; }
  async configuration(database = this.database) {
    const [rows] = await database.execute("SELECT settings_json AS settings FROM product_configuration WHERE id=1");
    const settings = typeof rows[0]?.settings === 'string' ? JSON.parse(rows[0].settings) : rows[0]?.settings;
    return { ...PRODUCT_DEFAULTS, ...settings };
  }
  async configure(settings, actorId) {
    if (Object.keys(settings).some((key) => !(key in PRODUCT_DEFAULTS)) || Object.values(settings).some((value) => typeof value !== 'boolean')) throw accessError('INVALID_CONFIGURATION', 'Configuration switches must be booleans.', 422);
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('SELECT id FROM product_configuration WHERE id=1 FOR UPDATE');
      const previous = await this.configuration(connection);
      const next = { ...previous, ...settings };
      await connection.execute('UPDATE product_configuration SET settings_json=?, updated_by_user_id=? WHERE id=1', [JSON.stringify(next), actorId]);
      await connection.execute('INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)', [actorId, 'product_configuration_changed', 'product_configuration', '1', JSON.stringify({ previous, next })]);
      await connection.commit(); return next;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async authorizeOwner(owner, actorId, database = this.database) {
    if (owner.type === 'user' && owner.id === Number(actorId)) return;
    if (owner.type === 'organization') {
      const [rows] = await database.execute("SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=? AND role IN ('owner','admin','manager')", [owner.id, actorId]);
      if (rows.length) return;
    }
    throw accessError('OWNER_FORBIDDEN', 'You cannot manage subscriptions or publish for this organizer.');
  }
  async access(owner, database = this.database) {
    const configuration = await this.configuration(database);
    const [entitlements] = await database.execute(`SELECT id, feature, source_type AS source, ends_at AS endsAt FROM platform_entitlements
      WHERE ${owner.type === 'organization' ? 'organization_id=? AND user_id IS NULL' : 'user_id=? AND organization_id IS NULL'}
      AND event_id IS NULL AND revoked_at IS NULL AND starts_at<=UTC_TIMESTAMP() AND (ends_at IS NULL OR ends_at>UTC_TIMESTAMP())
      AND (source_type<>'platform_subscription' OR EXISTS (SELECT 1 FROM platform_subscriptions legacy
        WHERE legacy.id=source_id AND legacy.status IN ('active','trialing') AND legacy.current_period_end>UTC_TIMESTAMP()))`, [owner.id]);
    const publishing = entitlements.find((entry) => entry.feature === PUBLISH_EVENT);
    return { owner, subscriptionsEnabled: configuration.subscriptionsEnabled, canPublish: !configuration.subscriptionsEnabled || Boolean(publishing),
      accessSource: publishing?.source || (!configuration.subscriptionsEnabled ? 'early_access' : null), entitlements };
  }
  async requirePaidFeature(feature, database = this.database) {
    if (!(await this.configuration(database))[feature]) throw accessError(feature === 'paidEventsEnabled' ? 'PAID_EVENTS_DISABLED' : 'PAID_VENUES_DISABLED', feature === 'paidEventsEnabled' ? 'Paid events are currently disabled.' : 'Paid venue bookings are currently disabled.');
  }
  async requirePublication(eventId, actorId, role) {
    // The stored organizing identity, never the acting administrator or seller, owns publishing access.
    const [events] = await this.database.execute(`SELECT id, manager_id AS managerId, organizer_organization_id AS organizationId,
      status, participation_fee AS fee, pricing_type AS pricingType FROM events WHERE deleted_at IS NULL AND (id=? OR series_id=(SELECT COALESCE(series_id,id) FROM events WHERE id=?))`, [eventId, eventId]);
    if (!events.length) throw accessError('EVENT_NOT_FOUND', 'Event not found.', 404);
    for (const event of events) {
      if (Number(event.managerId) !== Number(actorId) && !['admin','manager'].includes(role)) throw accessError('EVENT_FORBIDDEN', 'You cannot publish this event.');
      if (event.status === 'Published') continue;
      const owner = { type: event.organizationId ? 'organization' : 'user', id: Number(event.organizationId || event.managerId) };
      if (owner.type === 'organization') await this.authorizeOwner(owner, actorId);
      const access = await this.access(owner);
      if (!access.canPublish) throw accessError('SUBSCRIPTION_REQUIRED', 'An active organizer subscription is required to publish this event.', 403, { owner, subscribeUrl: `/subscribe?ownerType=${owner.type}&ownerId=${owner.id}&returnTo=${encodeURIComponent(`/profile/events/${eventId}/edit`)}` });
      if (event.pricingType === 'paid' || Number(event.fee) > 0) await this.requirePaidFeature('paidEventsEnabled');
    }
  }
}
