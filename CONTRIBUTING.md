# Contributing

## Working on a feature

1. Run `npm ci` and `npm run check` before changing code.
2. Choose the layer first: `src/api` for HTTP, `src/database` for persistence,
   `src/configuration` for settings, `src/services` for operations and integrations,
   and `src/domain` for business rules without I/O. Group routes and repositories
   by feature within their layers; for example, venue handlers live in
   `src/api/routes/venues` and venue repositories in `src/database/repositories/venues`.
3. Pass dependencies into functions and constructors. Keep credentials and
   concrete adapter construction in configuration and the application composition
   root. Avoid importing the startup entry point in library code or tests.
4. Add behavioral tests for changed authorization, validation, persistence,
   transaction, or external integration behavior. Inject fake adapters rather
   than contacting shared services.
5. Run `npm run format` and `npm run check` before requesting review.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for a worked route example, dependency
rules, module locations, and database considerations.

## Team conventions

- Use native JavaScript ES modules, explicit imports, `const` by default, and
  descriptive names. Prettier and EditorConfig define formatting.
- Name files with lowercase words separated by hyphens. Give routes the
  `.routes.js` suffix and repositories the `.repository.js` suffix.
- Prefer explicit exported functions and small classes. Avoid global service
  locators, prototype modification, import-time listeners, and cyclic imports.
- Import implementations directly from their `src/` layer. Do not add forwarding
  modules or recreate the old flat `server/` source tree. Start the application
  through `npm start` or `npm run dev`.
- Route handlers translate HTTP input and output. Put reusable workflows in
  services; put SQL and transaction handling in repositories.
- Preserve ownership checks, feature-access checks, transaction boundaries,
  parameterized SQL, signed media behavior, and webhook parser ordering.
- The `Queries` facade preserves existing callers. New repository methods can
  be called through `queries.repositories` without adding another legacy alias.
  Existing cross-feature operations use the facade so overrides and transaction
  arguments continue to work.
- Keep HTTP registration out of services and repositories. Only `src/application`
  starts the process and owns its resources; inner layers must not import it.
- Keep PRs focused on one behavior or feature. Explain the trigger, resulting
  behavior, validation, and any deployment requirement. Separate schema changes
  and unrelated dependency upgrades when practical.
- Never commit `.env`, credentials, uploads, or local service configuration.
  Update `.env.example` and `CONFIGURATION.md` when adding a runtime setting.

## Reviewing changes

CI verifies lint, formatting, architecture, and tests on Linux and Windows.
Check the behavior and ownership boundaries as well as the passing checks. For
database changes, review SQL and migration order separately: the automated suite
uses database doubles and cannot replace a MySQL staging migration rehearsal.

The route inventory fixture records the pre-refactor public contract, including
handler order. Change it deliberately when adding or removing routes, alongside
endpoint behavior tests. Do not replace the fixture just to make a failing test
pass.
