# Financial architecture migration report

This report records the pre-migration audit required for the financial refactor.
It is deliberately conservative: no ownership or authorization column is renamed
or removed by this release.

| Existing model | Current purpose | Future replacement / extension | Migration strategy | Risk |
| --- | --- | --- | --- | --- |
| `users.role` | Coarse application role | Unchanged; remains authorization only | No data migration | High if confused with billing ownership |
| `organizations` and `organization_members` | Venue and team ownership/permissions | Unchanged; organization profiles are linked financial identities | Add an optional default billing-profile reference only | High: billing profile must not grant permission |
| `venues.owner_user_id`, `venues.organization_id` | Venue ownership and management | Unchanged; `venues.billing_profile_id` is seller identity only | Retain both values; validate seller profile at issuance | High: never replace owner with profile |
| `events.manager_id` | Event organizer/manager | Unchanged; `event_payment_settings` adds a seller profile and payment account | Retain manager ID; validate financial settings independently | High: free events must remain onboarding-free |
| `venue_bookings.organizer_user_id` | Booking requester | `buyer_billing_profile_id` is an additional financial buyer reference | Keep requester and add/retain buyer profile + derived billing status | Medium: legacy paid bookings can be incomplete, never crash invoice creation |
| `billing_profiles` | Canonical legal/financial identity | Extended with lifecycle and defaults | Keep IDs; archive rather than delete | Medium: issued records must use snapshots |
| `invoices`, `invoice_items`, `payments` | Venue invoice/accounting records | General invoice engine with seller-scoped series and context type | Add nullable context/series fields; preserve existing invoice numbers and snapshots | High: never renumber existing issued invoices |
| `event_registrations` | RSVP / legacy registration status | Ticket orders are separate payment records | Keep registrations working; paid orders are additive | Medium: do not infer payment truth from frontend state |
| No platform billing domain | N/A | Products, prices, orders, subscriptions, entitlements | New additive tables and APIs | Medium: activation is provider-event driven |
| No durable ticket payment domain | N/A | Payment account, ticket order, refund/dispute event records | New additive tables; direct-charge provider IDs only | High: do not create a platform payout wallet |

## Compatibility rules

- Existing users without a billing profile continue to create, publish, and RSVP
  to free events.
- `venues.owner_user_id`, `venues.organization_id`, `events.manager_id`, and
  organization membership are authorization relationships and are not migrated.
- Existing invoice rows and PDFs remain valid. New series are used only for
  newly issued invoices.
- A missing billing profile on a legacy paid booking is reported as incomplete
  before confirmation; it is never allowed to turn into an invoice-time server
  error.
- Financial rows use `RESTRICT` / `SET NULL` references where appropriate and
  snapshots for issued records. No destructive migration is included.

## Platform accounting decision

YKCircle's invoice engine is the canonical accounting document for platform
sales. Stripe Checkout, PaymentIntent, and Stripe Billing invoice IDs are
stored only as payment-processing references in `platform_payments`. A
successful platform order receives one YKCircle invoice from the platform
Billing Profile's seller-specific sequence; webhook retries are deduplicated
before that invoice can be issued again.
