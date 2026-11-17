import { TicketsCheckInRepository } from './repositories/tickets/check-in.repository.js';
import { ModerationReportsRepository } from './repositories/moderation/reports.repository.js';
import { LegalRepository } from './repositories/legal/legal.repository.js';
import { EventsCatalogRepository } from './repositories/events/catalog.repository.js';
import { AccountsRepository } from './repositories/accounts/accounts.repository.js';
import { EventsAttendanceRepository } from './repositories/events/attendance.repository.js';
import { GroupsRepository } from './repositories/groups/groups.repository.js';
import { EventsRepository } from './repositories/events/events.repository.js';
import { EventsFollowupsRepository } from './repositories/events/followups.repository.js';
import { EventsRegistrationsRepository } from './repositories/events/registrations.repository.js';
import { EventsInvitationsRepository } from './repositories/events/invitations.repository.js';
import { DiscussionsRepository } from './repositories/discussions/discussions.repository.js';
import { ArticlesRepository } from './repositories/articles/articles.repository.js';
import { VenuesCatalogRepository } from './repositories/venues/catalog.repository.js';
import { OrganizationsRepository } from './repositories/organizations/organizations.repository.js';
import { BillingProfilesRepository } from './repositories/billing/profiles.repository.js';
import { TicketsSettingsRepository } from './repositories/tickets/settings.repository.js';
import { TicketsOrdersRepository } from './repositories/tickets/orders.repository.js';
import { SubscriptionsPlatformRepository } from './repositories/subscriptions/platform.repository.js';
import { BillingReadinessRepository } from './repositories/billing/readiness.repository.js';
import { SubscriptionsRepository } from './repositories/subscriptions/subscriptions.repository.js';
import { BillingInvoicesRepository } from './repositories/billing/invoices.repository.js';
import { VenuesAvailabilityRepository } from './repositories/venues/availability.repository.js';
import { VenuesRepository } from './repositories/venues/venues.repository.js';
import { VenuesBookingsRepository } from './repositories/venues/bookings.repository.js';
import { VenuesBookingFinanceRepository } from './repositories/venues/booking-finance.repository.js';
import { ModerationRepository } from './repositories/moderation/moderation.repository.js';
import { PrivacyRepository } from './repositories/privacy/privacy.repository.js';
import { ProductAccess } from './repositories/subscriptions/product-access.repository.js';
import { configureQueryExecutor } from './query-executor.js';
/** Compatibility facade. Feature implementations live in their repositories. */
export class Queries {
  constructor(database) {
    this.database = database;
    this.productAccess = new ProductAccess(database);
    configureQueryExecutor(database);
    const context = { database, queries: this, productAccess: this.productAccess };
    this.repositories = {
      ticketsCheckIn: new TicketsCheckInRepository(context),
      moderationReports: new ModerationReportsRepository(context),
      legal: new LegalRepository(context),
      eventsCatalog: new EventsCatalogRepository(context),
      accounts: new AccountsRepository(context),
      eventsAttendance: new EventsAttendanceRepository(context),
      groups: new GroupsRepository(context),
      events: new EventsRepository(context),
      eventsFollowups: new EventsFollowupsRepository(context),
      eventsRegistrations: new EventsRegistrationsRepository(context),
      eventsInvitations: new EventsInvitationsRepository(context),
      discussions: new DiscussionsRepository(context),
      articles: new ArticlesRepository(context),
      venuesCatalog: new VenuesCatalogRepository(context),
      organizations: new OrganizationsRepository(context),
      billingProfiles: new BillingProfilesRepository(context),
      ticketsSettings: new TicketsSettingsRepository(context),
      ticketsOrders: new TicketsOrdersRepository(context),
      subscriptionsPlatform: new SubscriptionsPlatformRepository(context),
      billingReadiness: new BillingReadinessRepository(context),
      subscriptions: new SubscriptionsRepository(context),
      billingInvoices: new BillingInvoicesRepository(context),
      venuesAvailability: new VenuesAvailabilityRepository(context),
      venues: new VenuesRepository(context),
      venuesBookings: new VenuesBookingsRepository(context),
      venuesBookingFinance: new VenuesBookingFinanceRepository(context),
      moderation: new ModerationRepository(context),
      privacy: new PrivacyRepository(context),
    };
  }
  initialize() {
    return this.database.initialize();
  }
  // tickets: check-in
  isEventRepresentative(...args) {
    return this.repositories.ticketsCheckIn.isEventRepresentative(...args);
  }
  representativeEvents(...args) {
    return this.repositories.ticketsCheckIn.representativeEvents(...args);
  }
  eventCheckInContext(...args) {
    return this.repositories.ticketsCheckIn.eventCheckInContext(...args);
  }
  manageEventRepresentatives(...args) {
    return this.repositories.ticketsCheckIn.manageEventRepresentatives(...args);
  }
  checkInTicket(...args) {
    return this.repositories.ticketsCheckIn.checkInTicket(...args);
  }

  // moderation: reports
  createContentReport(...args) {
    return this.repositories.moderationReports.createContentReport(...args);
  }
  contentReports(...args) {
    return this.repositories.moderationReports.contentReports(...args);
  }
  reviewContentReport(...args) {
    return this.repositories.moderationReports.reviewContentReport(...args);
  }

  // legal: legal
  ensureLegalDocumentVersion(...args) {
    return this.repositories.legal.ensureLegalDocumentVersion(...args);
  }
  recordLegalAcceptance(...args) {
    return this.repositories.legal.recordLegalAcceptance(...args);
  }
  audit(...args) {
    return this.repositories.legal.audit(...args);
  }

  // events: catalog
  publicEventParticipants(...args) {
    return this.repositories.eventsCatalog.publicEventParticipants(...args);
  }
  eventParticipantStatus(...args) {
    return this.repositories.eventsCatalog.eventParticipantStatus(...args);
  }
  publicEvents(...args) {
    return this.repositories.eventsCatalog.publicEvents(...args);
  }
  eventsForViewer(...args) {
    return this.repositories.eventsCatalog.eventsForViewer(...args);
  }
  privateInvitationExists(...args) {
    return this.repositories.eventsCatalog.privateInvitationExists(...args);
  }
  eventVisibility(...args) {
    return this.repositories.eventsCatalog.eventVisibility(...args);
  }
  eventManagerId(...args) {
    return this.repositories.eventsCatalog.eventManagerId(...args);
  }
  eventFee(...args) {
    return this.repositories.eventsCatalog.eventFee(...args);
  }

  // accounts: accounts
  findUserById(...args) {
    return this.repositories.accounts.findUserById(...args);
  }
  findUserByEmail(...args) {
    return this.repositories.accounts.findUserByEmail(...args);
  }
  emailExists(...args) {
    return this.repositories.accounts.emailExists(...args);
  }
  verifyEmail(...args) {
    return this.repositories.accounts.verifyEmail(...args);
  }
  refreshVerification(...args) {
    return this.repositories.accounts.refreshVerification(...args);
  }
  createPasswordReset(...args) {
    return this.repositories.accounts.createPasswordReset(...args);
  }
  resetPassword(...args) {
    return this.repositories.accounts.resetPassword(...args);
  }
  profile(...args) {
    return this.repositories.accounts.profile(...args);
  }
  setMarketingEmailPreference(...args) {
    return this.repositories.accounts.setMarketingEmailPreference(...args);
  }
  marketingEmailPreference(...args) {
    return this.repositories.accounts.marketingEmailPreference(...args);
  }
  updateProfilePicture(...args) {
    return this.repositories.accounts.updateProfilePicture(...args);
  }
  updateTimezonePreference(...args) {
    return this.repositories.accounts.updateTimezonePreference(...args);
  }
  deleteUser(...args) {
    return this.repositories.accounts.deleteUser(...args);
  }
  createUser(...args) {
    return this.repositories.accounts.createUser(...args);
  }
  users(...args) {
    return this.repositories.accounts.users(...args);
  }
  updateUserRole(...args) {
    return this.repositories.accounts.updateUserRole(...args);
  }

  // events: attendance
  events(...args) {
    return this.repositories.eventsAttendance.events(...args);
  }
  event(...args) {
    return this.repositories.eventsAttendance.event(...args);
  }
  eventParticipants(...args) {
    return this.repositories.eventsAttendance.eventParticipants(...args);
  }
  eventRatingSummary(...args) {
    return this.repositories.eventsAttendance.eventRatingSummary(...args);
  }
  rateEvent(...args) {
    return this.repositories.eventsAttendance.rateEvent(...args);
  }
  updateParticipantStatus(...args) {
    return this.repositories.eventsAttendance.updateParticipantStatus(...args);
  }
  updateParticipantPaymentStatus(...args) {
    return this.repositories.eventsAttendance.updateParticipantPaymentStatus(...args);
  }
  participantFee(...args) {
    return this.repositories.eventsAttendance.participantFee(...args);
  }
  updateRegistrationPaymentStatus(...args) {
    return this.repositories.eventsAttendance.updateRegistrationPaymentStatus(...args);
  }
  registrationFee(...args) {
    return this.repositories.eventsAttendance.registrationFee(...args);
  }
  managerEvents(...args) {
    return this.repositories.eventsAttendance.managerEvents(...args);
  }
  softDeleteEvent(...args) {
    return this.repositories.eventsAttendance.softDeleteEvent(...args);
  }

  // groups: groups
  createGroup(...args) {
    return this.repositories.groups.createGroup(...args);
  }
  groupsForViewer(...args) {
    return this.repositories.groups.groupsForViewer(...args);
  }
  group(...args) {
    return this.repositories.groups.group(...args);
  }
  groupEvents(...args) {
    return this.repositories.groups.groupEvents(...args);
  }
  updateGroup(...args) {
    return this.repositories.groups.updateGroup(...args);
  }
  setGroupCover(...args) {
    return this.repositories.groups.setGroupCover(...args);
  }
  groupForCover(...args) {
    return this.repositories.groups.groupForCover(...args);
  }
  deleteGroup(...args) {
    return this.repositories.groups.deleteGroup(...args);
  }
  joinGroup(...args) {
    return this.repositories.groups.joinGroup(...args);
  }
  leaveGroup(...args) {
    return this.repositories.groups.leaveGroup(...args);
  }
  groupMembers(...args) {
    return this.repositories.groups.groupMembers(...args);
  }
  groupMember(...args) {
    return this.repositories.groups.groupMember(...args);
  }
  addGroupMember(...args) {
    return this.repositories.groups.addGroupMember(...args);
  }
  createGroupInvitation(...args) {
    return this.repositories.groups.createGroupInvitation(...args);
  }
  groupInvitations(...args) {
    return this.repositories.groups.groupInvitations(...args);
  }
  respondToGroupInvitation(...args) {
    return this.repositories.groups.respondToGroupInvitation(...args);
  }
  removeGroupMember(...args) {
    return this.repositories.groups.removeGroupMember(...args);
  }
  canManageGroup(...args) {
    return this.repositories.groups.canManageGroup(...args);
  }
  groupExists(...args) {
    return this.repositories.groups.groupExists(...args);
  }
  pendingGroupEventNotifications(...args) {
    return this.repositories.groups.pendingGroupEventNotifications(...args);
  }
  claimGroupEventNotification(...args) {
    return this.repositories.groups.claimGroupEventNotification(...args);
  }
  releaseGroupEventNotification(...args) {
    return this.repositories.groups.releaseGroupEventNotification(...args);
  }
  groupForEvent(...args) {
    return this.repositories.groups.groupForEvent(...args);
  }

  // events: events
  eventCategories(...args) {
    return this.repositories.events.eventCategories(...args);
  }
  eventTypes(...args) {
    return this.repositories.events.eventTypes(...args);
  }
  taxonomyExists(...args) {
    return this.repositories.events.taxonomyExists(...args);
  }
  eventLocationVenue(...args) {
    return this.repositories.events.eventLocationVenue(...args);
  }
  richEventInsertValues(...args) {
    return this.repositories.events.richEventInsertValues(...args);
  }
  insertRichEvent(...args) {
    return this.repositories.events.insertRichEvent(...args);
  }
  recurringDate(...args) {
    return this.repositories.events.recurringDate(...args);
  }
  createRichEventSeries(...args) {
    return this.repositories.events.createRichEventSeries(...args);
  }
  createRichEvent(...args) {
    return this.repositories.events.createRichEvent(...args);
  }
  updateRichEventAndBooking(...args) {
    return this.repositories.events.updateRichEventAndBooking(...args);
  }
  updateRichEvent(...args) {
    return this.repositories.events.updateRichEvent(...args);
  }
  updateEventSchedule(...args) {
    return this.repositories.events.updateEventSchedule(...args);
  }
  setEventCover(...args) {
    return this.repositories.events.setEventCover(...args);
  }
  eventCoverVisible(...args) {
    return this.repositories.events.eventCoverVisible(...args);
  }
  normalizeRichEventLocation(...args) {
    return this.repositories.events.normalizeRichEventLocation(...args);
  }
  richEvent(...args) {
    return this.repositories.events.richEvent(...args);
  }
  publishRichEvent(...args) {
    return this.repositories.events.publishRichEvent(...args);
  }
  updateEventStatus(...args) {
    return this.repositories.events.updateEventStatus(...args);
  }
  finishEvent(...args) {
    return this.repositories.events.finishEvent(...args);
  }

  // events: followups
  managedFollowupEvent(...args) {
    return this.repositories.eventsFollowups.managedFollowupEvent(...args);
  }
  eventFollowupOverview(...args) {
    return this.repositories.eventsFollowups.eventFollowupOverview(...args);
  }
  saveEventFollowupTemplate(...args) {
    return this.repositories.eventsFollowups.saveEventFollowupTemplate(...args);
  }
  queueEventFollowup(...args) {
    return this.repositories.eventsFollowups.queueEventFollowup(...args);
  }
  claimEventFollowupDelivery(...args) {
    return this.repositories.eventsFollowups.claimEventFollowupDelivery(...args);
  }
  finishEventFollowupDelivery(...args) {
    return this.repositories.eventsFollowups.finishEventFollowupDelivery(...args);
  }

  // events: registrations
  registrations(...args) {
    return this.repositories.eventsRegistrations.registrations(...args);
  }
  userRegistrations(...args) {
    return this.repositories.eventsRegistrations.userRegistrations(...args);
  }
  attendingEvents(...args) {
    return this.repositories.eventsRegistrations.attendingEvents(...args);
  }
  registration(...args) {
    return this.repositories.eventsRegistrations.registration(...args);
  }
  existingEventRegistration(...args) {
    return this.repositories.eventsRegistrations.existingEventRegistration(...args);
  }
  registerForEvent(...args) {
    return this.repositories.eventsRegistrations.registerForEvent(...args);
  }
  updateRegistrationStatus(...args) {
    return this.repositories.eventsRegistrations.updateRegistrationStatus(...args);
  }
  withdrawRegistration(...args) {
    return this.repositories.eventsRegistrations.withdrawRegistration(...args);
  }
  findActiveRegistrationForUser(...args) {
    return this.repositories.eventsRegistrations.findActiveRegistrationForUser(...args);
  }
  markRegistrationWithdrawn(...args) {
    return this.repositories.eventsRegistrations.markRegistrationWithdrawn(...args);
  }
  customerRegistration(...args) {
    return this.repositories.eventsRegistrations.customerRegistration(...args);
  }

  // events: invitations
  createInvitation(...args) {
    return this.repositories.eventsInvitations.createInvitation(...args);
  }
  resendInvitation(...args) {
    return this.repositories.eventsInvitations.resendInvitation(...args);
  }
  invitations(...args) {
    return this.repositories.eventsInvitations.invitations(...args);
  }
  updateInvitationStatus(...args) {
    return this.repositories.eventsInvitations.updateInvitationStatus(...args);
  }
  respondToInvitation(...args) {
    return this.repositories.eventsInvitations.respondToInvitation(...args);
  }
  acceptInvitationAsParticipant(...args) {
    return this.repositories.eventsInvitations.acceptInvitationAsParticipant(...args);
  }

  // discussions: discussions
  forumTables(...args) {
    return this.repositories.discussions.forumTables(...args);
  }
  forumThreads(...args) {
    return this.repositories.discussions.forumThreads(...args);
  }
  forumThread(...args) {
    return this.repositories.discussions.forumThread(...args);
  }
  createForumThread(...args) {
    return this.repositories.discussions.createForumThread(...args);
  }
  forumMessages(...args) {
    return this.repositories.discussions.forumMessages(...args);
  }
  addForumMessage(...args) {
    return this.repositories.discussions.addForumMessage(...args);
  }
  markForumThreadRead(...args) {
    return this.repositories.discussions.markForumThreadRead(...args);
  }
  setForumThreadStatus(...args) {
    return this.repositories.discussions.setForumThreadStatus(...args);
  }
  groupForumAccess(...args) {
    return this.repositories.discussions.groupForumAccess(...args);
  }
  eventForumAccess(...args) {
    return this.repositories.discussions.eventForumAccess(...args);
  }
  canManageEventForum(...args) {
    return this.repositories.discussions.canManageEventForum(...args);
  }

  // articles: articles
  articleCategories(...args) {
    return this.repositories.articles.articleCategories(...args);
  }
  articleColumns(...args) {
    return this.repositories.articles.articleColumns(...args);
  }
  articles(...args) {
    return this.repositories.articles.articles(...args);
  }
  articleBySlug(...args) {
    return this.repositories.articles.articleBySlug(...args);
  }
  articleForEditor(...args) {
    return this.repositories.articles.articleForEditor(...args);
  }
  createArticle(...args) {
    return this.repositories.articles.createArticle(...args);
  }
  updateArticle(...args) {
    return this.repositories.articles.updateArticle(...args);
  }
  setArticleStatus(...args) {
    return this.repositories.articles.setArticleStatus(...args);
  }
  setArticleCover(...args) {
    return this.repositories.articles.setArticleCover(...args);
  }
  addArticleMedia(...args) {
    return this.repositories.articles.addArticleMedia(...args);
  }
  articleMedia(...args) {
    return this.repositories.articles.articleMedia(...args);
  }
  articleMediaItem(...args) {
    return this.repositories.articles.articleMediaItem(...args);
  }
  articleImageVisible(...args) {
    return this.repositories.articles.articleImageVisible(...args);
  }
  deleteArticleMedia(...args) {
    return this.repositories.articles.deleteArticleMedia(...args);
  }
  syncArticleTags(...args) {
    return this.repositories.articles.syncArticleTags(...args);
  }

  // venues: catalog
  venueColumns(...args) {
    return this.repositories.venuesCatalog.venueColumns(...args);
  }
  normalizeVenue(...args) {
    return this.repositories.venuesCatalog.normalizeVenue(...args);
  }
  venueRelations(...args) {
    return this.repositories.venuesCatalog.venueRelations(...args);
  }
  decorateVenue(...args) {
    return this.repositories.venuesCatalog.decorateVenue(...args);
  }
  venueTypes(...args) {
    return this.repositories.venuesCatalog.venueTypes(...args);
  }
  venueEventTypes(...args) {
    return this.repositories.venuesCatalog.venueEventTypes(...args);
  }
  venueAmenities(...args) {
    return this.repositories.venuesCatalog.venueAmenities(...args);
  }

  // organizations: organizations
  organization(...args) {
    return this.repositories.organizations.organization(...args);
  }
  createOrganization(...args) {
    return this.repositories.organizations.createOrganization(...args);
  }
  organizationMember(...args) {
    return this.repositories.organizations.organizationMember(...args);
  }
  updateOrganization(...args) {
    return this.repositories.organizations.updateOrganization(...args);
  }
  setOrganizationMember(...args) {
    return this.repositories.organizations.setOrganizationMember(...args);
  }
  canManageOrganization(...args) {
    return this.repositories.organizations.canManageOrganization(...args);
  }
  managedOrganizations(...args) {
    return this.repositories.organizations.managedOrganizations(...args);
  }

  // billing: profiles
  billingProfileColumns(...args) {
    return this.repositories.billingProfiles.billingProfileColumns(...args);
  }
  billingProfiles(...args) {
    return this.repositories.billingProfiles.billingProfiles(...args);
  }
  billingProfile(...args) {
    return this.repositories.billingProfiles.billingProfile(...args);
  }
  saveBillingProfile(...args) {
    return this.repositories.billingProfiles.saveBillingProfile(...args);
  }
  archiveBillingProfile(...args) {
    return this.repositories.billingProfiles.archiveBillingProfile(...args);
  }
  paymentAccounts(...args) {
    return this.repositories.billingProfiles.paymentAccounts(...args);
  }
  createPaymentAccount(...args) {
    return this.repositories.billingProfiles.createPaymentAccount(...args);
  }
  updatePaymentAccountCapabilities(...args) {
    return this.repositories.billingProfiles.updatePaymentAccountCapabilities(...args);
  }
  paymentAccount(...args) {
    return this.repositories.billingProfiles.paymentAccount(...args);
  }

  // tickets: settings
  eventPaymentSettings(...args) {
    return this.repositories.ticketsSettings.eventPaymentSettings(...args);
  }
  saveEventPaymentSettings(...args) {
    return this.repositories.ticketsSettings.saveEventPaymentSettings(...args);
  }
  canAcceptPaidRegistrations(...args) {
    return this.repositories.ticketsSettings.canAcceptPaidRegistrations(...args);
  }

  // tickets: orders
  managedTicketTypes(...args) {
    return this.repositories.ticketsOrders.managedTicketTypes(...args);
  }
  ticketTypes(...args) {
    return this.repositories.ticketsOrders.ticketTypes(...args);
  }
  saveTicketType(...args) {
    return this.repositories.ticketsOrders.saveTicketType(...args);
  }
  ticketCheckoutContext(...args) {
    return this.repositories.ticketsOrders.ticketCheckoutContext(...args);
  }
  createTicketOrder(...args) {
    return this.repositories.ticketsOrders.createTicketOrder(...args);
  }
  attachTicketProviderPayment(...args) {
    return this.repositories.ticketsOrders.attachTicketProviderPayment(...args);
  }
  ticketOrder(...args) {
    return this.repositories.ticketsOrders.ticketOrder(...args);
  }
  ticketOrdersForAttendee(...args) {
    return this.repositories.ticketsOrders.ticketOrdersForAttendee(...args);
  }
  processTicketProviderEvent(...args) {
    return this.repositories.ticketsOrders.processTicketProviderEvent(...args);
  }
  processPlatformProviderEventInTransaction(...args) {
    return this.repositories.ticketsOrders.processPlatformProviderEventInTransaction(...args);
  }
  ticketRefundContext(...args) {
    return this.repositories.ticketsOrders.ticketRefundContext(...args);
  }

  // subscriptions: platform
  platformProducts(...args) {
    return this.repositories.subscriptionsPlatform.platformProducts(...args);
  }
  savePlatformProduct(...args) {
    return this.repositories.subscriptionsPlatform.savePlatformProduct(...args);
  }
  savePlatformPrice(...args) {
    return this.repositories.subscriptionsPlatform.savePlatformPrice(...args);
  }
  createPlatformOrder(...args) {
    return this.repositories.subscriptionsPlatform.createPlatformOrder(...args);
  }
  platformOrderForBuyer(...args) {
    return this.repositories.subscriptionsPlatform.platformOrderForBuyer(...args);
  }
  attachPlatformProviderPayment(...args) {
    return this.repositories.subscriptionsPlatform.attachPlatformProviderPayment(...args);
  }
  issuePlatformOrderInvoice(...args) {
    return this.repositories.subscriptionsPlatform.issuePlatformOrderInvoice(...args);
  }
  setPlatformBillingProfile(...args) {
    return this.repositories.subscriptionsPlatform.setPlatformBillingProfile(...args);
  }
  platformBillingProfileReady(...args) {
    return this.repositories.subscriptionsPlatform.platformBillingProfileReady(...args);
  }
  hasPlatformEntitlement(...args) {
    return this.repositories.subscriptionsPlatform.hasPlatformEntitlement(...args);
  }

  // billing: readiness
  billingProfileCompleteness(...args) {
    return this.repositories.billingReadiness.billingProfileCompleteness(...args);
  }
  eventFinancialReadiness(...args) {
    return this.repositories.billingReadiness.eventFinancialReadiness(...args);
  }

  // subscriptions: subscriptions
  platformSubscriptions(...args) {
    return this.repositories.subscriptions.platformSubscriptions(...args);
  }
  subscriptionForViewer(...args) {
    return this.repositories.subscriptions.subscriptionForViewer(...args);
  }
  markSubscriptionCancellation(...args) {
    return this.repositories.subscriptions.markSubscriptionCancellation(...args);
  }

  // billing: invoices
  allocateInvoiceNumber(...args) {
    return this.repositories.billingInvoices.allocateInvoiceNumber(...args);
  }
  canAccessInvoice(...args) {
    return this.repositories.billingInvoices.canAccessInvoice(...args);
  }
  canManageInvoicePayment(...args) {
    return this.repositories.billingInvoices.canManageInvoicePayment(...args);
  }
  invoicesForViewer(...args) {
    return this.repositories.billingInvoices.invoicesForViewer(...args);
  }
  invoice(...args) {
    return this.repositories.billingInvoices.invoice(...args);
  }
  markInvoicePaid(...args) {
    return this.repositories.billingInvoices.markInvoicePaid(...args);
  }
  simulatePayment(...args) {
    return this.repositories.billingInvoices.simulatePayment(...args);
  }
  recordInvoicePdf(...args) {
    return this.repositories.billingInvoices.recordInvoicePdf(...args);
  }
  invoiceDocument(...args) {
    return this.repositories.billingInvoices.invoiceDocument(...args);
  }
  storeInvoiceDocument(...args) {
    return this.repositories.billingInvoices.storeInvoiceDocument(...args);
  }
  markVenueInvoiceGenerationFailed(...args) {
    return this.repositories.billingInvoices.markVenueInvoiceGenerationFailed(...args);
  }

  // venues: availability
  canManageVenue(...args) {
    return this.repositories.venuesAvailability.canManageVenue(...args);
  }
  canManageVenueBilling(...args) {
    return this.repositories.venuesAvailability.canManageVenueBilling(...args);
  }
  venueAvailability(...args) {
    return this.repositories.venuesAvailability.venueAvailability(...args);
  }
  venueTimezone(...args) {
    return this.repositories.venuesAvailability.venueTimezone(...args);
  }
  venueAvailabilityForDate(...args) {
    return this.repositories.venuesAvailability.venueAvailabilityForDate(...args);
  }
  venueBookingSettings(...args) {
    return this.repositories.venuesAvailability.venueBookingSettings(...args);
  }
  venueFinancialSettings(...args) {
    return this.repositories.venuesAvailability.venueFinancialSettings(...args);
  }
  saveVenueFinancialSettings(...args) {
    return this.repositories.venuesAvailability.saveVenueFinancialSettings(...args);
  }
  getVenueFinancialReadiness(...args) {
    return this.repositories.venuesAvailability.getVenueFinancialReadiness(...args);
  }
  updateVenueBookingSettings(...args) {
    return this.repositories.venuesAvailability.updateVenueBookingSettings(...args);
  }
  venueAvailabilityData(...args) {
    return this.repositories.venuesAvailability.venueAvailabilityData(...args);
  }
  calculateVenueAvailability(...args) {
    return this.repositories.venuesAvailability.calculateVenueAvailability(...args);
  }
  replaceVenueAvailabilityOverrides(...args) {
    return this.repositories.venuesAvailability.replaceVenueAvailabilityOverrides(...args);
  }
  venueCalendar(...args) {
    return this.repositories.venuesAvailability.venueCalendar(...args);
  }
  checkBookingConflict(...args) {
    return this.repositories.venuesAvailability.checkBookingConflict(...args);
  }
  createVenueAvailabilityBlock(...args) {
    return this.repositories.venuesAvailability.createVenueAvailabilityBlock(...args);
  }
  deleteVenueAvailabilityBlock(...args) {
    return this.repositories.venuesAvailability.deleteVenueAvailabilityBlock(...args);
  }
  createExternalReservation(...args) {
    return this.repositories.venuesAvailability.createExternalReservation(...args);
  }
  cancelExternalReservation(...args) {
    return this.repositories.venuesAvailability.cancelExternalReservation(...args);
  }

  // venues: venues
  venueMedia(...args) {
    return this.repositories.venues.venueMedia(...args);
  }
  addVenueMedia(...args) {
    return this.repositories.venues.addVenueMedia(...args);
  }
  venueImageVisible(...args) {
    return this.repositories.venues.venueImageVisible(...args);
  }
  venue(...args) {
    return this.repositories.venues.venue(...args);
  }
  venueBySlug(...args) {
    return this.repositories.venues.venueBySlug(...args);
  }
  venuesForViewer(...args) {
    return this.repositories.venues.venuesForViewer(...args);
  }
  createVenue(...args) {
    return this.repositories.venues.createVenue(...args);
  }
  replaceVenueRelations(...args) {
    return this.repositories.venues.replaceVenueRelations(...args);
  }
  updateVenue(...args) {
    return this.repositories.venues.updateVenue(...args);
  }
  deleteVenue(...args) {
    return this.repositories.venues.deleteVenue(...args);
  }
  createVenueInquiry(...args) {
    return this.repositories.venues.createVenueInquiry(...args);
  }
  eventForVenueInquiry(...args) {
    return this.repositories.venues.eventForVenueInquiry(...args);
  }
  venueInquiries(...args) {
    return this.repositories.venues.venueInquiries(...args);
  }
  updateVenueInquiryStatus(...args) {
    return this.repositories.venues.updateVenueInquiryStatus(...args);
  }
  moderateVenue(...args) {
    return this.repositories.venues.moderateVenue(...args);
  }
  submitVenueForModeration(...args) {
    return this.repositories.venues.submitVenueForModeration(...args);
  }
  saveVenue(...args) {
    return this.repositories.venues.saveVenue(...args);
  }
  unsaveVenue(...args) {
    return this.repositories.venues.unsaveVenue(...args);
  }
  savedVenues(...args) {
    return this.repositories.venues.savedVenues(...args);
  }
  similarVenues(...args) {
    return this.repositories.venues.similarVenues(...args);
  }

  // venues: bookings
  replaceVenueAvailability(...args) {
    return this.repositories.venuesBookings.replaceVenueAvailability(...args);
  }
  replaceVenueAvailabilitySlots(...args) {
    return this.repositories.venuesBookings.replaceVenueAvailabilitySlots(...args);
  }
  venueBookingContext(...args) {
    return this.repositories.venuesBookings.venueBookingContext(...args);
  }
  requestVenueBooking(...args) {
    return this.repositories.venuesBookings.requestVenueBooking(...args);
  }
  requestVenueBookingOnConnection(...args) {
    return this.repositories.venuesBookings.requestVenueBookingOnConnection(...args);
  }
  eventVenueBooking(...args) {
    return this.repositories.venuesBookings.eventVenueBooking(...args);
  }
  venueBookings(...args) {
    return this.repositories.venuesBookings.venueBookings(...args);
  }
  canAccessVenueBooking(...args) {
    return this.repositories.venuesBookings.canAccessVenueBooking(...args);
  }
  updateVenueBookingBuyerBillingProfile(...args) {
    return this.repositories.venuesBookings.updateVenueBookingBuyerBillingProfile(...args);
  }
  venueBookingMessages(...args) {
    return this.repositories.venuesBookings.venueBookingMessages(...args);
  }
  createVenueBookingMessage(...args) {
    return this.repositories.venuesBookings.createVenueBookingMessage(...args);
  }
  reviewVenueBookingLegacy(...args) {
    return this.repositories.venuesBookings.reviewVenueBookingLegacy(...args);
  }

  // venues: booking-finance
  venueBookingFinancialContext(...args) {
    return this.repositories.venuesBookingFinance.venueBookingFinancialContext(...args);
  }
  calculateVenueBookingPrice(...args) {
    return this.repositories.venuesBookingFinance.calculateVenueBookingPrice(...args);
  }
  getVenueBookingBillingReadiness(...args) {
    return this.repositories.venuesBookingFinance.getVenueBookingBillingReadiness(...args);
  }
  ensureVenueBookingInvoice(...args) {
    return this.repositories.venuesBookingFinance.ensureVenueBookingInvoice(...args);
  }
  externalInvoice(...args) {
    return this.repositories.venuesBookingFinance.externalInvoice(...args);
  }
  saveExternalInvoice(...args) {
    return this.repositories.venuesBookingFinance.saveExternalInvoice(...args);
  }
  markExternalInvoicePaid(...args) {
    return this.repositories.venuesBookingFinance.markExternalInvoicePaid(...args);
  }
  reviewVenueBooking(...args) {
    return this.repositories.venuesBookingFinance.reviewVenueBooking(...args);
  }
  cancelVenueBooking(...args) {
    return this.repositories.venuesBookingFinance.cancelVenueBooking(...args);
  }

  // moderation: moderation
  createPrivacyRequest(...args) {
    return this.repositories.moderation.createPrivacyRequest(...args);
  }
  contactMessages(...args) {
    return this.repositories.moderation.contactMessages(...args);
  }
  createModerationDecision(...args) {
    return this.repositories.moderation.createModerationDecision(...args);
  }
  moderationDecision(...args) {
    return this.repositories.moderation.moderationDecision(...args);
  }
  createModerationAppeal(...args) {
    return this.repositories.moderation.createModerationAppeal(...args);
  }
  resolveModerationAppeal(...args) {
    return this.repositories.moderation.resolveModerationAppeal(...args);
  }

  // privacy: privacy
  configureRetentionPolicies(...args) {
    return this.repositories.privacy.configureRetentionPolicies(...args);
  }
  applyRetentionPolicies(...args) {
    return this.repositories.privacy.applyRetentionPolicies(...args);
  }
  dataExport(...args) {
    return this.repositories.privacy.dataExport(...args);
  }
}
