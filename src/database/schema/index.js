import { initializeIdentitySchema } from './identity.js';
import { initializeComplianceSchema } from './compliance.js';
import { initializeEventsAndGroupsSchema } from './events-and-groups.js';
import { initializeDiscussionsSchema } from './discussions.js';
import { initializeArticlesSchema } from './articles.js';
import { initializeVenuesSchema } from './venues.js';
import { initializeOrganizationsSchema } from './organizations.js';
import { initializeVenueAvailabilitySchema } from './venue-availability.js';
import { initializeBillingSchema } from './billing.js';
import { initializeVenueBillingSchema } from './venue-billing.js';
import { initializePlatformSchema } from './platform.js';
import { initializeTicketsSchema } from './tickets.js';
import { initializeVenueDirectorySchema } from './venue-directory.js';
// Keep this order explicit: later tables reference earlier tables.
// This creates a fresh schema; it is not an upgrade migration runner.
export async function initializeSchema(database) {
  await initializeIdentitySchema(database);
  await initializeComplianceSchema(database);
  await initializeEventsAndGroupsSchema(database);
  await initializeDiscussionsSchema(database);
  await initializeArticlesSchema(database);
  await initializeVenuesSchema(database);
  await initializeOrganizationsSchema(database);
  await initializeVenueAvailabilitySchema(database);
  await initializeBillingSchema(database);
  await initializeVenueBillingSchema(database);
  await initializePlatformSchema(database);
  await initializeTicketsSchema(database);
  await initializeVenueDirectorySchema(database);
}
