# Contract — Organization slice (M1, step 2) — v2

Binding contract between `apps/api` (Organization module) and `apps/web` (organization screens + org-unit picker).
Both sides are built in parallel against this file. Change it only with both sides updated.

Plan references: ADR 002 (closure table + versioned units), ADR 003 (org tree before permissions).

**v2 (2026-09-25) — org model confirmed by the business:** one management tree; sites are places that host units.
v1 (company → region → site) is superseded.

```
Direction Générale                         (root, one per company)
 ├─ Département RH ─ Service Paie           services can hang under a department,
 ├─ Département Finances ─ Service Compta   a region or an agency
 └─ Département RX                          (network department; exists only at DG level)
     ├─ Région Est ─ Service Admin Est      a region only groups agencies (+ its own services),
     │   ├─ Agence Annaba ─ Service Clientèle   it has no departments
     │   └─ Agence Constantine
     └─ Région Ouest ─ Agence Oran
```

## Model

| Concept | Rule |
|---|---|
| Unit kinds | Data, not code: table `org_unit_kind` (global reference catalogue, exempt from `company_id`): `code`, `label_fr`, `label_ar`, `label_en`, `sort_order`, `is_root`. Seeded by migration with `direction_generale` (root), `department`, `region`, `agency`, `service`. |
| Parent rules | Data: table `org_unit_kind_parent(kind, parent_kind)`. Seeded: `department` → `direction_generale`; `region` → `department`; `agency` → `region`; `service` → `department` \| `region` \| `agency`. The root kind has no parent; exactly one root unit per company. |
| Sites | Table `site` (tenant table: `company_id`, `code`, `name`, `wilaya`, `address` nullable, `created_at`). A site is a place, not a node of the tree. |
| Hosting | Each unit version has `site_id` (nullable). **Effective site** = own `site_id`, else the nearest ancestor's (so a service is at its agency's site unless set). The root must have a site. |
| Versions | Name, parent and site are date-effective. A unit has 1..n versions with non-overlapping `valid` daterange (`[from, to)`, `to` null = open). |
| Closure | `org_unit_closure(company_id, ancestor_id, descendant_id, depth)` reflects the tree **as of today**, incl. self rows (depth 0). Used for scope checks ("unit X and its sub-units"). |
| Code | Unique per company (units and sites separately), `^[A-Z0-9][A-Z0-9_-]{1,31}$`, immutable. |
| Axis | Column stays (`geo` → rename value to `management`); a second axis is not planned. |

## Endpoints (all under `/api`, JSON, errors are problem+json)

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /org/kinds` | `org_unit.read` | Kind catalogue with labels and allowed parents |
| `GET /org/tree?asOf=YYYY-MM-DD` | `org_unit.read` | Whole tree as of a date (default today) |
| `GET /org/units?q=&kind=&asOf=` | `org_unit.read` | Flat search for the picker (q matches code or name, case/accent-insensitive; `kind` may repeat: `kind=region&kind=agency`; max 50) |
| `GET /org/units/:id` | `org_unit.read` | One unit with its version history |
| `POST /org/units` | `org_unit.create` | Create a unit (any non-root kind) |
| `PATCH /org/units/:id` | `org_unit.update` | New version from `validFrom`: rename, move and/or change site |
| `GET /org/sites?q=` | `site.read` | List/search sites (max 200, sorted by code) |
| `POST /org/sites` | `site.create` | Create a site |

Unknown or other-tenant ids in the URL → **404**. Invalid body → **422** with `errors[{field, code, message}]` (`field` = body property).
Business-rule violations → **409** problem `type: urn:hrforce:problem:<slug>`, with `errors[]` when tied to a field. Slugs:
`org-unit-code-taken`, `org-unit-invalid-parent` (codes: `not_found`, `invalid_parent_kind`, `parent_not_effective`), `org-unit-cycle`,
`org-unit-version-overlap`, `org-unit-root-immutable`, `org-unit-root-site-required`, `site-code-taken`, `site-not-found` (field `siteId`).

### Shapes

```ts
type OrgUnitKind = string;                 // a code from GET /org/kinds
type OrgAction = 'update' | 'create_child';

interface OrgKind {
  code: OrgUnitKind; isRoot: boolean; sortOrder: number;
  labels: { fr: string; ar: string; en: string };
  allowedParents: OrgUnitKind[];           // empty for the root
}
// GET /org/kinds → { items: OrgKind[] }  (sorted by sortOrder)

interface SiteRef { id: string; code: string; name: string }
interface Site extends SiteRef { wilaya: string; address: string | null }
// GET /org/sites → { items: Site[] } ; POST /org/sites body { code, name, wilaya, address? } → 201 Site

interface OrgTreeNode {
  id: string; kind: OrgUnitKind; code: string; name: string;
  site: SiteRef | null;                    // effective site
  children: OrgTreeNode[];                 // sorted by kind sortOrder, then code
  _actions: OrgAction[];
}
// GET /org/tree → { asOf: string; root: OrgTreeNode }

interface OrgUnitSummary {
  id: string; kind: OrgUnitKind; code: string; name: string;
  site: SiteRef | null;                    // effective site
  path: { id: string; name: string }[];    // ancestors from root down to the parent (excludes self)
}
// GET /org/units → { items: OrgUnitSummary[] }

interface OrgUnitVersion {
  validFrom: string; validTo: string | null; name: string; parentId: string | null;
  siteId: string | null;                   // own site on that version (null = inherited)
}
interface OrgUnitDetail extends OrgUnitSummary {
  siteInherited: boolean;                  // true when `site` comes from an ancestor
  createdAt: string;
  versions: OrgUnitVersion[];              // newest first
  _actions: OrgAction[];
}

// POST /org/units
interface CreateOrgUnit { kind: OrgUnitKind; code: string; name: string; parentId: string; siteId?: string | null; validFrom?: string }
// PATCH /org/units/:id  (at least one of name/parentId/siteId; siteId null = inherit)
interface ChangeOrgUnit { name?: string; parentId?: string; siteId?: string | null; validFrom?: string }
```

`create_child` is present only when the unit's kind is an allowed parent of at least one kind. Names 1–120 chars, trimmed. Dates `YYYY-MM-DD`.

## Development identity (until the Identity module exists)

Unchanged from v1: `DEV_AUTH=true` only with `NODE_ENV` development/test; headers `X-Dev-User-Id` / `X-Dev-Company-Id`; the web dev proxy injects them.
Fixed ids: company `0190a5d0-0000-7000-8000-000000000001`, dev user `0190a5d0-0000-7000-8000-0000000000aa`.

Seed (`npm run seed:dev -w @hrforce/api`, validFrom 2026-01-01):
- Sites: `ALG-HQ` Alger – Siège (Alger), `ALG-CTR` Alger Centre (Alger), `BLIDA` Blida (Blida), `CNE` Constantine (Constantine), `ANNABA` Annaba (Annaba), `ORAN` Oran (Oran), `TLEMCEN` Tlemcen (Tlemcen).
- Tree: `DG` Direction Générale @ALG-HQ →
  `DEP-RH` Département RH → `SRV-PAIE` Service Paie, `SRV-FORM` Service Formation;
  `DEP-FIN` Département Finances → `SRV-COMPTA` Service Comptabilité;
  `DEP-RX` Département RX →
    `REG-CTR` Région Centre @BLIDA → `AG-ALG` Agence Alger Centre @ALG-CTR, `AG-BLIDA` Agence Blida @BLIDA;
    `REG-EST` Région Est @CNE → `SRV-ADM-EST` Service Administration Est, `AG-CNE` Agence Constantine @CNE, `AG-ANNABA` Agence Annaba @ANNABA → `SRV-CLI-ANB` Service Clientèle;
    `REG-OUEST` Région Ouest @ORAN → `AG-ORAN` Agence Oran @ORAN, `AG-TLEMCEN` Agence Tlemcen @TLEMCEN.
