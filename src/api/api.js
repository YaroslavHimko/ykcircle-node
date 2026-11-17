import { OrganizerSubscriptions } from '../services/subscriptions/organizer-subscriptions.js';
import { ArticlePublishing } from '../services/articles/article-publishing.js';
import { StripeConnectService } from '../services/payments/stripe-connect.js';
import { TicketSales } from '../services/tickets/ticket-sales.js';
import { createHttpContext } from './context.js';
import { registerPaymentWebhooks } from './routes/billing/webhooks.routes.js';
import { registerPublicRoutes } from './routes/public/public.routes.js';
import { registerLegalAcceptanceRoutes } from './routes/legal/acceptance.routes.js';
import { registerMediaEventsAndVenuesRoutes } from './routes/media/events-and-venues.routes.js';
import { registerMapsActivityRoutes } from './routes/maps/activity.routes.js';
import { registerModerationReportsRoutes } from './routes/moderation/reports.routes.js';
import { registerMediaGroupsAndArticlesRoutes } from './routes/media/groups-and-articles.routes.js';
import { registerSubscriptionsRoutes } from './routes/subscriptions/subscriptions.routes.js';
import { registerSubscriptionsProductAccessRoutes } from './routes/subscriptions/product-access.routes.js';
import { registerMapsConfigRoutes } from './routes/maps/config.routes.js';
import { registerEventsDraftsRoutes } from './routes/events/drafts.routes.js';
import { registerVenuesTaxonomyRoutes } from './routes/venues/taxonomy.routes.js';
import { registerOrganizationsRoutes } from './routes/organizations/organizations.routes.js';
import { registerBillingProfilesRoutes } from './routes/billing/profiles.routes.js';
import { registerTicketsCheckoutRoutes } from './routes/tickets/checkout.routes.js';
import { registerTicketsCheckInRoutes } from './routes/tickets/check-in.routes.js';
import { registerTicketsOrdersRoutes } from './routes/tickets/orders.routes.js';
import { registerBillingInvoicesRoutes } from './routes/billing/invoices.routes.js';
import { registerSubscriptionsPlatformRoutes } from './routes/subscriptions/platform.routes.js';
import { registerVenuesRoutes } from './routes/venues/venues.routes.js';
import { registerVenuesBookingsRoutes } from './routes/venues/bookings.routes.js';
import { registerEventsRegistrationAccessRoutes } from './routes/events/registration-access.routes.js';
import { registerAccountsRoutes } from './routes/accounts/accounts.routes.js';
import { registerModerationAdministrationRoutes } from './routes/moderation/administration.routes.js';
import { registerArticlesRoutes } from './routes/articles/articles.routes.js';
import { registerGroupsRoutes } from './routes/groups/groups.routes.js';
import { registerEventsRoutes } from './routes/events/events.routes.js';
import { registerEventsFollowupsRoutes } from './routes/events/followups.routes.js';
import { registerEventsRegistrationsRoutes } from './routes/events/registrations.routes.js';
import { registerPrivacyContactRoutes } from './routes/privacy/contact.routes.js';
export class Api {
  constructor({
    config,
    database,
    queries,
    emailService,
    ftpService,
    eventFtpService,
    venueFtpService,
    groupFtpService,
    articleFtpService,
  }) {
    this.config = config;
    this.database = database;
    this.queries = queries;
    this.emailService = emailService;
    this.ftpService = ftpService;
    this.eventFtpService = eventFtpService;
    this.venueFtpService = venueFtpService;
    this.groupFtpService = groupFtpService;
    this.articleFtpService = articleFtpService;
    this.authSecret = config.runtime.authSecret;
    this.stripe = new StripeConnectService(config.runtime.stripe);
    this.subscriptions = new OrganizerSubscriptions({
      queries,
      stripe: this.stripe,
      siteUrl: config.site.siteUrl,
    });
    this.articlePublishing = new ArticlePublishing(queries);
    this.ticketSales = new TicketSales({
      queries,
      stripe: this.stripe,
      emailService,
      siteUrl: config.site.siteUrl,
    });
  }
  async refreshStripeAccount(accountId) {
    const account = await this.stripe.account(accountId);
    await this.queries.updatePaymentAccountCapabilities('stripe', accountId, {
      onboardingStatus:
        account.onboarding_status ||
        (account.charges_enabled ? 'ready' : account.details_submitted ? 'restricted' : 'pending'),
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
    return account;
  }
  registerPaymentWebhooks(app) {
    registerPaymentWebhooks(app, {
      ...this,
      refreshStripeAccount: this.refreshStripeAccount.bind(this),
    });
  }
  register(app) {
    const context = createHttpContext(app, {
      ...this,
      refreshStripeAccount: this.refreshStripeAccount.bind(this),
    });
    registerPublicRoutes(app, context);
    registerLegalAcceptanceRoutes(app, context);
    registerMediaEventsAndVenuesRoutes(app, context);
    registerMapsActivityRoutes(app, context);
    registerModerationReportsRoutes(app, context);
    registerMediaGroupsAndArticlesRoutes(app, context);
    registerSubscriptionsRoutes(app, context);
    registerSubscriptionsProductAccessRoutes(app, context);
    registerMapsConfigRoutes(app, context);
    registerEventsDraftsRoutes(app, context);
    registerVenuesTaxonomyRoutes(app, context);
    registerOrganizationsRoutes(app, context);
    registerBillingProfilesRoutes(app, context);
    registerTicketsCheckoutRoutes(app, context);
    registerTicketsCheckInRoutes(app, context);
    registerTicketsOrdersRoutes(app, context);
    registerBillingInvoicesRoutes(app, context);
    registerSubscriptionsPlatformRoutes(app, context);
    registerVenuesRoutes(app, context);
    registerVenuesBookingsRoutes(app, context);
    registerEventsRegistrationAccessRoutes(app, context);
    registerAccountsRoutes(app, context);
    registerModerationAdministrationRoutes(app, context);
    registerArticlesRoutes(app, context);
    registerGroupsRoutes(app, context);
    registerEventsRoutes(app, context);
    registerEventsFollowupsRoutes(app, context);
    registerEventsRegistrationsRoutes(app, context);
    registerPrivacyContactRoutes(app, context);
  }
}
