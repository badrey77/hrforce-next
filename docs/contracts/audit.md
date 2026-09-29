# Contract — Audit slice (M1, step 5)

Binding contract between `apps/api` (Audit module), `apps/web` (history views) and `tools/guardrails` (audit coverage).
Plan exit criterion: **every write produces an audit row with before and after values.** ADR 005: both DB triggers (data changes) and application events; append-only; partitioned monthly; sensitive fields masked.

## Data (migration 0009, schema `audit`)

| Table | Purpose | Columns |
|---|---|---|
| `audit.change_log` | one row per row-level change, written **only by trigger** | `id bigint generated always as identity`, `company_id uuid`, `at timestamptz default now()`, `table_name text`, `row_id uuid`, `op` (`insert`/`update`/`delete`), `actor_user_id uuid null` (from `app.user_id`), `request_id text null` (from `app.request_id`), `before jsonb null`, `after jsonb null`, `changed text[]` (column names that changed; all columns on insert/delete) |
| `audit.event` | application events that aren't a row change | `id bigint identity`, `company_id uuid null`, `at`, `actor_user_id uuid null`, `request_id text null`, `type text`, `subject_type text null`, `subject_id uuid null`, `data jsonb` |
| `audit.masked_column` | columns whose values are masked in `before`/`after` | `table_name`, `column_name`, pk both. Seed: none yet (employee salary/bank/NSS/medical columns will be added by the Employment migration); the mechanism must be tested with a fixture table |

- Both log tables are **partitioned by month on `at`** (`PARTITION BY RANGE`), with a `DEFAULT` partition as a safety net and a function `audit.ensure_partitions(months_ahead int)` that the migration calls for the current month + 12 ahead (the M2 worker will call it monthly — note it in the README).
- **Append-only:** `hrforce_app` has **no** INSERT/UPDATE/DELETE on `audit.*`. The trigger function `audit.capture()` is `SECURITY DEFINER` (owner migrator, pinned `search_path`). App events are written through `audit.record_event(type, subject_type, subject_id, data)` (definer; it takes `company_id`, actor and request id from the session settings, never from arguments). Nobody but the migrator can alter or delete rows; a `BEFORE UPDATE OR DELETE` trigger on both tables raises even for the owner unless `audit.allow_purge` is set (for the future retention job).
- **Reads:** `SELECT` for `hrforce_app` on both tables with RLS + FORCE and the standard `company_id` policy (events with `company_id` null — e.g. failed logins for unknown emails — are invisible to the app). Indexes: (`company_id`, `table_name`, `row_id`, `at desc`), (`company_id`, `subject_type`, `subject_id`, `at desc`).
- **Masking:** for a masked column, `before`/`after` hold the string `"***"` instead of the value, but the column still appears in `changed`.
- **Diff:** on `update`, `before`/`after` contain only the changed columns (plus `id`); an update that changes nothing writes no row.

## Coverage (trigger attached)

Every **tenant table** (has `company_id`) in `public` gets `audit.capture()` as an `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` trigger, **except** those listed with a reason in `tools/guardrails/audit-exempt.json` — expected: `org_unit_closure` (derived from versions, rebuilt wholesale). Current tables: `company`, `org_unit`, `org_unit_version`, `site`, `role`, `role_permission`, `role_grant` (+ `org_unit_closure` exempt).
`company` has no `company_id` column: the trigger uses `id` as `company_id` for that table.

**Guardrail change:** `guard:db` audit check becomes: every table in `public` with a `company_id` column (and `company`) has an `audit%` trigger, unless exempt; stale exemptions fail. The `-- @audited` marker rule is retired (update CONVENTIONS.md and the guard's tests).

## Application events

| Type | Written by | Subject | Data |
|---|---|---|---|
| `auth.login` | Identity, successful login | user | `{ip, userAgent}` |
| `auth.logout` | Identity | user | `{}` |
| `auth.password_set` | Identity, setup/reset consumed | user | `{purpose}` |
| `auth.session_reuse` | Identity, refresh reuse detected | user | `{familyId}` |
| `access.grant_created` / `access.grant_ended` | Authorization (in addition to the row trigger) | user (grantee) | `{grantId, roleCode, unitId, validFrom, validTo}` |

Events are written inside the request transaction when one exists; for `/api/auth/*` (no request transaction) they are written in their own short transaction with `app.company_id` set to the user's active company.

## Permission

New catalogue code `audit.read` (group `access`, labels fr/ar/en), added by the migration to the system roles `admin_rh_central` and `admin_acces` in every company. Scope: an entry is visible if its subject is in the caller's `audit.read` scope — org units/versions by unit, grants by the grant's unit, users (events and grants) if any of the user's grants is in scope or the user has none; an `access.grant_*` event is shown only if its `unitId` is in scope (same filter as the grant rows), roles/sites/company company-wide (needs `audit.read` anywhere).

## Endpoint

`GET /api/audit/timeline?subject=<type>:<id>&before=<cursor>&limit=50` — `audit.read`.
Subject types: `org_unit` (includes its `org_unit_version` rows), `site`, `role` (includes `role_permission`), `user` (its `role_grant` rows + events about it). Out-of-scope or unknown subject → 404. Newest first, cursor pagination. Order: `at` desc, then kind (event before change), then id desc — deterministic for a given data set. `at` is the database clock at the start of the writing transaction, so the rows of one request share it, and two requests sent one after the other can appear in the other order if the database clock steps back between them (NTP / VM time sync; seen on Docker Desktop); tests compare with the stored order, not the sending order.

```ts
interface TimelineEntry {
  id: string;                         // "c:<id>" or "e:<id>"
  at: string;                         // ISO timestamp
  actor: { id: string; displayName: string } | null;   // null = system / seed / migration
  requestId: string | null;
  kind: 'change' | 'event';
  // kind = change
  table?: string; op?: 'insert' | 'update' | 'delete';
  changes?: { field: string; before: unknown; after: unknown; masked: boolean }[];
  // kind = event
  event?: { type: string; data: Record<string, unknown> };
}
// → { items: TimelineEntry[]; nextCursor: string | null }
```
Values are returned as stored (dates as strings, ids as uuids); the web resolves known ids (parent unit, site, role) to names where it already has them, otherwise shows the code/id.

## Web

- A reusable `shared/timeline/` component: newest first, grouped by day, actor + time, one line per changed field with translated field labels (`audit.fields.<table>.<column>` i18n keys; unknown fields fall back to the column name), masked values shown as "masqué / مخفي / hidden", events with a translated sentence (`audit.events.<type>`), "load more" with the cursor.
- A **History** tab in the unit detail panel (Organization), the user detail page (Access) and the role editor, visible with `audit.read`.
