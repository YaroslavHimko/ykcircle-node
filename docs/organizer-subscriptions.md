# Organizer subscriptions and feature configuration

## Rollout

The agreed rule is **drafts stay available; subscription access is checked when publishing**. Both `POST /api/events/:id/publish` and the status endpoint apply the same check. A denied publication returns `403 SUBSCRIPTION_REQUIRED`, the organizing owner, and a local Subscribe URL. The editor redirects there and preserves the saved draft. Returning from Checkout never publishes automatically.

Database initialization creates the complete fresh-install schema. Historical upgrade and backfill code has been removed for the database reset. See [free launch](free-launch.md).

All four switches default to **off** in `product_configuration`. Administrators and managers can change them under **Profile menu → Configuration** (`/admin/configuration`). They are persisted in the database and checked per request, without a restart. The old `ENABLE_PAID_EVENTS` environment value is not an override for these product switches; its existing legal-readiness use remains separate.

1. Deploy the API and frontend together, allowing database initialization to finish.
2. Configure the platform Stripe secret key and the separate `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` (or `runtime.stripe.subscriptionWebhookSecret` in `server/config.local.js`). Keep the existing ticket `webhookSecret` and onboarding `thinWebhookSecret`. Subscription Checkout uses the platform account; it never uses a seller's Connect account.
3. Create a recurring Stripe Price and add its exact amount, currency, interval, and Price ID in Configuration. Monthly and annual prices may share a plan code. No amount or annual discount is selected automatically. Checkout validates the actual Stripe Price against the local configuration before charging.
4. Enable Stripe Billing's customer portal for this platform account, including invoice access and payment-method management. Configure cancellation at period end. Configure permitted plan changes if desired.
5. Create a separate **Your account**, **Snapshot** destination for `/api/payment-webhooks/stripe/subscriptions` in the same Stripe sandbox/live environment as Checkout. Deliver `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Set `subscriptionWebhookSecret` to this destination's signing secret and restart the API. Keep the existing connected-account ticket webhook setup as well.
6. Test a subscription, renewal, failed renewal, cancellation, and webhook replay using Stripe test mode. Then enable organizer subscriptions in Configuration when the commercial policy is ready.
7. Enable paid events and/or paid venues separately. Paid tickets still require the existing seller profile and ready connected account. Free events never require Connect onboarding.

Configuration changes do not cancel an existing Stripe subscription. Disabling subscription enforcement gives everyone publishing access; existing subscriptions must be managed separately. Disabling paid features rejects new paid events, ticket checkout (including resuming checkout through the app), positive venue rates, new paid booking requests, and approval of paid requests. Already-issued tickets, refunds, check-in, and previously confirmed venue billing obligations remain operable. A Checkout URL already opened at Stripe before disabling a feature cannot be recalled by an application switch; verified payments continue to be fulfilled.

## Webhook destinations and activation troubleshooting

Each destination verifies its own signing secret; there is no fallback to another destination's secret.

| Purpose | API path | Server configuration | Environment variable |
| --- | --- | --- | --- |
| Connected-account ticket snapshots | `/api/payment-webhooks/stripe` | `runtime.stripe.webhookSecret` | `STRIPE_WEBHOOK_SECRET` |
| Platform subscription snapshots (events and articles) | `/api/payment-webhooks/stripe/subscriptions` | `runtime.stripe.subscriptionWebhookSecret` | `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET` |
| Accounts v2 thin events | `/api/payment-webhooks/stripe/thin` | `runtime.stripe.thinWebhookSecret` | `STRIPE_THIN_WEBHOOK_SECRET` |

For the default deployment, the subscription URL is `https://api.ykcircle.com/api/payment-webhooks/stripe/subscriptions`. Add `subscriptionWebhookSecret` inside the existing `runtime.stripe` object in `server/config.local.js`, or set its environment variable on the API server. Environment variables take precedence over local configuration. Do not replace the ticket secret. Existing one-off platform-order handling also remains on its original endpoint.

Deploy the API change before switching subscription deliveries to the new URL. Subscriptions are no longer reconciled on the ticket endpoint. A subscription event sent there is rejected before recording its event ID; retry it on the subscription endpoint. If an older deployment already recorded an event as ignored, resend a different subscription event from the same completed Checkout, such as `customer.subscription.created`, so reconciliation uses an unconsumed event ID.

When Stripe shows an active subscription but the app says activation is pending, inspect the subscription destination's event deliveries. No delivery suggests the wrong account scope, event selection, or sandbox/live environment. `400 Invalid Stripe subscription webhook signature` means the signature could not be verified: check this destination's signing secret and that the server receives the original raw body. A `404` means the URL or deployed API needs checking. A `500` is retryable; inspect the API log beginning `Stripe subscription webhook processing failed:`.

After correcting configuration and restarting the API, resend the existing subscription's `checkout.session.completed` event from Stripe and refresh the app. Do not purchase another subscription. No frontend change or database migration is required for this webhook separation. See [Stripe webhook setup and retries](https://docs.stripe.com/webhooks).

## Identity and capabilities

The stable capability is `organizer.publish_event` in `platform_entitlements`. Access is resolved for exactly one owner: `{type: "user", id}` or `{type: "organization", id}`. An organization entitlement does not grant personal publishing access, and a personal subscription does not cover an organization's events. Organization owner/admin/manager membership is required for subscription management and publication on that organization's behalf.

An event's personal owner is its existing manager. `organizer_organization_id`, chosen when creating the draft, explicitly switches the organizing identity to an organization. This choice is immutable after creation, including for recurring occurrences. Seller billing profiles and connected accounts cannot change it. Platform staff publishing another person's event uses that event owner's access, not the staff member's subscription. Existing event-management permissions also remain required.

With enforcement off, access reports `early_access` without manufacturing subscription or entitlement records. With enforcement on, a valid capability grants access. Stripe `active` and `trialing` subscriptions grant until the current period end; cancellation scheduled at period end preserves that access. `past_due`, `unpaid`, `paused`, `incomplete`, `incomplete_expired`, and `canceled` do not grant access. There is no automatic grace period or grandfathering. Configuration provides audited, expiring manual grants (`admin`, `early_access`, `promotion`, `partner`, `grandfathered`, `trial`) when an explicit exception is needed.

Historical subscriptions from the old generic platform-order flow are retained as records. That flow no longer sells or activates subscriptions. It must not be used to migrate existing Stripe subscribers: reconcile those owners, provider IDs, checkout bindings, and period dates deliberately before enabling enforcement, or issue a reviewed, expiring manual grant. No assumed paid access is backfilled.

## Checkout and reconciliation

`subscription_customers` maps each organizing identity to its own platform Stripe Customer. The selected active billing profile must belong to that exact identity, even if the actor is a platform administrator. No seller connected-account ID is used as a Customer ID.

Checkout serializes each owner with a MySQL named lock shared by webhook reconciliation. It persists a checkout attempt before contacting Stripe and uses stable customer/attempt idempotency keys. Concurrent retries reuse the open session. Existing active, trialing, past-due, unpaid, paused, or incomplete subscriptions prevent duplicate purchasing. Ambiguous attempts or customer creation older than 23 hours require operator reconciliation rather than risking a second charge after Stripe's idempotency retention window. Inspect `subscription_checkouts`, `subscription_customers`, Stripe request logs, and the saved idempotency key before resolving those cases.

Only the raw-body, signature-verified webhook route activates subscriptions. Metadata locates a local attempt; current provider Customer, subscription, configured plan, Checkout mode/status, and client reference must also match. The current subscription is retrieved **after** obtaining the owner lock, so out-of-order payloads cannot restore stale active status. Event IDs and state changes commit in one transaction. Failures return a retryable response; duplicate delivery has no second effect. Subscription changes revoke only their own `source_type='subscription'` grants, preserving manual and partner access.

The success page polls for up to 30 seconds, then gives a pending message. Refreshing it only reads local status. Delayed activation depends on webhook delivery/retry. Entitlements expire on their recorded period end even if a cancellation webhook is missed; missed renewal delivery can temporarily deny new publications until reconciliation succeeds. Existing published events are never automatically unpublished.

Stripe remains the official subscription invoice source. `subscription_invoices` stores Stripe invoice IDs, status, amounts in minor currency units, and hosted/PDF links. The custom venue invoice generator is not called for subscriptions.

Stripe API references used for this integration: [Subscription object and item billing periods](https://docs.stripe.com/api/subscriptions/object), [subscription Checkout](https://docs.stripe.com/api/checkout/sessions), and [customer portal](https://docs.stripe.com/customer-management).

## API and screens

| Endpoint | Purpose |
| --- | --- |
| `GET /api/product-configuration` | Public feature switches |
| `PUT /api/admin/configuration` | Staff-only boolean switch changes, audited |
| `GET /api/subscriptions/options` | Eligible organizing accounts, their selectable billing profiles, and configured plans |
| `GET /api/subscriptions/me?ownerType=user&ownerId=…` | Owner-authorized access, subscriptions, invoice links |
| `POST /api/subscriptions/checkout` | `{owner, priceId, billingProfileId, returnTo}` |
| `POST /api/subscriptions/portal` | Owner-authorized Stripe portal session |
| `POST /api/subscriptions/:id/cancel` | `{owner}`; cancel renewal at period end |
| `GET /api/admin/subscriptions` | Staff customer subscriptions and entitlement sources |
| `POST /api/admin/subscriptions/grants` | `{owner, source, endsAt, reason}` |
| `POST /api/admin/subscriptions/grants/:id/revoke` | Revoke a non-subscription grant with `{reason}` |

Subscriptions are available at `/profile/subscriptions` and `/subscribe`, linked from the profile and both navigation menus. Configuration includes switches, plan prices, subscribed customers, and temporary grants. The staff overview currently returns the latest 500 subscriptions and 1,000 entitlement records; filtering is within that returned set. Provider card details are not stored or shown.

## Verification

`node --test` includes HTTP tests for draft/publish behavior, manager-only configuration, bypass attempts, signature rejection, and canonical subscription reconciliation. Service tests cover owner isolation, expiry, period-end cancellation, duplicate/concurrent checkout, ambiguous provider timeouts, price mismatch, replay/out-of-order delivery, and preservation of unrelated entitlement sources. Frontend production build and mobile browser checks are performed locally with mocked APIs. Deployment should additionally exercise fresh schema initialization against a staging MySQL database and complete a real Stripe test-mode lifecycle before enabling charging.
