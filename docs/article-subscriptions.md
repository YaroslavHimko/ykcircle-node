# Article space subscriptions

Every registered user can manage their own articles. Writing, saving and editing drafts is free; writes require a verified email. During free early access (`subscriptionsEnabled=false`), publishing is free without subscription quotas. When subscriptions are enabled, publishing requires an active personal article subscription with `author.publish_article`, separate from event publishing. Platform administrators publishing on someone's behalf use the author's subscription and allowance.

Configuration includes `articlesPerMonth`, an integer from 0 to 1,000, defaulting to 1. It applies to each author's first publications in a UTC calendar month, including annual subscribers. Unused spaces do not roll over. Zero blocks new first publications. Archiving, removing or deleting articles does not restore spaces. Republishing the same article requires a subscription but does not use another space. Existing published articles stay public after subscription expiry.

## Setup

In Configuration, select **Article space** under Subscription plans and enter a recurring platform Stripe Price with its exact amount, currency and interval. The publishing-subscriptions switch controls both article and event subscriptions. Leave it off for the free launch. Existing Stripe customer, checkout, webhook, cancellation and invoice handling is reused. Both article and event subscriptions use `/api/payment-webhooks/stripe/subscriptions` with `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`, separate from ticket webhooks; see [webhook setup](organizer-subscriptions.md#webhook-destinations-and-activation-troubleshooting). No price is supplied automatically; configure and test a Stripe plan before offering it to customers.

Deploy frontend and API together against the fresh-install schema. Initialization creates subscription checkout feature fields and the article publication ledger directly; there are no historical backfills or schema upgrades. Publication and ledger insertion share a transaction; a lock on the author serializes concurrent publishing attempts. See [free launch](free-launch.md).

## API

- `GET /api/my/articles`: authenticated author's articles (administrators retain moderation access).
- `GET /api/my/article-access`: `hasSubscription`, `canPublish`, `monthlyLimit`, `used`, `remaining`, `resetsAt`, and matching entitlements.
- `POST /api/articles`: all verified users may create drafts; `status: published` applies the subscription and allowance checks atomically.
- `PATCH /api/articles/:id/status`: publishing applies the same checks. Content updates cannot change publication status.
- Missing access returns `403 ARTICLE_SUBSCRIPTION_REQUIRED` with a local `subscribeUrl`; exhausted allowance returns `409 ARTICLE_MONTHLY_LIMIT` with `resetsAt`.
- `GET /api/subscriptions/options` and `/api/subscriptions/me` accept `feature=author.publish_article`. The default remains `organizer.publish_event`.
- Checkout and portal requests accept the same `feature`. Checkout rejects organization owners for article space. Subscription lists, invoice lists, plan selection and duplicate-purchase checks are scoped by feature.
- `PUT /api/admin/configuration` accepts `articlesPerMonth` alongside the existing switches, with staff authorization and audit logging.

Subscriptions appear under Profile → Your publishing plans → Article space. The article workspace shows remaining spaces and a subscription link. The staff customer list includes article subscriptions by plan name. Event publishing grants do not grant article access.

Checkout presents three explicit steps: choose a plan, select or add billing details, and review the recurring price before continuing to Stripe. New billing details are selected immediately after saving. The same flow supports personal and organization event publishing when organizer subscriptions are enabled. After checkout, the confirmation screen links back to the saved draft; cancellation and provider failures leave a retry path.
