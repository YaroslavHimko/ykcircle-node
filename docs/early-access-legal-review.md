# Free early-access legal review — 2 October 2026

The public policy set is Terms of Service, Privacy Policy, Community Guidelines, and Cookie & Browser Storage Policy, version `2026-10-02`. The operator is an individual, Yaraslau Khimko. Public operator disclosures have no company, organisation-number or VAT-number fields. `/operator` is the visible route; `/company` remains a compatibility route.

The five commercial documents (organizer/seller terms, venue terms, ticket/refund policy, paid-service terms and marketplace transparency) are not in the public registry, are not returned by the legal API, and cannot be loaded through their old document-type aliases. Their source files are retained privately for future revision. Enabling a paid feature does not automatically republish those drafts. Historical accepted versions in the database remain intact.

Footer and legal-index links include only the four public policies. The frontend also filters stale API indexes. During free access, payment/subscription/financial settings routes show an unavailable page, and navigation omits their links. Keep all four switches in `/admin/configuration` off.

## Production values

The confirmed identity and provider details were updated in the ignored `server/config.local.js`. The deployed environment overrides that file, so update these production values as well:

```ini
PLATFORM_OPERATOR_NAME=Yaraslau Khimko
PLATFORM_REGISTERED_ADDRESS=Barkarbyvägen 134, lgh 1305, 177 68 Järfälla, Sweden
PLATFORM_COUNTRY=Sweden
PLATFORM_OPERATOR_EMAIL=support@ykcircle.com
SUPPORT_EMAIL=support@ykcircle.com
PRIVACY_EMAIL=privacy@ykcircle.com
MODERATION_EMAIL=moderation@ykcircle.com
```

Organisation/VAT numbers are not published. Local sample numbers were removed. Remove stale production number variables if they do not apply.

Replace an old sample `SUBPROCESSORS_JSON` value with the actual Hostinger inventory. Hosting/backups and email now have separate entries. Entries support `name`, `purpose`, `region`, `transferSafeguards`, and optional `privacyUrl` / `dpaUrl`.

The operator confirmed Hostinger server `server517` is in the Netherlands and its backups are in Lithuania. These locations are recorded in the local hosting entry and appear in the public provider list. The server name is an internal reference and is not included in that public entry.

The email processing location and applicable transfer arrangements (including any separate support or subprocessor access) remain unconfirmed. The local email `region` and both entries' `transferSafeguards` remain unset; the readiness check continues to report those items. Website and backup locations alone do not establish where email or support processing occurs. Review the applicable [Hostinger data processing addendum](https://www.hostinger.com/legal/dpa).

Set production `SUBPROCESSORS_JSON` to this JSON to match the current local inventory, then replace the null values when confirmed:

```json
[
  {
    "name": "Hostinger hosting and backups",
    "purpose": "Website hosting, database and file storage, and backups",
    "region": "Hosting: Netherlands. Backups: Lithuania.",
    "transferSafeguards": null,
    "privacyUrl": "https://www.hostinger.com/legal/privacy-policy",
    "dpaUrl": "https://www.hostinger.com/legal/dpa"
  },
  {
    "name": "Hostinger email",
    "purpose": "Email hosting and delivery",
    "region": null,
    "transferSafeguards": null,
    "privacyUrl": "https://www.hostinger.com/legal/privacy-policy",
    "dpaUrl": "https://www.hostinger.com/legal/dpa"
  }
]
```

`LEGAL_REQUIRE_READY=true` will prevent startup until the configured readiness blockers are resolved. Payment-provider settings are no longer required by that check during this free release. Its result checks configuration completeness; it is not a legal-compliance certificate.

## Processing facts still requiring operational verification

- Confirm the email processing location, any additional support/subprocessor processing, transfer arrangements, backup rotation and the deployment's actual optional scripts/storage. The source inventory covers the application's current browser-storage keys; it is not a scan of hosting-injected scripts.
- If embedded Maps is enabled, configure consent and include its actual processing in the provider inventory. The policy text follows the runtime Maps setting. Verify the deployed consent behavior.
- Account deletion disables/anonymizes core account fields and hides owned content; it does not automatically erase every historical record or media attachment. The revised notice describes that limit. Handle remaining-data requests and retention reviews in practice, including retained support/moderation records and backups. Token cleanup runs on startup and daily; it does not establish a universal retention period for other data.
- Exercise registration/verification, privacy export/deletion, support, moderation and appeals against the deployed service before accepting real users. Update production environment overrides and deploy both repositories together.

## Sources and validation

The review used the [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/), [IMY's explanation of data-subject rights](https://www.imy.se/en/individuals/data-protection/your-rights-as-a-data-subject/), and [PTS guidance on cookies](https://www.pts.se/internet-och-telefoni/kakor-cookies/). The notices identify an individual controller, explain current processing, provide rights/contact routes, and remove descriptions of unavailable commercial services. Full compliance also depends on the actual processing and unresolved provider facts above.

Validation: 217 backend tests, frontend lint/build, and desktop/mobile browser checks with mocked APIs. Checks cover the four policies, operator/provider details, absent commercial links, retired document URLs, stale-index filtering, free-access profile navigation, and cookie settings. No real user action or live deployment was performed.
