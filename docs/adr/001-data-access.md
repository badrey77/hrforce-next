# ADR 001: Data access — Kysely with plain-SQL forward-only migrations

**Status:** Accepted
**Date:** 2026-09-24

## Context

The legacy design doc §5 specifies TypeORM, on the assumption that HRForce Next is an
in-place upgrade of the legacy application and its existing database. HRForce Next is
instead a rewrite: a new NestJS API against a new Postgres database, with no live schema
or entity graph to migrate incrementally. That removes the main reason to keep an
ORM's synchronize/migration-generation workflow, and frees us to pick the data-access
layer on its own merits.

The Phase 1 plan requires: two-role database access (a migrator role that owns schema
DDL, and a restricted app role subject to Row Level Security), an audit trigger that
reads session-local settings inside the request transaction, and a target of Postgres 18
while keeping application code compatible with Postgres 16. `apps/api` is organized into
`domain/` (no framework or DB imports), `infra/` (repositories), and `application/` (use
cases) — the data-access layer must be a library that infra/ can wrap, not a framework
that leaks into domain/.

## Decision

Use **Kysely** as the SQL query builder, with **plain-SQL, forward-only migrations**.

- Migrations live at `apps/api/migrations/NNNN_description.sql` (4-digit, contiguous,
  never edited once applied) and are applied by `npm run migrate -w @hrforce/api` running
  as the `hrforce_migrator` role. Applied migrations are tracked in
  `public.schema_migrations(version, name, checksum, applied_at)`; a changed checksum on
  an already-applied migration is a hard error, not a silent re-apply.
- The database has exactly two roles: `hrforce_migrator` (owns schema, runs DDL) and
  `hrforce_app` (DML only, subject to RLS, `NOBYPASSRLS`, not the table owner). The app
  never runs DDL and the migrator is never used for request traffic.
- `src/platform/db/schema.ts` holds the hand-checked (or generated-then-committed) Kysely
  `DB` interface. A guardrail regenerates the interface from a freshly migrated database
  and diffs it against the committed file, so schema drift fails CI instead of surfacing
  as a runtime type mismatch.
- All queries go through Kysely's builder or its `sql` tagged template for the rare
  fragment that needs raw SQL syntax (e.g. `current_setting`). **`sql.raw` is banned by
  lint** (oxlint custom rule) because it accepts unparameterized strings and defeats the
  builder's compile-time column checking — every raw fragment must be a `sql` tagged
  template with real parameters.
- Application code targets Postgres 18 but must also run on Postgres 16: no PG18-only
  features such as `uuidv7()`. UUIDv7 values are generated in the app layer (or
  `gen_random_uuid()` is used) rather than relying on a PG18 builtin.
- Repositories obtain the Kysely instance bound to the current request's transaction
  from `RequestContext` (an `AsyncLocalStorage`), never the root pool directly — this is
  what lets `set_config('app.company_id', …)` (RLS) and audit-trigger context survive for
  the whole request.

## Consequences

**Positive**
- Query builder output is plain parameterized SQL: what Kysely sends is what the RLS
  policies and audit triggers see, with no ORM-level identity map, lazy loading, or
  cascade behavior to reason about.
- Plain-SQL migrations are reviewable as SQL diffs, work identically for both Postgres
  16 and 18, and don't depend on an ORM's schema-diffing algorithm getting the DDL right.
- Two DB roles is straightforward to express because there's no ORM assuming one
  connection role for both schema and data access.
- `domain/` stays framework-free: Kysely lives only in `infra/`, matching the
  dependency-cruiser boundary rule that `domain/**` must not import `kysely`.

**Negative**
- No auto-generated migrations from entity changes; every schema change is a hand-written
  SQL file, which is more upfront work per change than an ORM's `generate` command.
- `schema.ts` can drift from the real schema if the guardrail is skipped locally; CI is
  the actual enforcement point, not the developer's editor.
- Kysely has a smaller ecosystem than TypeORM (no built-in decorators, no
  relations/eager-loading sugar), so patterns like soft-delete or timestamps are
  hand-rolled helpers rather than framework features.

## Alternatives considered

- **TypeORM** (legacy doc's choice): decorator-based entities, migration generation,
  relation/cascade management. Rejected: encourages raw SQL escape hatches
  (`query()`/`createQueryBuilder().where(raw)`) that are hard to lint away, its migration
  generator is unreliable across Postgres versions, and the entity/decorator layer wants
  to live in `domain/`, conflicting with the boundary rule that `domain/` has no
  framework imports.
- **MikroORM**: better unit-of-work semantics than TypeORM and identity-map-based change
  tracking. Rejected for the same core reason as TypeORM — an ORM's entity graph is a
  bigger abstraction than a thin API needs, and its migration story is still
  diff-generation rather than reviewable SQL.
- **Drizzle**: closest alternative to Kysely (also a SQL builder, also supports
  SQL-first migrations). Rejected in favor of Kysely on maturity of its TypeScript
  inference for complex joins/CTEs at the time of this decision, and to avoid drift
  between Drizzle's own migration tool and our forward-only, checksum-tracked SQL files;
  re-evaluating in a later phase is not precluded by this ADR.

## Supersedes

Replaces "10-BACKEND-REDESIGN.md" §5 in full: TypeORM entities, its migration-generation
workflow, and any decorator-based repository pattern described there are replaced by
Kysely, the `infra/` repository pattern, and the plain-SQL migration process above.
