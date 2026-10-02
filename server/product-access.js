export const PUBLISH_EVENT = 'organizer.publish_event';
export const PUBLISH_ARTICLE = 'author.publish_article';
export const PRODUCT_DEFAULTS = Object.freeze({ subscriptionsEnabled: false, paidEventsEnabled: false, paidVenuesEnabled: false, paidServicesEnabled: false, articlesPerMonth: 1 });
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
    if (Object.entries(settings).some(([key, value]) => !(key in PRODUCT_DEFAULTS) || (key === 'articlesPerMonth' ? !Number.isInteger(value) || value < 0 || value > 1000 : typeof value !== 'boolean'))) throw accessError('INVALID_CONFIGURATION', 'Use boolean switches and a monthly article limit between 0 and 1,000.', 422);
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
  async articleAccess(userId, database = this.database) {
    const configuration = await this.configuration(database);
    const [entitlements] = await database.execute(`SELECT e.id, e.feature, e.source_type AS source, e.ends_at AS endsAt
      FROM platform_entitlements e JOIN platform_subscriptions s ON s.id=e.source_id
      WHERE e.user_id=? AND e.organization_id IS NULL AND e.event_id IS NULL AND e.feature=?
      AND e.source_type='subscription' AND e.revoked_at IS NULL AND e.starts_at<=UTC_TIMESTAMP()
      AND e.ends_at>UTC_TIMESTAMP() AND s.subscriber_user_id=e.user_id AND s.subscriber_organization_id IS NULL
      AND s.status='active' AND s.current_period_end>UTC_TIMESTAMP()`, [userId, PUBLISH_ARTICLE]);
    const [usage] = await database.execute(`SELECT COUNT(*) AS used,
      DATE_ADD(DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01'), INTERVAL 1 MONTH) AS resetsAt
      FROM article_publications WHERE user_id=? AND published_at>=DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')
      AND published_at<DATE_ADD(DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01'), INTERVAL 1 MONTH)`, [userId]);
    const monthlyLimit = Number(configuration.articlesPerMonth);
    const used = Number(usage[0]?.used || 0);
    const remaining = Math.max(0, monthlyLimit - used);
    return { owner: { type: 'user', id: userId }, subscriptionsEnabled: configuration.subscriptionsEnabled, hasSubscription: entitlements.length > 0,
      canPublish: !configuration.subscriptionsEnabled || (entitlements.length > 0 && remaining > 0), accessSource: !configuration.subscriptionsEnabled ? 'early_access' : entitlements.length ? 'subscription' : null,
      monthlyLimit, used, remaining, resetsAt: usage[0]?.resetsAt || null, entitlements };
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
