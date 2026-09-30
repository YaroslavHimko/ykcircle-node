Event create/update requests accept optional `brandName` (up to 160 characters)
and `logoImage`. Venue create/update requests accept optional `logoImage` and
use `businessName`, falling back to the venue name, for invoice branding.
These fields are returned with event/venue details for editing.

The upload control accepts PNG, JPEG and WebP files up to 5 MB. It fits the image
within 640 × 320 pixels without cropping and flattens transparency onto white.
The API accepts the resulting JPEG data URL, bounded to 48 KB and 1024 × 1024
pixels. It does not accept remote URLs or SVG. Sending an empty string clears
the logo; omitting it on update preserves the existing logo.

Database initialization adds `events.brand_name`, `events.logo_image` and
`venues.logo_image` for existing installations. No external image storage or
new service credentials are needed.

Event registrations, invitations, group-event notices and ticket emails use
the organizer's branding, with an inline CID logo attachment and a small
“Delivered via YKCircle” footer. The configured authenticated sender address
is retained with the customer's brand as its display name. Account and platform
service emails retain their platform identity.

Ticket orders snapshot the organizer's name/logo alongside the legal seller.
Both printable tickets and the offline HTML ticket attachment use that snapshot.
Venue invoices snapshot the venue's branding alongside the legal seller and
embed the JPEG in the generated PDF. Editing a logo later does not alter already
issued documents. Existing invoices and tickets retain their original snapshots;
documents with no logo use the customer's name.

Validation includes API upload/removal checks, bounded-image validation,
inline email attachments, PDF image resources and object offsets, and immutable
invoice/ticket snapshots. Browser checks use a sample logo with mocked API data.
