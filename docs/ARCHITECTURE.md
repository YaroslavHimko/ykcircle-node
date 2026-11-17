# Architecture

YkCircle is one deployable Node.js application with source grouped by technical
layer. Open `src/api` to work on HTTP, `src/database` to work on persistence, or
`src/configuration` to work on runtime settings. Related business features remain
grouped inside those layers so engineers can work on separate workflows.

## Folder structure

```text
src/
  api/
    api.js                         API class and ordered route registration
    create-app.js                  Express construction and middleware order
    context.js                     Per-application HTTP helper composition
    routes/<feature>/              Endpoint handlers
    middleware/                    Authentication, rate limits and security headers
    helpers/<feature>/             Validation, presentation and request helpers
  application/
    main.js                        Executable entry point and process signals
    bootstrap.js                   Resource initialization and graceful shutdown
    create-services.js             Concrete dependency construction
    background-jobs.js             Retention and ticket recovery lifecycle
  configuration/
    configuration.js               Configuration class and validation
    environment.js                 Environment variable mapping
  database/
    database.js                    MySQL pool and connection lifecycle
    queries.js                     Query facade and repository composition
    query-executor.js              Existing query normalization behavior
    repositories/<feature>/        Persistence classes and functions
    schema/                        Ordered fresh-install schema steps
  domain/<feature>/                Statuses, constants and rules without I/O
  services/<area>/                 Business operations and external integrations
  utils/                          Time, URL, serialization and branding helpers
```

`src/application/main.js` is the executable entry point used by `npm start` and
`npm run dev`. All source imports, including tests and operational scripts, point
directly to their implementations under `src/`; there is no parallel forwarding
tree. Custom deployment commands must also use the new entry point.

Versioned legal content lives in `resources/legal-documents/` and is read by
`src/services/legal/legal-documents.js`. Moving those files does not change their
contents, published URLs, or versions. Local legal working notes are preserved
under the ignored `docs/legal/` directory and are not loaded by the application.

## Dependency rules

| Layer           | May import                                                               |
| --------------- | ------------------------------------------------------------------------ |
| `application`   | Any source layer; it coordinates the application                         |
| `api`           | API helpers, services, domain rules, utilities, and repository functions |
| `configuration` | Configuration and utilities                                              |
| `database`      | Database modules, domain rules, and utilities                            |
| `services`      | Services, repositories, domain rules, and utilities                      |
| `domain`        | Domain rules and utilities                                               |
| `utils`         | Other utilities                                                          |

API code receives database connections through dependencies; it must not import
the pool, schema runner, query facade, or query executor. Services and repositories
must not import HTTP handlers or application startup. Domain code contains no
database, email, storage, or payment integration imports.

`npm run check:architecture` checks this dependency table, source import
resolution, cycles, and the locations of route and repository modules. It also
keeps Express/CORS/Multer in the API layer, MySQL in the database layer, and
SMTP/FTP/Stripe libraries in services. It rejects a recreated legacy `server/`
directory and imports of the executable entry point. The check enforces import boundaries;
runtime behavior still needs tests and review.

## Where to make a change

| Change                                 | Location                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| Add an event endpoint                  | `src/api/routes/events/`                                     |
| Validate a venue request               | `src/api/helpers/venues/`                                    |
| Change authentication middleware       | `src/api/middleware/authentication.js`                       |
| Add a database query                   | `src/database/repositories/<feature>/`                       |
| Change fresh-install table definitions | `src/database/schema/`                                       |
| Add an environment setting             | `src/configuration/`, `.env.example`, and `CONFIGURATION.md` |
| Update ticket purchasing behavior      | `src/services/tickets/`                                      |
| Change SMTP or FTP integration         | `src/services/email/` or `src/services/storage/`             |
| Change a status or pure pricing rule   | `src/domain/events/` or `src/domain/venues/`                 |

For example, venue API handlers live in `src/api/routes/venues`, database
operations in `src/database/repositories/venues`, and availability and price
calculations in `src/domain/venues`.

## HTTP composition

`createApp({ config, api, environment })` constructs Express without listening,
initializing a database, or starting background jobs. Tests can supply a fake API
and inspect the actual middleware behavior.

Middleware order is intentional:

1. Proxy settings, HTTPS enforcement, security headers, and CORS.
2. Raw body parsers and Stripe webhook handlers.
3. JSON body parsing and public request rate limits.
4. Route registration in `src/api/api.js`, including product-access middleware.

Stripe signatures require the original request bytes. Do not register webhooks
behind `express.json()`. Some endpoints have multiple ordered handlers; the route
inventory fixture protects their order, methods, paths, and handler counts.

HTTP helpers are created once per application in `src/api/context.js`. Each
factory and route function declares the dependencies it consumes. The context
is per application, not a global singleton.

Add routes explicitly rather than relying on filesystem discovery:

```js
export function registerExampleRoutes(app, { authenticate, queries }) {
  app.get('/api/examples/:id', authenticate, async (req, res) => {
    try {
      const example = await queries.repositories.examples.findForViewer(req.params.id, req.user.id);
      if (!example) return res.status(404).json({ error: 'Example not found.' });
      return res.json(example);
    } catch {
      return res.status(500).json({ error: 'Unable to load example.' });
    }
  });
}
```

This is an illustrative example; `examples` is not an existing repository. Put
the handler in `src/api/routes/examples`, add persistence under
`src/database/repositories/examples`, and register it in `src/api/api.js`. Move
reusable workflows into a service rather than duplicating them in handlers.

## Database and services

`src/database/queries.js` preserves the existing query interface with explicit
delegation to repositories. It contains no SQL. New methods can be called through
`queries.repositories` without adding another legacy alias. Repositories receive
the database, coordinating query interface, and product access where needed.

Existing cross-feature operations continue through the query interface, including
transaction connections and authorization parameters. Do not open an independent
transaction midway through an operation that already owns a connection.

The `ProductAccess` class and email preference persistence are under
`src/database/repositories`. Their HTTP registration belongs under `src/api/routes`,
while product constants and owner validation live in `src/domain/subscriptions`.
This lets services use persistence without importing HTTP code.

`query-executor.js` retains existing parameter normalization and legacy filtering
of soft-deleted events. The filter is not an authorization boundary. Write new SQL
with explicit ownership and `deleted_at` predicates. Construct one query facade
for each application database because the adapter wraps its injected executor.

`src/database/schema/index.js` lists fresh-install steps in foreign-key dependency
order. They retain the existing SQL and defaults and are **not** upgrade
migrations. Existing deployments must already match the release schema; add a
reviewed migration before deploying schema changes to populated databases.

## Startup and shutdown

`createServices(config)` constructs dependencies. `startApplication(...)`
initializes the schema, records published legal versions, checks legal readiness,
configures retention, opens the listener, and starts jobs. It returns
`{ app, server, close }`. Startup failure releases database resources.

`close()` is idempotent: it stops both job timers, drains active jobs and HTTP
requests, and closes the database. Process signal handlers belong only to
`src/application/main.js`.

## Verification

Run `npm run check` for lint, formatting, import boundaries, and behavioral tests.
The suite covers endpoints, repositories, fresh-schema ordering, the route
inventory, real Express middleware, and startup/shutdown. It uses local listeners
and fake adapters without loading `.env` or contacting deployed services.
Live MySQL migrations and Stripe/SMTP/FTP integrations still need staging
validation when their behavior changes.
