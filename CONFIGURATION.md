# Runtime configuration

The API starts with `server/config.js`, which reads runtime environment variables.
Inject staging and production settings through the deployment pipeline's environment
and secret settings. They must be available to the running Node process, not only
to a build step. Restart the API after changing them. Run deployed instances with
`NODE_ENV=production` and `npm start`.

`server/config.local.js` and `server/config.example.js` only re-export the shared
configuration. Startup does not load `config.local.js`, so an old copy left on a
server cannot override pipeline values. Do not add deployment values to these files.

## Local development

`.env.example` is a credential-free template. `.env` is the private, Git-ignored
local runtime configuration. Use a separate random `AUTH_SECRET` for local sessions.
Start the API with:

```sh
npm run dev
```

`npm run dev` loads `.env`; `npm start` uses only the process environment. Keep
credentials out of `.env.example` and JavaScript configuration files. If `.env`
uses staging services, local operations affect that shared staging database,
mailbox and upload storage. Production requires explicit `DOMAIN`, `SITE_URL`,
and `API_URL`; development URL defaults point to localhost.

## Deployment variable groups

Use the variable names in `.env.example` as an inventory, replacing local defaults
in the pipeline rather than in repository files:

- Database: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`.
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`,
  sender and reply addresses. Remove stale per-stream credentials when using one
  shared SMTP account. `SMTP_DIAGNOSTICS=true` checks the connection, not the login.
- Uploads: each `FTP_PROFILE_*`, `FTP_EVENT_*`, `FTP_GROUP_*`, `FTP_ARTICLE_*`, and
  `FTP_VENUE_*` group. Set the TLS server name for each service when needed.
- Operator and disclosures: `PLATFORM_*`, contact addresses, provider details,
  `SUBPROCESSORS_JSON`, and `LEGAL_REQUIRE_READY`.
- Maps and payments: `GOOGLE_MAPS_*`, `STRIPE_*`, and feature switches.

Store passwords, `AUTH_SECRET`, API secrets, and webhook signing secrets using
the pipeline's secret storage. No deployment credentials are included in this repository's
configuration templates.
