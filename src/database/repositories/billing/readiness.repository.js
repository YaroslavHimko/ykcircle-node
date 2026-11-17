export class BillingReadinessRepository {
  constructor({ queries }) {
    this.queries = queries;
  }
  billingProfileCompleteness(profile, context) {
    const missing = [];
    for (const key of [
      'legalName',
      'addressLine1',
      'postalCode',
      'city',
      'country',
      'billingEmail',
    ])
      if (!profile?.[key]) missing.push(key);
    if (
      context === 'venue_seller' &&
      profile?.profileType === 'organization' &&
      !profile.organizationNumber
    )
      missing.push('organizationNumber');
    return { complete: missing.length === 0, missing };
  }

  async eventFinancialReadiness(eventId, userId, role) {
    const settings = await this.queries.eventPaymentSettings(eventId, userId, role);
    if (!settings)
      return {
        requiresSellerProfile: false,
        sellerProfileComplete: false,
        requiresPaymentAccount: false,
        paymentAccountReady: false,
        ticketSalesReady: false,
      };
    const profile = settings.sellerBillingProfileId
      ? await this.queries.billingProfile(settings.sellerBillingProfileId, userId, role)
      : null;
    const completeness = this.queries.billingProfileCompleteness(profile, 'ticket_seller');
    return {
      requiresSellerProfile: Boolean(settings.paymentsEnabled || settings.ticketSalesEnabled),
      sellerProfileComplete: completeness.complete,
      sellerProfileMissing: completeness.missing,
      requiresPaymentAccount: Boolean(settings.paymentsEnabled || settings.ticketSalesEnabled),
      paymentAccountReady: Boolean(
        settings.paymentAccountId &&
        settings.chargesEnabled &&
        settings.onboardingStatus === 'ready',
      ),
      ticketSalesReady: Boolean(
        settings.ticketSalesEnabled &&
        completeness.complete &&
        settings.paymentAccountId &&
        settings.chargesEnabled &&
        settings.onboardingStatus === 'ready' &&
        settings.sellerCapacity,
      ),
    };
  }
}
