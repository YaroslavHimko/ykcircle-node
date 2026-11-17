import { createHttpUploads } from './helpers/uploads.js';
import { createLegalPages } from './helpers/legal/pages.js';
import { createHttpDatabase } from './helpers/database.js';
import { createAccountsAuthentication } from './middleware/authentication.js';
import { createMediaAccess } from './helpers/media/access.js';
import { createMediaPresentation } from './helpers/media/presentation.js';
import { createHttpWriteGuards } from './helpers/write-guards.js';
import { createModerationReportValidation } from './helpers/moderation/report-validation.js';
import { createVenuesValidation } from './helpers/venues/validation.js';
import { createBillingValidation } from './helpers/billing/validation.js';
import { createVenuesPresentation } from './helpers/venues/presentation.js';
import { createEventsValidation } from './helpers/events/validation.js';
import { createTicketsCheckIn } from './helpers/tickets/check-in.js';
import { createBillingDocuments } from './helpers/billing/documents.js';
import { createArticlesValidation } from './helpers/articles/validation.js';
import { createGroupsValidation } from './helpers/groups/validation.js';
import { createEventsFollowups } from './helpers/events/followups.js';
// Helpers are initialized once per application, in dependency order.
export function createHttpContext(app, dependencies) {
  const context = { ...dependencies, app };
  Object.assign(context, createHttpUploads(context));
  Object.assign(context, createLegalPages(context));
  Object.assign(context, createHttpDatabase(context));
  Object.assign(context, createAccountsAuthentication(context));
  Object.assign(context, createMediaAccess(context));
  Object.assign(context, createMediaPresentation(context));
  Object.assign(context, createHttpWriteGuards(context));
  Object.assign(context, createModerationReportValidation(context));
  Object.assign(context, createVenuesValidation(context));
  Object.assign(context, createBillingValidation(context));
  Object.assign(context, createVenuesPresentation(context));
  Object.assign(context, createEventsValidation(context));
  Object.assign(context, createTicketsCheckIn(context));
  Object.assign(context, createBillingDocuments(context));
  Object.assign(context, createArticlesValidation(context));
  Object.assign(context, createGroupsValidation(context));
  Object.assign(context, createEventsFollowups(context));
  return context;
}
