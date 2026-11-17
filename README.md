# YkCircle API

The Node.js API for YkCircle, built with Express and MySQL. Source code is organized
by technical responsibility: API, database, configuration, services, and domain
rules. Routes and repositories are further grouped by feature so engineers can
work on unrelated areas independently.

## Get started

Use Node.js 24 (the baseline is recorded in `.node-version`) and npm.

```sh
npm ci
```

Copy `.env.example` to `.env`, configure your local services, and set a random
`AUTH_SECRET` of at least 32 characters. See [CONFIGURATION.md](CONFIGURATION.md)
for the complete configuration guide. Then run:

```sh
npm run dev
```

Development loads `.env`. Production uses `npm start` with environment variables
provided by the deployment environment. The executable entry point is
`src/application/main.js`.

## Project layout

```text
src/
  api/                 API class, Express setup, routes, middleware and HTTP helpers
  application/         Dependency composition, startup, shutdown and background jobs
  configuration/       Environment mapping and validated configuration classes
  database/            Database and query classes, repositories and schema
  domain/              Business constants and rules without service or database access
  services/            Business operations, email, storage and payment integrations
  utils/               Small utilities without application dependencies
resources/
  legal-documents/     Versioned legal content, loaded by the legal service
test/                  Behavioral tests and contract fixtures
scripts/               Development checks and operational tools
docs/ARCHITECTURE.md    Dependency rules and implementation guide
```

Start with [the architecture guide](docs/ARCHITECTURE.md) and
[contribution conventions](CONTRIBUTING.md) before adding a feature.

Source files and tests import their implementations directly from `src/`.
Deployments should use `npm start`; any custom command pointing to the old
`server/index.js` entry point must use `src/application/main.js` instead.

## Development commands

| Command                      | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `npm run dev`                | Start the API with `.env` and automatic restart |
| `npm start`                  | Start with the process environment              |
| `npm test`                   | Run the Node.js test suite                      |
| `npm run test:coverage`      | Run tests with coverage reporting               |
| `npm run lint`               | Check JavaScript for correctness issues         |
| `npm run format`             | Apply the shared formatting conventions         |
| `npm run format:check`       | Verify formatting without changing files        |
| `npm run check:architecture` | Check imports, dependency boundaries and cycles |
| `npm run check`              | Run all required local and CI checks            |
| `npm run smtp:check`         | Diagnose the configured SMTP connection         |

The test suite uses local HTTP listeners and fake service/database adapters; it
does not load `.env` or require a deployed database. CI runs the same checks on
Linux and Windows. Commit `package-lock.json` whenever dependencies change.

Database startup creates the fresh-install schema. It does **not** upgrade an
existing database; deploy schema changes with an explicit, reviewed migration.
