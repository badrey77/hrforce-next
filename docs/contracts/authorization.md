# Contract — Authorization slice (M1, step 4)

Binding contract between `apps/api` (Authorization module) and `apps/web` (access screens, permission-aware UI).
Implements ADR 002: a permission catalogue, roles, and **role grants scoped to an org unit (optionally its sub-units) and a validity period**. Each layer has one job: the guard checks the permission exists *somewhere* for the caller; the data-access layer filters rows to the caller's *scope* for that permission; use cases enforce state rules and separation of duties. RLS on `company_id` stays the backstop.

**Assumption (open question in the plan: who sees salary, RIB, NSS, medical):** the sensitive-field permissions exist in the catalogue now; by default only `admin_rh_central` holds salary, bank and NSS, and **no seeded role holds `employee.medical.read`**. Changing that is a role edit, not a release.

## Data (migration 0008)

| Table | Kind | Columns |
|---|---|---|
| `permission` | global catalogue (exempt from `company_id`, SELECT-only for `hrforce_app`) | `code text pk` (`resource.action` or `resource.field.read`), `label_fr`, `label_ar`, `label_en`, `group_code` (`organization`/`access`/`employee`/`sensitive`), `sensitive bool`, `sort_order int` |
| `role` | tenant | `id`, `company_id`, `code` (unique per company, case-insensitive, `^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$`; system codes are lower-case), `name_fr`, `name_ar`, `name_en`, `is_system bool`, `created_at` |
| `role_permission` | tenant | `company_id`, `role_id`, `permission_code → permission`, pk (`role_id`,`permission_code`) |
| `role_grant` | tenant | `id`, `company_id`, `user_id` (uuid; no FK into `auth`), `role_id`, `org_unit_id`, `include_descendants bool default true`, `valid daterange` (`[from, to)`, open end allowed), `granted_by uuid`, `granted_at timestamptz`, `ended_by uuid null`, `ended_at timestamptz null` |

All tenant tables: RLS + FORCE + the standard policy, composite FKs with `company_id`, indexes on (`company_id`,`user_id`) and (`org_unit_id`). A grant is **never deleted**: ending it sets the upper bound of `valid` (history kept; the Audit step will also capture it).
Membership listing needs one new definer function: `auth.company_members(company_id)` → `(user_id, email, display_name, locale, status)` for members of **that** company only (the caller passes the tenant from `app.company_id`; the function must refuse any other value: compare with `current_setting('app.company_id')`).

## Catalogue (seeded by migration)

| Group | Codes |
|---|---|
| organization | `org_unit.read`, `org_unit.create`, `org_unit.update`, `site.read`, `site.create` |
| access | `access.read`, `access.grant`, `access.manage_roles` |
| employee (used from the Employment step) | `employee.read`, `employee.create`, `employee.update` |
| sensitive | `employee.salary.read`, `employee.bank.read`, `employee.nss.read`, `employee.medical.read` |

System roles seeded **per company** by `seed:dev` and by the `user:invite --company` CLI when a company has none (`is_system = true`, permissions immutable through the API):

| Role code | Permissions |
|---|---|
| `admin_rh_central` | everything except `employee.medical.read` |
| `rh_regional` | `org_unit.read`, `site.read`, `employee.read`, `employee.create`, `employee.update` |
| `lecture` | `org_unit.read`, `site.read`, `employee.read` |
| `admin_acces` | `org_unit.read`, `site.read`, `access.read`, `access.grant`, `access.manage_roles` |

Dev seed grants (valid from 2026-01-01): `rh.admin@demo.dz` → `admin_rh_central` on `DG` (+ sub-units); `rh.est@demo.dz` → `rh_regional` on `REG-EST` (+ sub-units). Add a third user `lecture.ouest@demo.dz` (Samir Belkacem, fr) → `lecture` on `REG-OUEST`, same dev password.

## Evaluation (platform + module)

- **Effective grants** of a caller = grants with `user_id = caller`, `valid @> current_date`, `ended_at` irrelevant (the range is the truth), in the caller's company.
- **Scope of a permission** = union over effective grants whose role holds it: the grant's unit, plus all descendants (via `org_unit_closure`) when `include_descendants`.
- `PermissionEvaluator.hasPermission(identity, code)` = the scope is non-empty. Loaded once per request (memoized in the request context), inside the request transaction.
- New platform API for repositories: `scopeOf(code)` → a Kysely sub-query of visible `org_unit.id`s, and `inScope(code, unitId)` → boolean. Repositories **must** filter by it; a guardrail/lint is not required yet, but the e2e matrix below proves it.
- `DEV_PERMISSIONS=allow_all` stays available (dev/test only) and, when set, makes every scope "all units of the company".

## Scope rules for existing Organization endpoints

| Endpoint | Rule |
|---|---|
| `GET /org/tree` | Nodes in `org_unit.read` scope, plus their **ancestors as context** (`inScope: false`, `_actions: []`, `site` still shown). Branches with nothing in scope are omitted. No scope at all → 403. |
| `GET /org/units` | Only units in scope. |
| `GET /org/units/:id` | Out of scope → **404**. |
| `POST /org/units` | Needs `org_unit.create` on the **parent**; else 404 if the parent is unknown or not readable, 403 `forbidden-scope` (`errors[{field:'parentId', code:'forbidden_scope'}]`) if readable but not creatable. |
| `PATCH /org/units/:id` | Needs `org_unit.update` on the unit; a move also needs `org_unit.update` on the **new parent**. |
| `_actions` | Per node from real scopes: `update` if `org_unit.update` covers it; `create_child` if `org_unit.create` covers it and its kind allows children. |
| `GET /org/sites`, `POST /org/sites` | Company-wide (sites aren't tree nodes): needs `site.read` / `site.create` anywhere. |

`OrgTreeNode` gains `inScope: boolean`.

## New endpoints (under `/api`, problem+json)

| Method + path | Permission | Result |
|---|---|---|
| `GET /me` | `@Authenticated` | adds `permissions: string[]` (codes held anywhere, sorted) and `scopes: Record<code, {unitId, includeDescendants}[]>` |
| `GET /access/permissions` | `access.read` | `{items: [{code, group, sensitive, labels:{fr,ar,en}}]}` sorted by group then sortOrder |
| `GET /access/roles` | `access.read` | `{items: [{id, code, names:{fr,ar,en}, isSystem, permissions: string[]}]}` |
| `POST /access/roles` | `access.manage_roles` | `{code, names, permissions}` → 201 role. 409 `role-code-taken`; 422 unknown permission |
| `PATCH /access/roles/:id` | `access.manage_roles` | `{names?, permissions?}`; system role → 409 `role-system-immutable` |
| `GET /access/users?q=` | `access.read` | members of the company: `{items: [{id, email, displayName, status, grants: GrantView[] (current and future only)}]}` — visible only if the member has at least one grant inside the caller's `access.read` scope **or** no grant at all (so new users can be granted) |
| `GET /access/users/:id` | `access.read` | one member, same shape as an item of `GET /access/users` (`grants`: current and future, only those in the caller's `access.read` scope) and same visibility rule; otherwise — unknown id, other company, malformed id — **404** |
| `GET /access/grants?userId=&unitId=&includeEnded=` | `access.read` | `{items: GrantView[]}`, limited to grants whose unit is in the caller's `access.read` scope |
| `POST /access/grants` | `access.grant` | `{userId, roleId, orgUnitId, includeDescendants, validFrom, validTo?}` → 201 `GrantView` |
| `POST /access/grants/:id/end` | `access.grant` | `{validTo}` (≥ validFrom, ≤ current end) → 200 `GrantView` |

```ts
interface GrantView {
  id: string; userId: string;
  role: { id: string; code: string; names: { fr: string; ar: string; en: string } };
  unit: { id: string; code: string; name: string; kind: string };
  includeDescendants: boolean;
  validFrom: string; validTo: string | null;
  grantedBy: { id: string; displayName: string } | null; grantedAt: string;
  _actions: ('end')[];
}
```

**Separation of duties (409 problems, field in `errors[]` when relevant):**
- `grant-self` — nobody grants to or ends grants of themselves.
- `grant-out-of-scope` (field `orgUnitId`) — the grant's unit must be inside the caller's `access.grant` scope; with `includeDescendants` the whole subtree is by construction inside it.
- `grant-escalation` (field `roleId`) — the caller must hold **every** permission of the role, over the grant's unit (and subtree if `includeDescendants`). This stops an `admin_acces` user from handing out `employee.salary.read`.
- `grant-user-not-member` (field `userId`), `grant-dates` (field `validTo`: a new grant needs `validTo > validFrom`; ending may set `validTo = validFrom`, which cancels a grant that hasn't started), `grant-duplicate` (field `roleId`: same user, role and unit with overlapping dates).
- Defaults: `validFrom` = today, `includeDescendants` = true. Unknown `roleId` → 422 on `roleId`.
- Role edits follow the same rule: `role-escalation` if the caller would add permissions they don't hold company-wide.

## Web

- `Session` gains `permissions` and `scopes`; `can(code)` (held anywhere) as a signal-based helper.
- A structural directive `*appCan="'access.read'"` (and/or `@if (session.can(...))`) hides nav entries and buttons; route guard `permissionGuard('access.read')` via `canMatch` with route `data`. The server stays the authority: `_actions` still drives record buttons.
- Organization page: context nodes (`inScope: false`) render muted and not selectable for edits; detail of an out-of-scope id shows "not found".
- New lazy feature `/access` with tabs:
  - **Users**: search list (name, email, status, current grants as chips). User detail: grants table (role, unit with path, sub-units yes/no, from, to, granted by) with "End" (date dialog) and "Add grant" form (role select, org-unit picker, include sub-units checkbox default on, from/to). 409 codes mapped to fields.
  - **Roles**: list; role detail with a permission checklist grouped by group, sensitive ones flagged; system roles read-only; create/edit custom roles.
- Labels for roles/permissions come from the API in the active language (same pattern as unit kinds).
