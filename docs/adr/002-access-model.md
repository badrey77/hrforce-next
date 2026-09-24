# ADR 002: Access model — scoped permission grants with RLS backstop

**Status:** Accepted
**Date:** 2026-09-24

## Context

The legacy design doc §4 models authorization as a single role per user, appropriate for
the legacy app's flatter deployment. HRForce Next needs finer control from day one: HR
users only manage employees inside a geographic org unit (company → region → site, with
room for a department axis later), some fields (salary, bank details/RIB, NSS, medical
documents) are sensitive enough to need their own visibility rule independent of the
record's general read permission, and every module (organization, identity,
authorization, audit, employment, …) needs the same authorization primitives rather than
each reinventing scope checks. M1 (ADR 003) requires this to work end-to-end before
anything else is built, since org scope is a dependency of the permission check itself.

`CONVENTIONS.md` already fixes several contract points this ADR must satisfy: every
controller handler has `@RequirePermission('<resource>.<action>')` or `@Public()`
(enforced by the `route-scan` guardrail); permission codes are lowercase
`resource.action`; out-of-scope ids return 404, not 403; every business table has
`company_id` and `FORCE ROW LEVEL SECURITY` with policy
`using (company_id = current_setting('app.company_id', true)::uuid)`; and the request
transaction sets `app.company_id` / `app.user_id` / `app.request_id` via
`set_config(...)` before any repository query runs.

## Decision

**Permissions.** A fixed catalogue of permissions named `resource.action`
(e.g. `employee.read`, `employee.update`, `employee.salary.read`). A permission is a
capability, not a scope — it says what a user may do, never where.

**Role grants.** A role bundles permissions. A grant assigns a role to a user **scoped
to an org unit**, optionally `includeSubUnits: true` to cover that unit's descendants,
and optionally a **validity period** (`validFrom`/`validUntil`) for temporary or
time-boxed assignments (e.g. an interim manager). A user can hold multiple grants
(different roles, different org units, overlapping or not); effective permissions at a
given org unit are the union of all grants whose scope covers that unit and whose
validity period covers "now".

**Three layers, one job each.**
1. **Guard** (`@RequirePermission()`, in `platform/authz/`) checks only that the caller
   holds the named permission *somewhere* — it never touches scope or row data.
2. **Data-access layer** (repositories in each module's `infra/`) filters query results
   by the caller's org-unit scope for that permission, using the closure table (ADR
   describes org tree below) to expand `includeSubUnits` grants.
3. **Use cases** (`application/`) enforce state rules and separation of duties — e.g.
   "the same user cannot both create and approve a given leave request" — which are
   business rules, not access rules, and don't belong in the guard or the repository.

**RLS backstop.** Every business table carries `company_id` and `FORCE ROW LEVEL
SECURITY`; the app DB role (`hrforce_app`) is never `BYPASSRLS` and never the table
owner. This is a backstop, not the primary scoping mechanism: the data-access layer is
still responsible for filtering by org unit within a company. RLS exists so that a
missing or wrong filter in a repository fails closed (returns nothing / errors) instead
of leaking rows across companies.

**404, not 403, for out-of-scope ids.** A record a user has the permission for but not
the scope for does not exist as far as the response is concerned — this avoids
confirming record existence to callers who shouldn't know about it.

**Field-level permissions.** Salary, bank details (RIB), NSS, and medical documents each
have their own read/write permission (e.g. `employee.salary.read`), checked in the use
case or serializer layer in addition to the record-level `employee.read` — holding
`employee.read` does not imply visibility of these fields.

**`GET /api/me`.** Returns the current user, their effective permissions (flattened
across all active grants), and their scopes (the org units, with `includeSubUnits`,
each permission is effective at). Individual records returned by the API carry an
`_actions` list — the subset of actions the caller may perform on that specific record —
so the web app never has to re-derive permission logic client-side.

**Org tree.** Modeled as a **closure table** (ancestor/descendant pairs with depth) over
**versioned `org_unit` rows** (a unit's move or rename creates a new version rather than
mutating history), rather than Postgres `ltree`. The geographic axis (company → region →
site) is built first, with the table design leaving room for an independent department
axis to be added later without a breaking change.

## Consequences

**Positive**
- The three-layer split means a bug in one layer degrades safely: a guard bug is caught
  by missing scope filtering (empty/limited results), and a scope-filtering bug is
  caught by RLS (cross-company leakage specifically is blocked at the DB).
- Scoped, time-boxed grants model real HR situations (interim coverage, project-based
  access) without new tables per scenario.
- `_actions` on records and the flattened list from `/api/me` let the web app hide/show
  UI purely from server-declared state, avoiding permission logic duplicated in Angular.
- A closure table supports "give me all units under X" and "is Y under X" as simple
  joins, which `includeSubUnits` scope expansion needs on every scoped query.
- Versioned org units give a real history of moves/renames, which audit and reporting
  need and `ltree` path rewrites would complicate.

**Negative**
- The closure table needs maintenance (insert/delete of ancestor rows) on every org unit
  move; this is more write-path complexity than `ltree`'s path-string rewrite, though it
  is far cheaper to query correctly.
- Effective-permission computation (union across possibly-overlapping, time-boxed grants)
  is more code than a single `user.role` column; `GET /api/me` must do real work, not a
  single-row lookup.
- Field-level permission checks are an extra check point per sensitive field; missing
  one in a new endpoint is a real risk the `route-scan`/review process must catch since
  no guardrail can infer "this DTO field is sensitive" automatically.
- RLS as a backstop only helps if `company_id` is genuinely present and correctly set on
  every table; tables that can't carry it need an explicit, reviewed exemption
  (`tools/guardrails/company-id-exempt.json`).

## Alternatives considered

- **Keep one role per user** (legacy §4): simplest to implement, but cannot express
  "manager of site A only" without one role per site, and cannot express time-boxed or
  overlapping access at all. Rejected as inadequate for the org-scoped M1 requirement.
- **Scope embedded in the permission code** (e.g. `employee.read.site-42`): rejected —
  it multiplies the permission catalogue by the org tree size and can't express
  `includeSubUnits` or validity periods without ad hoc string parsing.
- **RLS as the only scoping mechanism** (no separate data-access filtering layer):
  rejected — RLS with `current_setting('app.company_id')` naturally expresses
  company-level isolation but not the finer org-unit + `includeSubUnits` + validity-period
  scoping the product needs; pushing all of that into RLS policies makes them illegible
  and hard to unit test compared to a typed data-access layer.
- **`ltree` for the org tree**: attractive for "descendants of X" via a GiST index on a
  materialized path, but path rewrites on unit moves touch every descendant row, and
  representing a second (department) axis cleanly alongside the geographic one is
  awkward with a single path column. Closure table plus versioned rows was chosen
  instead.

## Supersedes

Replaces "10-BACKEND-REDESIGN.md" §4 in full: the single `role` column, and any endpoint
authorization described there as `@Roles('admin')`-style checks, are replaced by
`@RequirePermission('resource.action')` plus scoped grants as described above.
