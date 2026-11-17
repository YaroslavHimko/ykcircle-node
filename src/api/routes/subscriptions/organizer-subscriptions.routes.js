import { parseOwner, PUBLISH_ARTICLE } from '../../../domain/subscriptions/product-access.js';
import { subscriptionFeature } from '../../../services/subscriptions/organizer-subscriptions.js';
export function registerSubscriptionRoutes(
  app,
  { service, authenticate, requireVerifiedUser, initialize },
) {
  const handler = (action) => async (req, res) => {
    try {
      await initialize();
      return res.json(await action(req));
    } catch (error) {
      if (!error.status) console.error('Subscription operation failed:', error.message);
      return res.status(error.status || 502).json({
        code: error.code || 'SUBSCRIPTION_UNAVAILABLE',
        error: error.status ? error.message : 'Subscription service is temporarily unavailable.',
      });
    }
  };
  const staff = (req, res, next) =>
    ['admin', 'manager'].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: 'Administrator or manager access required.' });
  const ownerFromQuery = (req) =>
    parseOwner(
      req.query.ownerType ? { type: req.query.ownerType, id: req.query.ownerId } : null,
      req.user.id,
    );
  app.get(
    '/api/product-configuration',
    handler(() => service.access.configuration()),
  );
  app.put(
    '/api/admin/configuration',
    authenticate,
    staff,
    handler((req) => service.access.configure(req.body, req.user.id)),
  );
  app.get(
    '/api/my/article-access',
    authenticate,
    handler((req) => service.access.articleAccess(req.user.id)),
  );
  app.get(
    '/api/subscriptions/options',
    authenticate,
    handler(async (req) => {
      const feature = subscriptionFeature(req.query.feature);
      return {
        owners: (await service.owners(req.user.id)).filter(
          (owner) => feature !== PUBLISH_ARTICLE || owner.type === 'user',
        ),
        plans: await service.plans(feature),
        billingProfiles: await service.billingProfiles(req.user.id),
        configuration: await service.access.configuration(),
      };
    }),
  );
  app.get(
    '/api/subscriptions/me',
    authenticate,
    handler((req) =>
      service.summary(ownerFromQuery(req), req.user.id, subscriptionFeature(req.query.feature)),
    ),
  );
  app.post(
    '/api/subscriptions/checkout',
    authenticate,
    requireVerifiedUser,
    handler((req) =>
      service.checkout({
        owner: parseOwner(req.body.owner, req.user.id),
        user: req.user,
        priceId: Number(req.body.priceId),
        billingProfileId: Number(req.body.billingProfileId),
        returnTo: req.body.returnTo,
        feature: subscriptionFeature(req.body.feature),
      }),
    ),
  );
  app.post(
    '/api/subscriptions/portal',
    authenticate,
    handler((req) =>
      service.portal(
        parseOwner(req.body.owner, req.user.id),
        req.user.id,
        subscriptionFeature(req.body.feature),
      ),
    ),
  );
  app.post(
    '/api/subscriptions/:id/cancel',
    authenticate,
    handler((req) =>
      service.cancel(parseOwner(req.body.owner, req.user.id), req.user.id, Number(req.params.id)),
    ),
  );
  app.get(
    '/api/admin/subscriptions',
    authenticate,
    staff,
    handler(() => service.customers()),
  );
  app.post(
    '/api/admin/subscriptions/grants',
    authenticate,
    staff,
    handler((req) => service.grant(req.body, req.user.id)),
  );
  app.post(
    '/api/admin/subscriptions/grants/:id/revoke',
    authenticate,
    staff,
    handler((req) => service.revoke(Number(req.params.id), req.user.id, req.body.reason)),
  );
}
