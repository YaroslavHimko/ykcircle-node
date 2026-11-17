import { jsonValue } from '../../../utils/serialization.js';
export class TicketsSettingsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async eventPaymentSettings(eventId, userId, role) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND e.manager_id=?';
    const [rows] = await this.database.execute(
      `SELECT s.event_id AS eventId, s.seller_billing_profile_id AS sellerBillingProfileId,
      s.payment_account_id AS paymentAccountId, s.seller_capacity AS sellerCapacity, s.currency, s.payments_enabled AS paymentsEnabled, s.ticket_sales_enabled AS ticketSalesEnabled,
      s.refund_policy_snapshot AS refundPolicy, account.charges_enabled AS chargesEnabled, account.onboarding_status AS onboardingStatus FROM event_payment_settings s JOIN events e ON e.id=s.event_id
      LEFT JOIN payment_accounts account ON account.id=s.payment_account_id WHERE s.event_id=?${scope}`,
      ['manager', 'admin'].includes(role) ? [eventId] : [eventId, userId],
    );
    return rows[0]
      ? {
          ...rows[0],
          refundPolicy: jsonValue(rows[0].refundPolicy),
          paymentsEnabled: Boolean(rows[0].paymentsEnabled),
          ticketSalesEnabled: Boolean(rows[0].ticketSalesEnabled),
          chargesEnabled: Boolean(rows[0].chargesEnabled),
        }
      : null;
  }

  async saveEventPaymentSettings(eventId, userId, role, settings) {
    const scope = ['manager', 'admin'].includes(role) ? '' : ' AND manager_id=?';
    const [events] = await this.database.execute(
      `SELECT id FROM events WHERE id=?${scope}`,
      ['manager', 'admin'].includes(role) ? [eventId] : [eventId, userId],
    );
    if (!events[0]) return { error: 'EVENT_NOT_FOUND' };
    if (
      settings.sellerBillingProfileId &&
      !(await this.queries.billingProfile(settings.sellerBillingProfileId, userId, role))
    )
      return { error: 'SELLER_PROFILE_UNAVAILABLE' };
    if (settings.paymentAccountId) {
      const [accounts] = await this.database.execute(
        `SELECT billing_profile_id AS billingProfileId, charges_enabled AS chargesEnabled,
        onboarding_status AS onboardingStatus FROM payment_accounts WHERE id=?`,
        [settings.paymentAccountId],
      );
      if (
        !accounts[0] ||
        Number(accounts[0].billingProfileId) !== Number(settings.sellerBillingProfileId)
      )
        return { error: 'PAYMENT_ACCOUNT_MISMATCH' };
      if (
        settings.ticketSalesEnabled &&
        (!accounts[0].chargesEnabled || accounts[0].onboardingStatus !== 'ready')
      )
        return { error: 'PAYMENT_ACCOUNT_NOT_READY' };
    }
    if (
      settings.ticketSalesEnabled &&
      (!settings.sellerBillingProfileId || !settings.paymentAccountId)
    )
      return { error: 'PAYMENT_SETUP_REQUIRED' };
    if (settings.ticketSalesEnabled && !settings.sellerCapacity)
      return { error: 'SELLER_CAPACITY_REQUIRED' };
    await this.database.execute(
      `INSERT INTO event_payment_settings (event_id, seller_billing_profile_id, payment_account_id, seller_capacity, currency, payments_enabled, ticket_sales_enabled, refund_policy_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE seller_billing_profile_id=VALUES(seller_billing_profile_id), payment_account_id=VALUES(payment_account_id), seller_capacity=VALUES(seller_capacity), currency=VALUES(currency), payments_enabled=VALUES(payments_enabled), ticket_sales_enabled=VALUES(ticket_sales_enabled), refund_policy_snapshot=VALUES(refund_policy_snapshot)`,
      [
        eventId,
        settings.sellerBillingProfileId || null,
        settings.paymentAccountId || null,
        settings.sellerCapacity || null,
        settings.currency || null,
        Boolean(settings.paymentsEnabled),
        Boolean(settings.ticketSalesEnabled),
        settings.refundPolicy || null,
      ],
    );
    return this.queries.eventPaymentSettings(eventId, userId, role);
  }

  async canAcceptPaidRegistrations(eventId) {
    const [rows] = await this.database.execute(
      'SELECT participation_fee AS fee, pricing_type AS pricingType FROM events WHERE id=?',
      [eventId],
    );
    const row = rows[0];
    if (!row || (row.pricingType !== 'paid' && Number(row.fee || 0) <= 0)) return true;
    // Paid attendance is created only by verified Checkout fulfillment.
    return false;
  }
}
