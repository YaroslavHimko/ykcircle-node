// A read-only account view. Financial models, snapshots and payment decisions
// stay in their existing domains; administrative visibility is not inherited.
export async function billingIdentityUsage(database, profiles) {
  if (!profiles.length) return new Map();
  const ids = profiles.map((profile) => profile.id);
  const slots = ids.map(() => '?').join(',');
  const [rows] = await database.execute(`
    SELECT seller_billing_profile_id AS profileId, 'ticket_seller' AS purpose, COUNT(*) AS count
      FROM event_payment_settings WHERE seller_billing_profile_id IN (${slots}) GROUP BY seller_billing_profile_id
    UNION ALL SELECT buyer_billing_profile_id, 'platform_subscription', COUNT(*) FROM platform_subscriptions
      WHERE buyer_billing_profile_id IN (${slots}) AND status IN ('active','trialing','past_due','unpaid','paused','incomplete') GROUP BY buyer_billing_profile_id
    UNION ALL SELECT buyer_billing_profile_id, 'platform_purchase', COUNT(*) FROM platform_orders
      WHERE buyer_billing_profile_id IN (${slots}) AND payment_status='paid' GROUP BY buyer_billing_profile_id
    UNION ALL SELECT buyer_billing_profile_id, 'venue_buyer', COUNT(*) FROM venue_bookings
      WHERE buyer_billing_profile_id IN (${slots}) GROUP BY buyer_billing_profile_id
    UNION ALL SELECT p.id, 'event_organizer', COUNT(*) FROM billing_profiles p JOIN events e ON e.organizer_organization_id=p.owner_organization_id
      WHERE p.id IN (${slots}) AND e.deleted_at IS NULL GROUP BY p.id`, [...ids, ...ids, ...ids, ...ids, ...ids]);
  return new Map(ids.map((id) => [Number(id), rows.filter((row) => Number(row.profileId) === Number(id)).map(({ purpose, count }) => ({ purpose, count: Number(count) }))]));
}

export function ticketReadiness(profileComplete, accounts) {
  if (!profileComplete) return 'business_required';
  if (!accounts.length) return 'not_set_up';
  if (accounts.some((account) => account.chargesEnabled && account.onboardingStatus === 'ready')) return 'ready';
  if (accounts.some((account) => account.onboardingStatus === 'restricted' || account.onboardingStatus === 'ready' || account.detailsSubmitted)) return 'action_required';
  return 'incomplete';
}

export function venuePaymentSummary(venue, settings, booking, readiness, sellerName) {
  const daily = venue.priceUnit === 'day';
  const rate = (daily ? booking?.dailyRate : booking?.hourlyRate) ?? venue.priceFrom;
  const hasPrice = rate !== null && rate !== undefined && Number.isFinite(Number(rate)) && Number(rate) >= 0;
  const free = hasPrice && Number(rate) === 0 && venue.priceUnit !== 'contact';
  const missing = [...(readiness?.missing || [])];
  if (!hasPrice || venue.priceUnit === 'contact') missing.unshift('pricing');
  return { id: venue.id, name: venue.name, organizationId: venue.organizationId,
    sellerBillingProfileId: settings.sellerBillingProfileId, sellerName,
    rate: hasPrice ? Number(rate) : null, unit: daily ? 'day' : venue.priceUnit || 'hour', currency: booking?.currency || venue.currency,
    invoiceMode: settings.invoiceMode, paymentTermsDays: settings.paymentTermsDays, methods: settings.methods,
    status: free ? 'free' : readiness?.canIssueInvoice && !missing.length ? 'ready' : 'incomplete', missing: free ? [] : missing };
}

export async function paymentsOverview({ queries, subscriptions, user }) {
  const scope = 'customer';
  const [profiles, organizations, venues, invoices, owners, configuration] = await Promise.all([
    queries.billingProfiles(user.id, scope), queries.managedOrganizations(user.id, scope),
    queries.venuesForViewer(user.id, scope, { managedOnly: true }), queries.invoicesForViewer(user.id, scope),
    subscriptions.owners(user.id), subscriptions.access.configuration(),
  ]);
  const [usage, ticketSellers, venueRows, summaries] = await Promise.all([
    billingIdentityUsage(queries.database, profiles),
    Promise.all(profiles.map(async (profile) => {
      const accounts = await queries.paymentAccounts(profile.id, user.id, scope) || [];
      return { profileId: profile.id, sellerName: profile.legalName,
        status: ticketReadiness(queries.billingProfileCompleteness(profile, 'ticket_seller').complete, accounts),
        accounts: accounts.map(({ id, provider, onboardingStatus, chargesEnabled, payoutsEnabled, detailsSubmitted }) => ({ id, provider, onboardingStatus, chargesEnabled, payoutsEnabled, detailsSubmitted })) };
    })),
    Promise.all(venues.map(async (venue) => {
      const settings = await queries.venueFinancialSettings(venue.id, user.id, scope);
      if (!settings) return null;
      const [booking, readiness] = await Promise.all([queries.venueBookingSettings(venue.id), queries.getVenueFinancialReadiness(venue.id, user.id, scope)]);
      const seller = profiles.find((profile) => Number(profile.id) === Number(settings.sellerBillingProfileId));
      return venuePaymentSummary(venue, settings, booking, readiness, seller?.legalName || venue.organizationName || null);
    })),
    Promise.all(owners.flatMap((owner) => (owner.type === 'user' ? ['organizer.publish_event', 'author.publish_article'] : ['organizer.publish_event']).map(async (feature) => ({ owner, feature, ...await subscriptions.summary(owner, user.id, feature) })))),
  ]);
  const venuePayments = venueRows.filter(Boolean);
  const businesses = profiles.map((profile) => {
    const usedFor = usage.get(Number(profile.id)) || [];
    for (const venue of venuePayments.filter((item) => Number(item.sellerBillingProfileId) === Number(profile.id))) {
      usedFor.push({ purpose: 'venue_seller', venueId: venue.id, name: venue.name });
    }
    if (!usedFor.some((item) => item.purpose === 'ticket_seller') && ticketSellers.find((item) => item.profileId === profile.id)?.accounts.length) usedFor.push({ purpose: 'ticket_seller', count: 0 });
    return { ...profile, usedFor };
  });
  const plans = summaries.flatMap((summary) => summary.subscriptions.map(({ providerSubscriptionId, ...plan }) => ({ ...plan, owner: summary.owner, feature: summary.feature })));
  const seen = new Set();
  const documents = [
    ...invoices.filter((invoice) => ['venue_booking', 'platform_order', 'platform_subscription', 'platform_event_fee', 'platform_service'].includes(invoice.contextType) || invoice.bookingId).map((invoice) => ({ ...invoice,
      id: `invoice-${invoice.id}`, invoiceId: invoice.id, relationship: invoice.bookingId || invoice.contextType === 'venue_booking' ? 'venue' : 'ykcircle',
      sellerName: invoice.sellerOrganizationName, title: invoice.invoiceNumber,
      canPay: Number(invoice.buyerUserId) === Number(user.id) || profiles.some((profile) => Number(profile.id) === Number(invoice.buyerBillingProfileId))
        || organizations.some((organization) => Number(organization.id) === Number(invoice.buyerOrganizationId) && ['owner', 'admin'].includes(organization.membershipRole)),
      href: `/invoices/${invoice.id}` })),
    ...summaries.flatMap((summary) => summary.invoices.filter((invoice) => { if (seen.has(invoice.id)) return false; seen.add(invoice.id); return true; }).map((invoice) => ({
      id: `subscription-${invoice.id}`, relationship: 'ykcircle', title: summary.feature === 'author.publish_article' ? 'YKCircle Article space' : 'YKCircle Organizer',
      sellerName: 'YKCircle', buyerName: summary.owner.name, status: invoice.status, currency: invoice.currency,
      // Stripe stores minor units; use the currency exponent, including zero-decimal currencies.
      totalAmount: Number(invoice.amountDue) / (10 ** new Intl.NumberFormat('en', { style: 'currency', currency: invoice.currency }).resolvedOptions().maximumFractionDigits),
      href: invoice.hostedInvoiceUrl || invoice.invoicePdfUrl, external: true, canPay: true,
    }))),
  ];
  return { businesses, organizations, ticketSellers, venuePayments, plan: { earlyAccess: !configuration.subscriptionsEnabled, subscriptions: plans },
    documents, unpaidInvoices: documents.filter((document) => document.canPay && ['issued', 'sent', 'overdue', 'open'].includes(document.status)).length };
}
