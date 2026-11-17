export class SubscriptionsRepository {
  constructor({ database }) {
    this.database = database;
  }
  async platformSubscriptions(userId, role) {
    const [rows] = await this.database.execute(
      `SELECT id, subscriber_user_id AS subscriberUserId, subscriber_organization_id AS subscriberOrganizationId,
      buyer_billing_profile_id AS buyerBillingProfileId, product_id AS productId, buyer_capacity AS buyerCapacity, status,
      current_period_start AS currentPeriodStart, current_period_end AS currentPeriodEnd, cancel_at_period_end AS cancelAtPeriodEnd,
      provider, provider_subscription_id AS providerSubscriptionId, created_at AS createdAt FROM platform_subscriptions
      WHERE ${['manager', 'admin'].includes(role) ? 'TRUE' : 'subscriber_user_id=?'} ORDER BY created_at DESC`,
      ['manager', 'admin'].includes(role) ? [] : [userId],
    );
    return rows.map((row) => ({ ...row, cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd) }));
  }

  async subscriptionForViewer(subscriptionId, userId, role) {
    const [rows] = await this.database.execute(
      `SELECT id, subscriber_user_id AS subscriberUserId, provider, provider_subscription_id AS providerSubscriptionId, status
      FROM platform_subscriptions WHERE id=? AND (${['manager', 'admin'].includes(role) ? 'TRUE' : 'subscriber_user_id=?'})`,
      ['manager', 'admin'].includes(role) ? [subscriptionId] : [subscriptionId, userId],
    );
    return rows[0] || null;
  }

  async markSubscriptionCancellation(subscriptionId) {
    await this.database.execute(
      `UPDATE platform_subscriptions SET cancel_at_period_end=TRUE WHERE id=? AND status IN ('pending','active','past_due')`,
      [subscriptionId],
    );
  }
}
