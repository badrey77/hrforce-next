# ADR 003: Delivery order — vertical slices, org tree before permissions

**Status:** Accepted (approved 2026-09-25, recorded in the Phase 1 plan)
**Date:** 2026-09-24

## Context

`CLAUDE.md` currently lays out delivery as a horizontal foundation-first order (e.g.
build out identity, then organization, then employment, each as a complete module
before the next starts). Report 13 §6's P1 feature list and ADR 002's access model
change what "foundation" means here: permission checks are scoped to org units
(`includeSubUnits`, validity periods), so the org tree (closure table + versioned
`org_unit` rows) is a hard dependency of the authorization data-access layer, not an
independent module that can be built in parallel with it. A horizontal order that builds
identity and authorization before organization would need to stub or fake org scoping,
then rebuild it — the opposite of finding integration problems early.

The other constraint is proof of the full stack under real conditions: staging
deployment from CI, bilingual UI (FR default, AR/RTL) via Transloco with the `fr`/`ar`
key-parity guardrail, and audit coverage via the `-- @audited` migration marker and DB
trigger, all need to be exercised before we can trust later modules are built on solid
ground. A horizontal order defers that proof to the end, when it is most expensive to
fix.

## Decision

Deliver in **vertical slices** — each slice is a thin, complete path from Angular UI
through the API's `api/` → `application/` → `domain/`/`infra/` layers to Postgres and
back, deployed and working — rather than horizontal layers of "finish module X
entirely, then start module Y."

**Ordering within the vertical:** the **org tree is built before permissions**, because
scope resolution (ADR 002's data-access-layer filtering, `includeSubUnits` expansion) is
implemented in terms of it. Identity (login) and authorization (permission catalogue,
grants) follow, since a scoped permission check needs both a subject (identity) and a
scope source (org tree) to exist first.

**M1 (4–6 weeks, small team):** an HR user logs in; sees only the employees inside their
org scope; creates and edits employees; every change is audited; the UI is available in
FR and AR (RTL) with parity enforced by the Transloco key-parity guardrail; and the
result deploys to staging from CI on every merge. M1 is deliberately narrow — one
resource (employee), one relationship (org scope), but the entire stack, proven
end-to-end including deployment.

**M2** (after M1): leave management, the workflow engine leave approvals run on,
notifications, and MFA.

**M3** (after M2): document management and numbering, the outbox pattern, and
integration with the sister application.

This ordering is a **proposal pending approval** because it replaces an already-written
plan (`CLAUDE.md`'s horizontal order) that other agents may be actively building against;
it does not take effect until accepted.

## Consequences

**Positive**
- Org tree ships first exactly where it's actually needed — as the thing permission
  scoping is built on — instead of being retrofitted under an already-built
  authorization module.
- M1 forces every cross-cutting concern (auth cookies, RLS, audit trigger wiring, i18n
  key parity, CI deploy) to be proven on one real resource before more modules are added
  on top, catching integration problems (e.g. a missing `company_id` column, a broken
  CI deploy step) while the codebase is still small.
- A working staging deployment after M1 gives stakeholders and reviewers something to
  look at every few weeks instead of only at the end of Phase 1.
- Small, complete slices are easier to review and revert than large, half-finished
  horizontal layers.

**Negative**
- Contradicts the order already written into `CLAUDE.md`; any agent or plan that assumed
  the horizontal order needs to be told this ADR supersedes it, and this ADR is not
  final until approved.
- Early modules (organization, identity, authorization) get built to the minimum needed
  for M1's single resource, so parts of them will need revisiting once M2/M3 introduce
  requirements M1 didn't exercise (e.g. workflow-engine-driven state transitions on
  leave requests).
- A small team doing full-stack vertical slices needs people comfortable across
  Angular, NestJS, and SQL migrations; a horizontal split can be parceled out by
  specialty more easily.
- Sequencing org tree strictly before permissions means the authorization module cannot
  start in parallel with it even if capacity is available, unless it works against a
  stub — which reintroduces the rebuild risk this ADR is trying to avoid, so no stub is
  planned.

## Alternatives considered

- **Keep the horizontal order in `CLAUDE.md`** (build each module to completion,
  identity → organization → employment → …): rejected as the default because it defers
  proof of the full stack (deploy, i18n, audit) to the end, and because permission
  scoping's dependency on the org tree makes "authorization module complete" ill-defined
  before organization exists.
- **Vertical slices, but permissions before org tree** (build a flat/unscoped
  permission check first, add org scoping later): rejected — this is the "stub now,
  rebuild later" pattern ADR 002 was written to avoid; scope is not an add-on to the
  permission check, it's a required input to it.
- **Two parallel tracks** (org tree and identity/authorization built simultaneously by
  different people against an agreed interface): considered as a way to use available
  capacity, but rejected for M1 specifically — the interface between "resolve my scope"
  and "check my permission" is exactly what's least settled this early, and getting it
  wrong twice (mock, then real) costs more than sequencing for a slice this small.

## Supersedes

Replaces the horizontal foundation-first delivery order in `CLAUDE.md`. Once approved,
`CLAUDE.md`'s ordering section should be updated to point at this ADR rather than
restating an order that conflicts with it.
