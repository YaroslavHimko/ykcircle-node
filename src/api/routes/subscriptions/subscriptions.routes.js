import { registerSubscriptionRoutes } from './organizer-subscriptions.routes.js';

export function registerSubscriptionsRoutes(
  app,
  { subscriptions, authenticate, requireVerifiedUser, ensureTable },
) {
  registerSubscriptionRoutes(app, {
    service: subscriptions,
    authenticate,
    requireVerifiedUser,
    initialize: ensureTable,
  });
}
