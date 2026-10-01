import crypto from 'node:crypto';
import { ProductAccess, PUBLISH_EVENT, accessError, ownerKey, parseOwner } from './product-access.js';

const providerId = (value) => typeof value === 'string' ? value : value?.id;
export const safeReturnPath = (value) => /^\/profile\/events(?:\/[1-9]\d*\/edit)?$/.test(value || '') ? value : '/profile/events';
export const subscriptionPeriod = (subscription) => {
  const items = subscription.items?.data || [];
  return { start: subscription.current_period_start || Math.max(0, ...items.map((item) => item.current_period_start || 0)) || null,
    end: subscription.current_period_end || Math.min(...items.map((item) => item.current_period_end || 0)) || null };
};
export const subscriptionHasAccess = (subscription, now = Date.now() / 1000) => {
  const period = subscriptionPeriod(subscription);
  return ['active', 'trialing'].includes(subscription.status) && Number.isFinite(period.end) && period.end > now;
};

export class OrganizerSubscriptions {
  constructor({ queries, stripe, siteUrl }) {
    this.queries = queries; this.database = queries.database; this.stripe = stripe; this.siteUrl = siteUrl.replace(/\/$/, '');
    this.access = new ProductAccess(this.database);
  }
  async audit(database, actorId, action, id, details = {}) {
    await database.execute('INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)', [actorId, action, 'organizer_subscription', String(id), JSON.stringify(details)]);
  }
  async withOwnerLock(owner, callback) {
    const connection = await this.database.getConnection();
    const key = `yk-sub-${ownerKey(owner)}`;
    let locked = false;
    try {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [key]);
      locked = Number(rows[0]?.acquired) === 1;
      if (!locked) throw accessError('SUBSCRIPTION_BUSY', 'Subscription is updating. Please retry.', 409);
      return await callback(connection);
    } finally { try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [key]); } finally { connection.release(); } }
  }
  async owners(userId) {
    const [organizations] = await this.database.execute("SELECT o.id, o.name, 'organization' AS type FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.user_id=? AND m.role IN ('owner','admin','manager') ORDER BY o.name", [userId]);
    return [{ type: 'user', id: userId, name: 'Personal account' }, ...organizations];
  }
  async plans() {
    const products = await this.queries.platformProducts();
    return products.filter((plan) => plan.productType === 'subscription' && plan.entitlementFeature === PUBLISH_EVENT && plan.providerPriceId && ['month', 'year'].includes(plan.billingInterval));
  }
  async billingProfiles(userId) {
    // Subscription managers may select their organization's billing identity;
    // this does not give them permission to edit its legal details elsewhere.
    const [rows] = await this.database.execute(`SELECT p.id, p.legal_name AS legalName, p.owner_user_id AS ownerUserId,
      p.owner_organization_id AS ownerOrganizationId FROM billing_profiles p WHERE p.is_active=TRUE
      AND ((p.owner_organization_id IS NULL AND p.owner_user_id=?) OR EXISTS (SELECT 1 FROM organization_members member
        WHERE member.organization_id=p.owner_organization_id AND member.user_id=? AND member.role IN ('owner','admin','manager')))`, [userId, userId]);
    return rows;
  }
  async subscriptions(owner, database = this.database) {
    const [rows] = await database.execute(`SELECT s.id, s.status, s.current_period_start AS currentPeriodStart, s.current_period_end AS currentPeriodEnd,
      s.trial_end AS trialEnd, s.cancel_at_period_end AS cancelAtPeriodEnd, s.provider_subscription_id AS providerSubscriptionId,
      p.code AS planCode, p.name AS planName FROM platform_subscriptions s JOIN platform_products p ON p.id=s.product_id
      WHERE ${owner.type === 'organization' ? 's.subscriber_organization_id=? AND s.subscriber_user_id IS NULL' : 's.subscriber_user_id=? AND s.subscriber_organization_id IS NULL'} ORDER BY s.created_at DESC`, [owner.id]);
    return rows.map((row) => ({ ...row, cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd) }));
  }
  async summary(owner, userId) {
    await this.access.authorizeOwner(owner, userId);
    const subscriptions = await this.subscriptions(owner);
    const [invoices] = await this.database.execute(`SELECT i.provider_invoice_id AS id, i.status, i.currency, i.amount_due AS amountDue,
      i.amount_paid AS amountPaid, i.hosted_invoice_url AS hostedInvoiceUrl, i.invoice_pdf_url AS invoicePdfUrl FROM subscription_invoices i
      JOIN platform_subscriptions s ON s.id=i.subscription_id WHERE ${owner.type === 'organization' ? 's.subscriber_organization_id=?' : 's.subscriber_user_id=? AND s.subscriber_organization_id IS NULL'} ORDER BY i.updated_at DESC LIMIT 100`, [owner.id]);
    return { ...await this.access.access(owner), subscriptions, invoices };
  }
  async checkout({ owner, user, priceId, billingProfileId, returnTo }) {
    await this.access.authorizeOwner(owner, user.id);
    if (![priceId, billingProfileId].every((value) => Number.isSafeInteger(value) && value > 0)) throw accessError('INVALID_CHECKOUT', 'Choose a subscription plan and billing profile.', 422);
    if (!(await this.access.configuration()).subscriptionsEnabled) throw accessError('SUBSCRIPTIONS_DISABLED', 'Publishing is currently available without a subscription.', 409);
    if (!this.stripe.configured()) throw accessError('PAYMENT_PROVIDER_UNAVAILABLE', 'Subscription payments are not configured yet.', 503);
    return this.withOwnerLock(owner, async (connection) => {
      // Role escalation does not make another customer's billing profile purchasable.
      const [profiles] = await connection.execute(`SELECT id, legal_name AS name, billing_email AS email FROM billing_profiles WHERE id=? AND is_active=TRUE
        AND ${owner.type === 'organization' ? 'owner_organization_id=?' : 'owner_user_id=? AND owner_organization_id IS NULL'}`, [billingProfileId, owner.id]);
      if (!profiles[0]) throw accessError('BUYER_PROFILE_UNAVAILABLE', 'Select a billing profile belonging to this organizer.', 422);
      const plan = (await this.plans()).find((entry) => Number(entry.priceId) === priceId);
      if (!plan) throw accessError('PLAN_UNAVAILABLE', 'This subscription plan is unavailable.', 422);
      const existing = await this.subscriptions(owner, connection);
      if (existing.some((entry) => ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete'].includes(entry.status))) throw accessError('SUBSCRIPTION_EXISTS', 'Manage your existing subscription instead of purchasing another.', 409);
      const client = this.stripe.stripeClient;
      const price = await client.prices.retrieve(plan.providerPriceId);
      if (!price.active || price.type !== 'recurring' || price.recurring?.interval !== plan.billingInterval || price.recurring?.interval_count !== 1 || price.currency.toUpperCase() !== plan.currency.toUpperCase() || price.unit_amount !== Math.round(Number(plan.amount) * 100)) throw accessError('PLAN_CONFIGURATION_MISMATCH', 'The subscription price needs administrator attention.', 503);
      const key = ownerKey(owner);
      await connection.execute('INSERT IGNORE INTO subscription_customers (owner_key, owner_type, owner_id) VALUES (?, ?, ?)', [key, owner.type, owner.id]);
      const [customers] = await connection.execute('SELECT provider_customer_id AS id FROM subscription_customers WHERE owner_key=?', [key]);
      let customerId = customers[0].id;
      if (!customerId) {
        const [pending] = await connection.execute('SELECT created_at FROM subscription_customers WHERE owner_key=?', [key]);
        if (Date.now() - new Date(pending[0].created_at).getTime() > 23 * 3600000) throw accessError('CUSTOMER_RECONCILIATION_REQUIRED', 'A previous billing setup needs administrator reconciliation.', 409);
        const customer = await client.customers.create({ name: profiles[0].name, email: profiles[0].email, metadata: { organizerOwner: key } }, { idempotencyKey: `organizer-customer-${key}` });
        customerId = customer.id;
        await connection.execute('UPDATE subscription_customers SET provider_customer_id=? WHERE owner_key=?', [customerId, key]);
      }
      // Reuse the saved attempt, including after an ambiguous provider timeout.
      const [attempts] = await connection.execute('SELECT * FROM subscription_checkouts WHERE owner_key=? ORDER BY created_at DESC, id DESC LIMIT 1', [key]);
      let attempt = attempts[0];
      if (attempt?.session_id) {
        const session = await client.checkout.sessions.retrieve(attempt.session_id);
        if (session.status === 'open') return { checkoutUrl: session.url, reused: true };
        if (session.status === 'complete') {
          const subscription = session.subscription ? await client.subscriptions.retrieve(providerId(session.subscription)) : null;
          if (!subscription || !['canceled', 'incomplete_expired'].includes(subscription.status)) throw accessError('SUBSCRIPTION_PROCESSING', 'Your payment is being processed. Refresh your subscription shortly.', 409);
        }
        attempt = null;
      }
      if (attempt && Date.now() - new Date(attempt.created_at).getTime() > 23 * 3600000) throw accessError('CHECKOUT_RECONCILIATION_REQUIRED', 'A previous checkout needs administrator reconciliation before retrying.', 409);
      if (!attempt) {
        attempt = { id: crypto.randomUUID(), price_id: priceId, billing_profile_id: billingProfileId, provider_price_id: plan.providerPriceId, return_path: safeReturnPath(returnTo) };
        await connection.execute(`INSERT INTO subscription_checkouts (id, owner_key, actor_user_id, billing_profile_id, product_id, price_id, provider_price_id, return_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [attempt.id, key, user.id, billingProfileId, plan.id, priceId, plan.providerPriceId, attempt.return_path]);
      }
      const query = `ownerType=${owner.type}&ownerId=${owner.id}&returnTo=${encodeURIComponent(attempt.return_path)}`;
      const metadata = { organizerCheckoutId: attempt.id, organizerOwner: key };
      const session = await client.checkout.sessions.create({ mode: 'subscription', customer: customerId,
        line_items: [{ price: attempt.provider_price_id, quantity: 1 }], client_reference_id: attempt.id, metadata,
        subscription_data: { metadata }, success_url: `${this.siteUrl}/subscribe?${query}&checkout=success`, cancel_url: `${this.siteUrl}/subscribe?${query}&checkout=cancelled` }, { idempotencyKey: `organizer-checkout-${attempt.id}` });
      await connection.execute('UPDATE subscription_checkouts SET session_id=? WHERE id=?', [session.id, attempt.id]);
      await this.audit(connection, user.id, 'subscription_checkout_started', attempt.id, { owner });
      return { checkoutUrl: session.url };
    });
  }
  async portal(owner, userId) {
    await this.access.authorizeOwner(owner, userId);
    if (!this.stripe.configured()) throw accessError('PAYMENT_PROVIDER_UNAVAILABLE', 'Subscription payments are not configured.', 503);
    const [rows] = await this.database.execute('SELECT provider_customer_id AS id FROM subscription_customers WHERE owner_key=?', [ownerKey(owner)]);
    if (!rows[0]?.id) throw accessError('CUSTOMER_NOT_FOUND', 'No subscription billing account exists for this organizer.', 404);
    const session = await this.stripe.stripeClient.billingPortal.sessions.create({ customer: rows[0].id, return_url: `${this.siteUrl}/profile/subscriptions?ownerType=${owner.type}&ownerId=${owner.id}` });
    return { url: session.url };
  }
  async cancel(owner, userId, subscriptionId) {
    await this.access.authorizeOwner(owner, userId);
    return this.withOwnerLock(owner, async (connection) => {
      const subscription = (await this.subscriptions(owner, connection)).find((entry) => entry.id === subscriptionId);
      if (!subscription?.providerSubscriptionId) throw accessError('SUBSCRIPTION_NOT_FOUND', 'Subscription not found.', 404);
      await this.stripe.cancelSubscriptionAtPeriodEnd(subscription.providerSubscriptionId);
      await connection.execute('UPDATE platform_subscriptions SET cancel_at_period_end=TRUE WHERE id=?', [subscription.id]);
      await this.audit(connection, userId, 'subscription_cancellation_requested', subscription.id, { owner });
      return { cancelAtPeriodEnd: true };
    });
  }
  async webhook(event) {
    if (event.account) return false; // Connect payments never grant platform capabilities.
    const object = event.data?.object || {};
    if (!['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'].includes(event.type)) return false;
    const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id : providerId(object.subscription || object.parent?.subscription_details?.subscription);
    if (!subscriptionId) return false;
    const client = this.stripe.stripeClient;
    // Find local identity; metadata is only a locator, not authority.
    const preliminary = await client.subscriptions.retrieve(subscriptionId);
    const attemptId = preliminary.metadata?.organizerCheckoutId;
    if (!attemptId) return false;
    const [attempts] = await this.database.execute(`SELECT c.*, customer.owner_type, customer.owner_id, customer.provider_customer_id FROM subscription_checkouts c JOIN subscription_customers customer ON customer.owner_key=c.owner_key WHERE c.id=?`, [attemptId]);
    const attempt = attempts[0];
    if (!attempt) throw accessError('CHECKOUT_NOT_FOUND', 'Unknown subscription checkout.', 409);
    const owner = { type: attempt.owner_type, id: Number(attempt.owner_id) };
    await this.withOwnerLock(owner, async (connection) => {
      // Retrieve AFTER serializing this owner's updates. Old webhook payloads cannot overwrite new state.
      const subscription = await client.subscriptions.retrieve(subscriptionId);
      if (providerId(subscription.customer) !== attempt.provider_customer_id || subscription.metadata?.organizerOwner !== attempt.owner_key || subscription.metadata?.organizerCheckoutId !== attempt.id || (attempt.subscription_id && attempt.subscription_id !== subscriptionId)) throw accessError('SUBSCRIPTION_IDENTITY_MISMATCH', 'Subscription identity mismatch.', 409);
      // Checkout can finish while the application is persisting the session ID.
      // Recover that ID from the signed completion event; retries reconcile it.
      const [currentAttempts] = await connection.execute('SELECT session_id, subscription_id FROM subscription_checkouts WHERE id=?', [attempt.id]);
      const sessionId = currentAttempts[0]?.session_id || (event.type === 'checkout.session.completed' ? object.id : null);
      if (!sessionId) throw accessError('CHECKOUT_PROCESSING', 'Checkout session has not been persisted yet.', 409);
      const session = await client.checkout.sessions.retrieve(sessionId);
      if (session.mode !== 'subscription' || session.status !== 'complete' || providerId(session.customer) !== attempt.provider_customer_id || providerId(session.subscription) !== subscriptionId || session.client_reference_id !== attempt.id || (currentAttempts[0]?.subscription_id && currentAttempts[0].subscription_id !== subscriptionId)) throw accessError('CHECKOUT_IDENTITY_MISMATCH', 'Checkout does not match the subscription.', 409);
      const [prices] = await connection.execute(`SELECT price.provider_price_id, price.product_id FROM platform_prices price JOIN platform_products product ON product.id=price.product_id WHERE product.product_type='subscription' AND product.entitlement_feature=?`, [PUBLISH_EVENT]);
      const matchingPlan = subscription.items?.data?.length === 1 && prices.find((price) => price.provider_price_id === providerId(subscription.items.data[0].price));
      if (!matchingPlan) throw accessError('SUBSCRIPTION_PLAN_MISMATCH', 'Subscription plan mismatch.', 409);
      if (!attempt.subscription_id && providerId(subscription.items.data[0].price) !== attempt.provider_price_id) throw accessError('SUBSCRIPTION_PLAN_MISMATCH', 'Initial subscription price mismatch.', 409);
      const invoice = event.type.startsWith('invoice.') ? await client.invoices.retrieve(object.id) : null;
      if (invoice && (providerId(invoice.customer) !== attempt.provider_customer_id || providerId(invoice.subscription || invoice.parent?.subscription_details?.subscription) !== subscriptionId)) throw accessError('INVOICE_MISMATCH', 'Subscription invoice mismatch.', 409);
      try {
        await connection.beginTransaction();
        try { await connection.execute('INSERT INTO payment_provider_events (provider, provider_event_id, event_type, payload_json) VALUES (?, ?, ?, ?)', ['stripe', event.id, event.type, JSON.stringify(event)]); }
        catch (error) { if (error.code === 'ER_DUP_ENTRY') { await connection.rollback(); return; } throw error; }
        const period = subscriptionPeriod(subscription);
        const [saved] = await connection.execute(`INSERT INTO platform_subscriptions (subscriber_user_id, subscriber_organization_id, buyer_billing_profile_id, product_id, buyer_capacity, status,
          current_period_start, current_period_end, trial_end, cancel_at_period_end, provider, provider_customer_id, provider_subscription_id)
          VALUES (?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, 'stripe', ?, ?)
          ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id), product_id=VALUES(product_id), status=VALUES(status), current_period_start=VALUES(current_period_start),
          current_period_end=VALUES(current_period_end), trial_end=VALUES(trial_end), cancel_at_period_end=VALUES(cancel_at_period_end)`,
        [owner.type === 'user' ? owner.id : null, owner.type === 'organization' ? owner.id : null, attempt.billing_profile_id, matchingPlan.product_id, owner.type === 'organization' ? 'business' : 'consumer', subscription.status, period.start, Number.isFinite(period.end) ? period.end : null, subscription.trial_end || null, Boolean(subscription.cancel_at_period_end), attempt.provider_customer_id, subscriptionId]);
        const id = saved.insertId;
        await connection.execute('UPDATE subscription_checkouts SET subscription_id=?, session_id=? WHERE id=?', [subscriptionId, sessionId, attempt.id]);
        // Rebuild only this subscription's grant, never manual/promotion/partner access.
        await connection.execute("UPDATE platform_entitlements SET revoked_at=UTC_TIMESTAMP() WHERE source_type='subscription' AND source_id=? AND revoked_at IS NULL", [id]);
        if (subscriptionHasAccess(subscription)) await connection.execute(`INSERT INTO platform_entitlements (user_id, organization_id, feature, source_type, source_id, ends_at) VALUES (?, ?, ?, 'subscription', ?, FROM_UNIXTIME(?))`, [owner.type === 'user' ? owner.id : null, owner.type === 'organization' ? owner.id : null, PUBLISH_EVENT, id, period.end]);
        if (invoice) await connection.execute(`INSERT INTO subscription_invoices (provider_invoice_id, subscription_id, status, currency, amount_due, amount_paid, hosted_invoice_url, invoice_pdf_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE status=VALUES(status), amount_due=VALUES(amount_due), amount_paid=VALUES(amount_paid), hosted_invoice_url=VALUES(hosted_invoice_url), invoice_pdf_url=VALUES(invoice_pdf_url)`, [invoice.id, id, invoice.status || 'draft', invoice.currency.toUpperCase(), invoice.amount_due, invoice.amount_paid, invoice.hosted_invoice_url || null, invoice.invoice_pdf || null]);
        await this.audit(connection, null, subscriptionHasAccess(subscription) ? 'subscription_activated_or_updated' : 'subscription_access_ended', id, { owner, status: subscription.status, eventId: event.id });
        await connection.execute("UPDATE payment_provider_events SET processed_at=UTC_TIMESTAMP() WHERE provider='stripe' AND provider_event_id=?", [event.id]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
    });
    return true;
  }
  async customers() {
    const [subscriptions] = await this.database.execute(`SELECT s.id, s.subscriber_user_id AS userId, s.subscriber_organization_id AS organizationId,
      COALESCE(o.name,u.name) AS customerName, u.email, p.name AS planName, p.code AS planCode, s.status,
      s.current_period_start AS currentPeriodStart, s.current_period_end AS currentPeriodEnd, s.cancel_at_period_end AS cancelAtPeriodEnd,
      s.provider_customer_id AS providerCustomerId, s.provider_subscription_id AS providerSubscriptionId
      FROM platform_subscriptions s JOIN platform_products p ON p.id=s.product_id LEFT JOIN users u ON u.id=s.subscriber_user_id
      LEFT JOIN organizations o ON o.id=s.subscriber_organization_id ORDER BY s.updated_at DESC LIMIT 500`);
    const [entitlements] = await this.database.execute(`SELECT e.id, e.user_id AS userId, e.organization_id AS organizationId, COALESCE(o.name,u.name) AS customerName,
      e.feature, e.source_type AS source, e.source_id AS sourceId, e.starts_at AS startsAt, e.ends_at AS endsAt, e.revoked_at AS revokedAt
      FROM platform_entitlements e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN organizations o ON o.id=e.organization_id WHERE e.feature=? ORDER BY e.id DESC LIMIT 1000`, [PUBLISH_EVENT]);
    return { subscriptions, entitlements };
  }
  async grant({ owner, source = 'admin', endsAt, reason }, actorId) {
    if (!['admin', 'early_access', 'promotion', 'partner', 'grandfathered', 'trial'].includes(source) || typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || !endsAt || !Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.now()) throw accessError('INVALID_GRANT', 'A reason, allowed access source, and future expiry are required.', 422);
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(`INSERT INTO platform_entitlements (user_id, organization_id, feature, source_type, ends_at) VALUES (?, ?, ?, ?, ?)`, [owner.type === 'user' ? owner.id : null, owner.type === 'organization' ? owner.id : null, PUBLISH_EVENT, source, new Date(endsAt)]);
      await this.audit(connection, actorId, 'entitlement_granted', result.insertId, { owner, source, endsAt, reason });
      await connection.commit(); return { id: result.insertId };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async revoke(id, actorId, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw accessError('INVALID_REASON', 'A reason is required.', 422);
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute("UPDATE platform_entitlements SET revoked_at=UTC_TIMESTAMP() WHERE id=? AND feature=? AND source_type NOT IN ('subscription','platform_subscription') AND revoked_at IS NULL", [id, PUBLISH_EVENT]);
      if (!result.affectedRows) throw accessError('GRANT_NOT_FOUND', 'Manual grant not found. Manage paid subscriptions through billing.', 404);
      await this.audit(connection, actorId, 'entitlement_revoked', id, { reason });
      await connection.commit(); return { revoked: true };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
}

export function registerSubscriptionRoutes(app, { service, authenticate, requireVerifiedUser, initialize }) {
  const handler = (action) => async (req, res) => {
    try { await initialize(); return res.json(await action(req)); }
    catch (error) { if (!error.status) console.error('Subscription operation failed:', error.message); return res.status(error.status || 502).json({ code: error.code || 'SUBSCRIPTION_UNAVAILABLE', error: error.status ? error.message : 'Subscription service is temporarily unavailable.' }); }
  };
  const staff = (req, res, next) => ['admin', 'manager'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Administrator or manager access required.' });
  const ownerFromQuery = (req) => parseOwner(req.query.ownerType ? { type: req.query.ownerType, id: req.query.ownerId } : null, req.user.id);
  app.get('/api/product-configuration', handler(() => service.access.configuration()));
  app.put('/api/admin/configuration', authenticate, staff, handler((req) => service.access.configure(req.body, req.user.id)));
  app.get('/api/subscriptions/options', authenticate, handler(async (req) => ({ owners: await service.owners(req.user.id), plans: await service.plans(), billingProfiles: await service.billingProfiles(req.user.id), configuration: await service.access.configuration() })));
  app.get('/api/subscriptions/me', authenticate, handler((req) => service.summary(ownerFromQuery(req), req.user.id)));
  app.post('/api/subscriptions/checkout', authenticate, requireVerifiedUser, handler((req) => service.checkout({ owner: parseOwner(req.body.owner, req.user.id), user: req.user, priceId: Number(req.body.priceId), billingProfileId: Number(req.body.billingProfileId), returnTo: req.body.returnTo })));
  app.post('/api/subscriptions/portal', authenticate, handler((req) => service.portal(parseOwner(req.body.owner, req.user.id), req.user.id)));
  app.post('/api/subscriptions/:id/cancel', authenticate, handler((req) => service.cancel(parseOwner(req.body.owner, req.user.id), req.user.id, Number(req.params.id))));
  app.get('/api/admin/subscriptions', authenticate, staff, handler(() => service.customers()));
  app.post('/api/admin/subscriptions/grants', authenticate, staff, handler((req) => service.grant({ ...req.body, owner: parseOwner(req.body.owner, req.user.id) }, req.user.id)));
  app.post('/api/admin/subscriptions/grants/:id/revoke', authenticate, staff, handler((req) => service.revoke(Number(req.params.id), req.user.id, req.body.reason)));
}
