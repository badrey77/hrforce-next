# Contract — Organization slice (M1, step 2)

Binding contract between `apps/api` (Organization module) and `apps/web` (organization screens + org-unit picker).
Both sides are built in parallel against this file. Change it only with both sides updated.

Plan references: ADR 002 (closure table + versioned units, geographic axis first), ADR 003 (org tree before permissions).
**Assumption** (open question in the Phase 1 plan): the first axis is company → region → site, and a region is a real unit.

## Model

| Concept | Rule |
|---|---|
| Unit kinds | `company` (root, exactly one per company), `region`, `site` |
| Parent rules | `region` → parent is the `company` unit; `site` → parent is a `region` |
| Axis | `geo` only (column exists so a `department` axis can be added later) |
| Versions | Name and parent are date-effective. A unit has 1..n versions with non-overlapping `valid` daterange (`[from, to)`, `to` null = open). |
| Closure | `org_unit_closure(company_id, ancestor_id, descendant_id, depth)` reflects the tree **as of today**, including self rows (depth 0). Maintained in the same transaction as every structural change. Used for scope checks ("unit X and its sub-units"). |
| Code | Unique per company, `^[A-Z0-9][A-Z0-9_-]{1,31}$`, immutable after creation. |

## Endpoints (all under `/api`, JSON, errors are problem+json)

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /org/tree?asOf=YYYY-MM-DD` | `org_unit.read` | Whole tree as of a date (default today) |
| `GET /org/units?q=&kind=&asOf=` | `org_unit.read` | Flat search for the picker (q matches code or name, case/accent-insensitive; max 50) |
| `GET /org/units/:id` | `org_unit.read` | One unit with its version history |
| `POST /org/units` | `org_unit.create` | Create a region or site |
| `PATCH /org/units/:id` | `org_unit.update` | New version from `validFrom`: rename and/or move |

Unknown or other-tenant ids → **404**. Invalid body → **422** with `errors[{field, code, message}]` where `field` is the body property name (`name`, `parentId`, `code`, `kind`, `validFrom`).
Business-rule violations → **409** problem with `type: urn:hrforce:problem:<slug>` and, when tied to a field, the same `errors[]` shape. Slugs: `org-unit-code-taken`, `org-unit-invalid-parent`, `org-unit-cycle`, `org-unit-version-overlap`, `org-unit-root-immutable`.

### Shapes

```ts
type OrgUnitKind = 'company' | 'region' | 'site';
type OrgAction = 'update' | 'create_child';

interface OrgTreeNode {
  id: string; kind: OrgUnitKind; code: string; name: string;
  children: OrgTreeNode[];          // sorted by code
  _actions: OrgAction[];            // what the caller may do on this unit
}
// GET /org/tree → { asOf: string; root: OrgTreeNode }

interface OrgUnitSummary {
  id: string; kind: OrgUnitKind; code: string; name: string;
  path: { id: string; name: string }[];   // ancestors from company root down to the parent (excludes self)
}
// GET /org/units → { items: OrgUnitSummary[] }

interface OrgUnitVersion { validFrom: string; validTo: string | null; name: string; parentId: string | null; }
interface OrgUnitDetail extends OrgUnitSummary {
  createdAt: string;
  versions: OrgUnitVersion[];       // newest first
  _actions: OrgAction[];
}
// GET /org/units/:id → OrgUnitDetail

// POST /org/units  body:
interface CreateOrgUnit { kind: 'region' | 'site'; code: string; name: string; parentId: string; validFrom?: string } // default today
// → 201 OrgUnitDetail, Location header

// PATCH /org/units/:id body (at least one of name/parentId):
interface ChangeOrgUnit { name?: string; parentId?: string; validFrom?: string }
// → 200 OrgUnitDetail
```

Names: 1–120 chars, trimmed. Dates: ISO `YYYY-MM-DD`.

## Development identity (until the Identity module exists)

- `DEV_AUTH=true` is accepted **only** when `NODE_ENV` is `development` or `test`; the env schema rejects it otherwise (boot fails).
- With it on, the API reads `X-Dev-User-Id` and `X-Dev-Company-Id` headers as the identity, and a dev permission evaluator grants every permission.
- `npm run seed:dev -w @hrforce/api` creates the demo company with fixed ids:
  - company id `0190a5d0-0000-7000-8000-000000000001`, dev user id `0190a5d0-0000-7000-8000-0000000000aa`
  - `GROUPE` Groupe Démo → regions `CENTRE` Région Centre, `EST` Région Est, `OUEST` Région Ouest →
    sites `ALG-HQ` Alger – Siège, `BLIDA` Blida (Centre); `CNE` Constantine, `ANNABA` Annaba (Est); `ORAN` Oran, `TLEMCEN` Tlemcen (Ouest).
- The web dev proxy (`apps/web/proxy.conf.json`) injects both headers, so the browser code never knows about them.
