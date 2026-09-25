# Architecture Decision Records

MADR-style records for HRForce Next Phase 1. Each ADR replaces the matching section of
the legacy "10-BACKEND-REDESIGN.md" design doc, which assumed an in-place upgrade of the
legacy app rather than a rewrite on a new database — the root issue flagged by all five
Phase 1 reviewers (security, domain model, data/platform, frontend, delivery). See
Report 13 §6 for the full P1 feature list these ADRs support.

| # | Title | Status | Supersedes |
|---|-------|--------|------------|
| [001](./001-data-access.md) | Data access — Kysely with plain-SQL forward-only migrations | Accepted | 10-BACKEND-REDESIGN.md §5 (TypeORM) |
| [002](./002-access-model.md) | Access model — scoped permission grants with RLS backstop | Accepted | 10-BACKEND-REDESIGN.md §4 (one role per user) |
| [003](./003-delivery-order.md) | Delivery order — vertical slices, org tree before permissions | Accepted | CLAUDE.md's horizontal foundation-first order |
| [004](./004-browser-auth.md) | Browser auth — httpOnly cookies for both tokens, plus XSRF | Accepted | Report 13: "Not covered today" |
| [005](./005-infrastructure.md) | Infrastructure — Postgres only in P1 | Accepted | 10-BACKEND-REDESIGN.md §2, §6 (Redis, BullMQ, four apps) |

## How these fit together

- **001** and **005** are the platform layer: how data is accessed and what
  infrastructure exists to run on. Both keep P1 to Postgres alone — no ORM magic, no
  Redis/broker.
- **002** is the authorization model that every module's `@RequirePermission()` guard,
  repository scope filter, and use-case rule ultimately implement.
- **003** sequences delivery so that 002's dependency on an org tree is respected (org
  tree before permissions) and so the full stack — including 001, 004, and 005 — is
  proven end-to-end in M1 before later modules are added. It is the only ADR here still
  pending approval, since it changes an already-written plan.
- **004** is the concrete browser-side implementation of 002's guard-checked, scoped
  access: how a session is established and kept, on top of the RLS/audit
  transaction context that 001 and 005 set up per request.

## Format

Each ADR follows MADR conventions: Title, Status, Date, Context, Decision, Consequences
(positive/negative), Alternatives considered, and Supersedes. Status is `Accepted` unless
noted otherwise in the table above.
