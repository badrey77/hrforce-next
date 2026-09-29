# 12. Permission-aware UI

The Authorization slice ([`docs/contracts/authorization.md`](../contracts/authorization.md))
gives every signed-in user a set of **permissions**, each valid on some **org units**. The
web uses them to *hide what the user cannot use*. This chapter covers the Angular tools
for that. The rule behind all of them: **the UI hides, the server decides.** Nothing here
is security. The API checks every request, and the web copes when the API says no.

| Question | Tool | File |
|---|---|---|
| Does the user hold `x` anywhere? | `Session.can(code)` / `Session.allows(code)` | `core/auth/session.ts` |
| Show this element only with `x` | `*appCan="'x'"` (structural directive) or `@if (session.can('x'))` | `shared/can/can.directive.ts` |
| This route exists only with `x` | `canMatch: [permissionGuard()]` + `data: { permission: 'x' }` | `core/auth/permission.guard.ts` |
| May the user act on **this record**? | the record's `_actions` from the server | `features/organization/organization.page.ts`, `features/access/user-detail.page.ts` |
| Where does `x` apply? | `Session.scopes()`, and the server's filtering | `core/auth/session.ts` |

## 1. Permissions in the session store

`GET /api/me` now also returns `permissions` (the codes held anywhere, sorted) and
`scopes` (code → units). The `Session` store from chapter 03 exposes them as two more
`computed()` views of its single `me` signal:

```ts
// apps/web/src/app/core/auth/session.ts
readonly permissions = computed<ReadonlySet<string>>(() => new Set(this.me()?.permissions ?? []));
readonly scopes = computed<PermissionScopes>(() => this.me()?.scopes ?? {});

can(code: string): boolean {
  return this.permissions().has(code);
}

allows(code: string): Signal<boolean> {
  return computed(() => this.can(code));
}
```

`?? []` makes the store **fail closed**. A `/me` without `permissions`, for example from an
API that predates this step, means "holds nothing".

### A function that reads a signal vs a `computed()`: which re-renders when?

`can()` is a plain method, but it **reads a signal**. Angular tracks signal reads made
inside a *reactive context*: a template, a `computed()`, an `effect()`. So

```html
@if (session.can('access.read')) { … }
```

makes that template depend on `permissions`. When `permissions` changes, the template is
checked again and `can()` runs again. `permissions` is a **new `Set` every time `me` is
set**, so every template that calls `can()` is re-checked after every `load()`/`set()`,
even when the answer is the same. That costs one `Set` lookup per call, which is fine.

`allows(code)` returns a `computed()` for one code. A computed compares its new value with
the previous one (`Object.is`). If `true` stays `true`, it does **not** notify its
consumers. A component that keeps the signal as a field,

```ts
// apps/web/src/app/features/access/role-editor.page.ts
private readonly canManage = inject(Session).allows('access.manage_roles');
```

and reads `canManage()` (here inside another `computed`, `readOnly`) is only re-evaluated
when that boolean **flips**. `session.spec.ts` › "allows() notifies only when the answer
flips" proves it with an `effect()` that records `[false, true, false]` over four
`set()`/`clear()` calls.

Rules of thumb:

- In a template, `session.can('x')` is simple and cheap. Use it.
- In class code, or for a value read by several computeds, keep `allows('x')` in a
  **field**. Never write `session.allows('x')()` in a template. That builds a new
  computed on every check and gains nothing.

## 2. Directives: attribute vs structural

A **directive** is a class with a selector that attaches to elements in a template. A
component is a directive with its own template. There are two kinds:

| | Attribute directive | Structural directive |
|---|---|---|
| Changes | the element it sits on (attributes, classes, listeners, a form value) | **whether** (and how many times) a piece of template exists in the DOM |
| Examples here | `routerLinkActive`, `formControlName`, `[formGroup]` | `*transloco="let t"`, `*appCan` (and the built-in `@if`/`@for` blocks do the same job) |
| Receives | the host element (`ElementRef`), inputs | the template as a blueprint (`TemplateRef`) and an anchor (`ViewContainerRef`) |

### The `*` microsyntax is sugar for `<ng-template>`

The compiler rewrites

```html
<a *appCan="'access.manage_roles'; else readOnlyNote" class="btn" routerLink="/access/roles/new">…</a>
```

(from `features/access/roles.page.ts`) into

```html
<ng-template [appCan]="'access.manage_roles'" [appCanElse]="readOnlyNote">
  <a class="btn" routerLink="/access/roles/new">…</a>
</ng-template>
```

- The expression **before the first `;`** binds the input named like the selector
  (`appCan`).
- Each following `key expr` binds the input `appCan` + capitalised key: `else` →
  `appCanElse`. That is why the directive's input names are not free to choose.
- An `<ng-template>` renders **nothing** by itself. It is only a blueprint. The directive
  on it decides when to stamp a copy.

`*transloco="let t"` uses the other half of the microsyntax: `let t` declares a template
variable that the directive fills from its **context** object.

### `TemplateRef` + `ViewContainerRef`

```ts
// apps/web/src/app/shared/can/can.directive.ts
@Directive({ selector: '[appCan]' })
export class CanDirective {
  private readonly session = inject(Session);
  private readonly thenTemplate = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);

  readonly appCan = input.required<string>();
  readonly appCanElse = input<TemplateRef<unknown> | null>(null);

  private shown: TemplateRef<unknown> | null = null;

  constructor() {
    effect(() => {
      const wanted = this.session.can(this.appCan()) ? this.thenTemplate : this.appCanElse();
      if (wanted === this.shown) return;
      this.viewContainer.clear();
      if (wanted) this.viewContainer.createEmbeddedView(wanted);
      this.shown = wanted;
    });
  }
}
```

- `inject(TemplateRef)` in a directive that sits on an `<ng-template>` returns **that
  template**. With the `*` form, that is the element the directive was written on.
- `inject(ViewContainerRef)` returns the **anchor**, a comment node where views are
  inserted. `createEmbeddedView(template)` stamps a live copy of the template there, with
  its bindings and event listeners. `clear()` destroys it.
- The `else` template is just another `TemplateRef`, passed in as an input from a
  `#readOnlyNote` reference.

### Signal-driven re-render

The `effect()` reads three signals: the two inputs, and `permissions` (through
`session.can()`). When any of them changes, the effect runs again and swaps the view. It
remembers what it shows (`shown`), so an unchanged answer keeps the **same DOM node**.
Re-creating it would lose focus, form state and child components. `can.directive.spec.ts`
› "reacts to a permission change without re-creating an unchanged view" checks
`expect($(el, 'grant')).toBe(button)`.

This is a legitimate use of `effect()`. It pushes signal state into something that is not
a signal (the DOM through `ViewContainerRef`). Chapter 03 explains why effects are **not**
for deriving state.

### `*appCan` or `@if (session.can(…))`?

Both re-render at the same moments. Pick the one that reads best:

| Place | Choice | Why |
|---|---|---|
| Sites tab, `features/organization/org-nav.ts` | `*appCan="'site.read'"` | one element, one permission; the nav component needs no `Session` |
| "Attribuer un rôle", `features/access/user-detail.page.html` | `*appCan="'access.grant'"` | a one-off button |
| "Nouveau rôle" / read-only note, `features/access/roles.page.ts` | `*appCan="…; else readOnlyNote"` | shows the `else` template |
| Shell nav, `app.ts` | a `computed()` filter over link data | the rule sits next to each link's data (`permission: 'access.read'`), and the template stays one plain `@for` |
| Conditions that mix a permission with other state | `@if (session.can('x') && other())` | a directive takes one input; `@if` takes any expression |

## 3. Route guards with `data`: `permissionGuard`

```ts
// apps/web/src/app/core/auth/permission.guard.ts
export function permissionGuard(code?: PermissionRequirement): CanMatchFn {
  return (route) => {
    const fromData: unknown = route.data?.[PERMISSION_DATA_KEY];
    const required = code ?? (isRequirement(fromData) ? fromData : undefined);
    if (required === undefined) return false;
    const session = inject(Session);
    return typeof required === 'string' ? session.can(required) : required.some((c) => session.can(c));
  };
}
```

- **A guard factory.** `permissionGuard('x')` runs **once**, when the routes file is
  evaluated, and returns the actual `CanMatchFn`. The returned function closes over
  `code`.
- **Or read route `data`.** `canMatch` receives the `Route` config object, so
  `route.data` is the `data: {…}` written next to it:

  ```ts
  // apps/web/src/app/app.routes.ts
  {
    path: 'access',
    canMatch: [authGuard, permissionGuard()],
    data: { permission: 'access.read' },
    loadChildren: () => import('./features/access/access.routes').then((m) => m.ACCESS_ROUTES),
  },
  ```

  `data` keeps the requirement visible in the route table, where other code could read
  it too. The argument form is shorter for a one-off sub-route
  (`features/organization/organization.routes.ts`: `canMatch: [permissionGuard('site.read')]`).
  Neither given → deny. A typo must not open a route.
- **"Any of" for a feature parent.** `PermissionRequirement` is `string | readonly string[]`;
  an array means "at least one of these". Leave and Documents need a different permission
  per page (list `leave.read`, settings `leave.configure`), so their parent route asks for
  any of them and each child checks its own:

  ```ts
  // apps/web/src/app/app.routes.ts
  {
    path: 'leave',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: ['leave.read', 'leave.configure'] },
    loadChildren: () => import('./features/leave/leave.routes').then((m) => m.LEAVE_ROUTES),
  },
  ```

  A user with none of them never downloads the chunk. A user with `leave.configure` only
  who opens `/leave` gets past the parent, and the child table's last entry,
  `NOT_FOUND_ROUTE`, shows the 404 page (chapter 05, "The not-found route", explains why
  the app-level `**` alone would have left a blank page). An empty array denies.
- **Several `canMatch` guards.** The router runs them all and takes the **first
  non-`true` result in array order** (`prioritizedGuardValue` in
  `node_modules/@angular/router/fesm2022/_router-chunk.mjs`). So with
  `[authGuard, permissionGuard()]`, a signed-out visitor gets `authGuard`'s /login
  redirect and not this guard's `false`.
- **Why `false` here, when `authGuard` never returns `false` (chapter 05).** A `false` from
  `canMatch` means "this route does not match, try the next one", and the router ends on
  `**`, the 404 page. For "signed out", a redirect to /login fixes the problem. For
  "signed in, not allowed", no other page can fix it, and ADR 002 already answers
  out-of-scope ids with 404. So the route simply does not exist for that user, and its
  lazy chunk is never downloaded (`permission.guard.spec.ts` checks the `loadChildren`
  spy).
- A side effect worth knowing: `features/access/access.routes.ts` lists `roles/new`
  (guarded by `access.manage_roles`) **before** `roles/:id`. Without the permission,
  `roles/new` does not match and the router tries the next entry — the "try the next
  route" semantics at work. Left alone, that next entry would be `roles/:id` with
  `id = 'new'` (the editor would say "Rôle introuvable" after asking the API). So the
  table puts `{ ...NOT_FOUND_ROUTE, path: 'roles/new' }` right after the guarded entry:
  every refused URL shows the same 404 page. Employees (`new`) and Documents (`new`,
  `settings`) do the same.
- A guard runs **once per navigation**. If permissions change while a page is open, the
  guard does not run again. The page's `*appCan`/`@if` keep the visible UI in sync.

## 4. The server's `_actions` stay the authority for records

`can('org_unit.update')` answers "held **anywhere**". An `rh_regional` on `REG-EST`
holds `org_unit.update`, but not on `DEP-FIN`. So **record buttons never use
`Session.can()`**. They use the per-record `_actions` the API computed from real scopes:

```ts
// apps/web/src/app/features/organization/organization.page.ts
// A context node (outside the caller's scope) is never actionable, whatever it carries.
if (node?.inScope === false) return [];
// oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
if (node) return node._actions;
```

```ts
// apps/web/src/app/features/access/user-detail.page.ts
protected canEnd(grant: GrantView): boolean {
  // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
  return grant._actions.includes('end') && grantState(grant, this.today) !== 'ended';
}
```

Scopes also shape **data**, not only buttons. `GET /org/tree` returns the caller's units
plus their ancestors as **context** (`inScope: false`). `features/organization/org-tree.ts`
renders those rows muted, with a `[disabled]` button, so they cannot be selected, and
adds a visually hidden hint for screen readers. A detail that answers 404 reads
"Unité introuvable", never "forbidden" (`detailErrorKey` in `organization.page.ts`).

The same rule applies to a whole record the caller may not see. `GET /access/users/:id`
answers **404** for a member outside the caller's `access.read` scope, exactly as for an
unknown id. The page reads it through a resource keyed on the route param:

```ts
// apps/web/src/app/core/access/access-api.ts
userResource(id: () => string | undefined): HttpResourceRef<AccessUser | undefined> {
  return httpResource<AccessUser>(() => {
    const userId = id();
    return userId ? `${ACCESS_API_BASE}/users/${encodeURIComponent(userId)}` : undefined;
  });
}
```

`user-detail.page.ts` turns that 404 into "Utilisateur introuvable", never "forbidden",
and offers a retry only for other errors. The first version picked the member out of
`GET /access/users`. The server now owns that visibility decision in one place, so the
web no longer re-derives it.

Permission errors that concern **one field** land on that field, even when the status is
403. `POST`/`PATCH /org/units` answer `403 forbidden-scope` with
`errors[{field:'parentId'}]` when the parent is readable but not creatable/movable-into.
`features/organization/org-forms.ts` routes that slug through the same path as a 409.
The move form shows it on its parent picker. The create form, whose parent is fixed,
shows it as a form message. Any other 403 stays the generic "forbidden".

When the UI and the server disagree anyway (a stale page, a race), the server answers
with a 409 slug, and the forms map it (chapter 07,
[`core/http/problem-form.ts`](../../apps/web/src/app/core/http/problem-form.ts)).

## 5. Testing permission-aware UI

- **Fixtures.** `src/testing/auth-fixtures.ts` has `ME_FIXTURE` (the admin: everything
  except medical), `ME_LECTURE` (`lecture.ouest@demo.dz`: read-only on REG-OUEST) and
  `meWith([...codes])`. Set them with `TestBed.inject(Session).set(...)`.
- **Directive.** Use a small host component. Switch the session and check the DOM
  after `fixture.whenStable()` (`shared/can/can.directive.spec.ts`).
- **Guard.** Use `RouterTestingHarness` with stub routes, a `**` stub, and a
  `loadChildren` spy (`core/auth/permission.guard.spec.ts`).
- **Nav.** Look at the `href`s of `nav a` for each fixture (`app.spec.ts` ›
  "permission-aware nav").

## Next

Back to [10-project-structure-and-recipes.md](./10-project-structure-and-recipes.md) for
the recipes "hide a button by permission" and "add an admin page".
Then [13-pipes-defer-and-lists.md](./13-pipes-defer-and-lists.md): the History tab, shown
only with `audit.read`, uses the same `Session.allows()` pattern.
