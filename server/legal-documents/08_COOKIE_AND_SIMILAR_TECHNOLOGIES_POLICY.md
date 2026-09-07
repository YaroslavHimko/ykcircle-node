# YKCircle Cookie & Similar Technologies Policy

> **Draft — publish only after auditing the real website/app implementation.**  
> Last updated: 7 September 2026

## 1. Scope

YKCircle may use cookies, local storage, SDK storage, pixels and similar technologies.

This Policy must match the technologies actually loaded in production.

Do not invent a cookie inventory.

## 2. Strictly necessary

May include technologies needed for authentication, session security, CSRF/security, rate limiting/security state, load balancing, legal/cookie preferences and essential checkout/session continuity.

Where a technology is strictly necessary to provide a user-requested service, consent may not be required under the applicable cookie rule, but the inventory/purpose still needs to be documented appropriately.

## 3. Preferences

May include optional preferences such as language, UI settings, calendar view, selected city and non-essential personalization.

Classify each technology based on its real purpose.

## 4. Analytics

Analytics technologies must not be loaded before valid consent where consent is required.

Analytics provider(s): [ACTUAL ANALYTICS PROVIDERS OR "NONE"]

## 5. Marketing

Advertising, retargeting and marketing-attribution technologies must not be loaded before valid consent where consent is required.

Marketing provider(s): [ACTUAL MARKETING PROVIDERS OR "NONE"]

## 6. Maps and embedded third-party content

Audit Google Maps/Places and any embedded third-party content for cookies/local storage, network requests, consent requirements and privacy disclosures.

Do not classify a map SDK as strictly necessary merely because the feature is useful. Determine whether it is necessary for the specific user-requested function and whether non-essential storage/processing occurs.

Where appropriate, defer loading until the required choice is made.

## 7. Payment SDKs

Audit [PAYMENT PROVIDER] SDK/Checkout behavior separately.

Some payment/security technologies may be necessary for a user-requested payment.

Do not automatically classify every provider technology as marketing.

## 8. Consent controls

Where consent is required, users should be able to:

- accept all non-essential categories;
- reject non-essential categories;
- customize categories;
- change/withdraw their choice later.

Do not preselect optional categories.

Rejecting should be as easy as accepting.

## 9. Consent record

Store consent version, timestamp and selected categories, plus only additional region/context needed for compliance.

Do not store more identifying information than needed to prove/manage preference.

## 10. Cookie inventory

Generate from a real production audit.

| Name / Storage key | Provider | Purpose | Category | Duration | Trigger |
|---|---|---|---|---|---|
| [ACTUAL] | [ACTUAL] | [ACTUAL] | [ACTUAL] | [ACTUAL] | [ACTUAL] |

## 11. Change settings

Cookie settings: [COOKIE SETTINGS LINK]

## 12. Contact

[PRIVACY EMAIL]
