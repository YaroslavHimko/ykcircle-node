# Venue marketplace frontend integration

The venue marketplace is API-first. The frontend must treat API responses as
the source of truth for publication and moderation state; it must never infer
that an active venue is public.

## Public discovery

Load the controlled filter options once and cache them for the current session:

- `GET /api/venue-types`
- `GET /api/venue-event-types`
- `GET /api/venue-amenities`

Search with `GET /api/venues`. Supported query parameters are `city`,
`venueType`, `eventType`, `amenity` (a comma-separated amenity slug list),
`minCapacity`, `maxCapacity`, `maxPrice`, and `verified=true`.

For SEO-friendly client routes, use paths such as `/venues/stockholm` and
`/venues/stockholm/event-spaces`, then translate route values into these API
parameters. Do not generate arbitrary indexable filter combinations.

Use `GET /api/venues/slug/:slug` for a public detail page and
`GET /api/venues/:id/similar` for its related cards. `GET /api/venues/:id`
remains available for existing integrations.

Public results are only `isActive: true` and `moderationStatus: "approved"`.
An active promotion is returned as `sponsored: true`; render a visible
“Sponsored” label whenever it is true.

## Response shape

Venue booleans and numbers are normalized by the API. A venue includes:

```json
{
  "id": 123,
  "name": "Barkarby Loft",
  "slug": "barkarby-loft",
  "venueType": "event-space",
  "venueTypeName": "Event space",
  "location": { "locality": "Barkarby", "municipality": "Järfälla", "region": "Stockholm County", "country": "Sweden", "latitude": 59.4, "longitude": 17.8 },
  "capacity": { "min": 20, "max": 120, "standing": 120, "seated": 70, "dining": 50, "classroom": 40 },
  "pricing": { "from": 3500, "unit": "evening", "currency": "SEK", "description": "Cleaning may be charged separately." },
  "amenities": [{ "slug": "wifi", "name": "Wi-Fi", "category": "technology" }],
  "suitableEventTypes": [{ "slug": "networking", "name": "Networking" }],
  "isActive": true,
  "isVerified": false,
  "verificationStatus": "unverified",
  "moderationStatus": "approved",
  "sponsored": false
}
```

Respect `locationVisibility`:

- `exact`: show the returned address and map pin.
- `approximate`: show locality/municipality only; do not reconstruct an
  address from other fields.
- `private_until_booking`: show “Exact address shared after booking
  confirmation.” Coordinates and street address are withheld from public API
  responses.

Only display a Verified badge for `verificationStatus === "verified"` (or the
equivalent `isVerified` field). Never use `isActive` as a moderation badge.

## Loading states

Use four explicit states for every list and detail query: `loading`, `error`,
`empty`, and `success`. Render skeleton cards while loading, a retryable error
message on failure, and “No venues found for these filters.” only after a
successful empty response. Do not use an empty array as a loading sentinel.

On mobile, put cover/gallery (when supplied), name, locality, capacity,
starting price, and Request Venue before long-form details. A sticky Request
Venue CTA is appropriate; no payment or booking settlement flow exists.

## Organizations and venue management

Create an organization before creating a venue:

1. `POST /api/organizations` with `name`, optional `slug`, `description`,
   `websiteUrl`, `phone`, and `contactEmail`.
2. `POST /api/venues` with the returned organization `id` as `organizationId`,
   plus the venue data.

The creating user becomes the organization `owner`. Organization roles are
`owner`, `admin`, `manager`, and `staff`; owners, admins, and managers can
create or edit venue listings. Existing legacy `venue_owner` accounts remain
supported, but frontend authorization should use the API result rather than
role-name assumptions.

Organization owners/admins can set a member role with
`PUT /api/organizations/:id/members/:userId` and `{ "role": "manager" }`.

Create/update venue payloads use camelCase: `shortDescription`, `venueType`,
`addressLine1`, `addressLine2`, `postalCode`, `city`, `municipality`,
`region`, `country`, `countryCode`, `latitude`, `longitude`, `googlePlaceId`,
`formattedAddress`, `locationVisibility`, capacity
fields, `sizeSqm`, `priceFrom`, `priceUnit`, `currency`,
`pricingDescription`, `minimumBookingHours`, `availabilityType`,
`houseRulesText`, `amenities` (slug array), and `suitableEventTypes` (slug
array). New listings start in `moderationStatus: "draft"` and therefore are
not public until approved.

## Requests and saved venues

Use `POST /api/venues/:id/inquiries` for Request Venue. The required fields
are `eventName` and `message`; supported optional fields are `eventId`,
`eventType`, `requestedDate` (`YYYY-MM-DD`), `startTime`, `endTime` (`HH:mm`),
`expectedGuests`, and `budget`. This creates a structured inquiry only—do not
present it as a confirmed booking or paid reservation.

Venue managers load and update requests with:

- `GET /api/venues/:id/inquiries`
- `PATCH /api/venues/:venueId/inquiries/:id` with one of `new`, `viewed`,
  `responded`, `accepted`, `declined`, or `cancelled`.

Save controls use `POST /api/venues/:id/save`, `DELETE /api/venues/:id/save`,
and `GET /api/my/saved-venues`.

The pre-existing event booking endpoints remain separate and should be labeled
as a booking request, not an automatic confirmed booking.

## Event locations and maps

`private_until_booking` is a legacy response value. New venue requests and
responses use `private`; both mean exact address, Place ID, formatted address,
and coordinates must be withheld from public API responses.

Event drafts and updates use exactly one `locationType`:

- `venue`: requires `venueId`; no custom address is persisted. The event response includes `venue: { id, name, location }` and follows the venue visibility rule.
- `custom`: requires a structured `location` object with `formattedAddress`, `latitude`, and `longitude`. Supported fields are `addressLine1`, `addressLine2`, `postalCode`, `locality`, `municipality`, `region`, `country`, `countryCode`, and `googlePlaceId`.
- `online`: does not send an address, coordinates, or venue. `onlineUrl` is returned only to the event manager/admin, so public pages must not show it.

Load `GET /api/maps/config` before initializing maps. It returns only the restricted browser key, whether Maps are enabled, and whether the real site must wait for consent. It never returns the server Maps key. If maps are disabled, consent is unavailable, or Google fails to load, still show the location text and a navigation link.

Use one client-side `MapLocation` component for venue and event pages. Build a Google Maps Embed URL only from the API's validated `googlePlaceId` or numeric coordinates (`encodeURIComponent` every value); never accept a map/iframe URL or raw HTML from a venue owner. For `private` venues do not render an embed or navigation link. For `approximate` venues use only the returned approximate coordinates, never reconstruct an address from hidden fields.
