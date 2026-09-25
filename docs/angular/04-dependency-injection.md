# 4. Dependency injection

See also: [01-mental-model.md](./01-mental-model.md)'s Angular/React/NestJS table,
[07-forms.md](./07-forms.md) for `NG_VALUE_ACCESSOR` in full context.

## `inject()` and `providedIn: 'root'`

```ts
// src/app/core/org/org-api.ts
@Injectable({ providedIn: 'root' })
export class OrgApi {
  private readonly http = inject(HttpClient);
  ...
}
```

`@Injectable({ providedIn: 'root' })` registers exactly **one** instance of `OrgApi`
with the application's root injector. Nothing lists it in `app.config.ts`'s
`providers`; the first `inject(OrgApi)` anywhere creates it (lazily), and if nothing
ever injects it, the bundler can tree-shake the class out entirely — "provided in
root" is a hint to both the injector and the bundler.

`inject(HttpClient)` asks the injector for the app's configured `HttpClient` — the one
built by `provideHttpClient(withFetch(), withXsrfConfiguration(...),
withInterceptors([apiProblemInterceptor]))` in `app.config.ts`. `inject()` is a
function, not a decorator, but it only works inside an **injection context**: a
constructor, a field initializer of a class DI itself is constructing, or (as chapter
09 shows) inside `TestBed.runInInjectionContext(...)`. Field initializers
(`private readonly http = inject(HttpClient);`) are the current idiomatic style —
equivalent to old-style constructor-parameter injection
(`constructor(private http: HttpClient) {}`) but requires no constructor boilerplate.

`organization.page.ts` shows several `inject()` calls in one component:

```ts
private readonly api = inject(OrgApi);
private readonly router = inject(Router);
private readonly route = inject(ActivatedRoute);
```

Each is resolved independently by walking the injector tree (below) until a provider
is found.

A root service is also the natural home for **state shared by the whole app**.
`KindCatalog` (`src/app/core/org/kind-catalog.ts`) is injected by the org page, every
tree row, the forms and the picker — all get the same instance, so the kind catalogue
it holds is fetched once (chapter 06, "Reference data: fetch once per app"). Its field
initializer `inject(OrgApi).kindsResource()` runs in the root injector's injection
context, which is why it may create an `httpResource` there.

## The injector tree, and hierarchical injection

Angular does not have one global registry — it has a **tree** of injectors, roughly
matching the component tree:

- the **root injector**, built once from `appConfig.providers` in `app.config.ts` and
  every `providedIn: 'root'` service,
- and one **element injector per component that provides something**, nested inside
  its ancestors' injectors.

A call to `inject(Token)` starts at the requesting component's own injector and walks
*up* toward the root, returning the first provider it finds. This is what makes
`OrgApi`, provided at root, reachable from anywhere — but it also means a component
*lower* in the tree can `inject()` something provided higher up, including an
**ancestor component instance itself**:

```ts
// src/app/features/organization/org-tree.ts
export class OrgTreeItem {
  /** Resolved from the nearest ancestor `<app-org-tree>` (see header: hierarchical DI). */
  protected readonly tree = inject(OrgTree);
  readonly node = input.required<OrgTreeNode>();
  ...
}
```

Every component instance is automatically available for injection *within its own
template's subtree* (Angular adds it to that portion of the injector tree implicitly).
`<app-org-tree>` renders `<app-org-tree-item>`, which — however deeply nested through
recursive `<app-org-tree-item>` children — can `inject(OrgTree)` and reach the single
`OrgTree` instance that is its ancestor, sharing its `selectedId`/`collapsed` state
directly. This avoids threading a `selected` input and a `select` output through every
recursion level; each item talks straight to the tree-wide state.

This is genuinely hierarchical — a deeply nested `OrgTreeItem` under a *different*
`<app-org-tree>` on the same page would get *that* `OrgTree` instance, not some other
one, because each walks up its own branch of the injector tree.

## `InjectionToken` and multi providers: `NG_VALUE_ACCESSOR`

Not every dependency is a class. `NG_VALUE_ACCESSOR` (from `@angular/forms`) is an
`InjectionToken` — a typed, unique key an injector can hold a provider for, used when
there's no natural class to key off (an interface, a primitive value, or — as here — a
slot multiple things can register into):

```ts
// src/app/shared/org-unit-picker/org-unit-picker.ts
@Component({
  ...
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => OrgUnitPicker), multi: true }],
})
export class OrgUnitPicker implements ControlValueAccessor { ... }
```

- **`providers: [...]`** on `@Component` registers a provider scoped to *this*
  component's own element injector — narrower than `providedIn: 'root'`.
- **`useExisting: forwardRef(() => OrgUnitPicker)`** says "when something asks for
  `NG_VALUE_ACCESSOR` here, give it the existing `OrgUnitPicker` instance" (not a new
  object) — this is how `formControlName="parentId"` on `<app-org-unit-picker>` finds
  its `ControlValueAccessor`: Angular's forms machinery injects `NG_VALUE_ACCESSOR` from
  the same element and calls `writeValue()`/`registerOnChange()` on whatever comes back.
- **`forwardRef(() => OrgUnitPicker)`** exists because the class `OrgUnitPicker` is
  referenced *inside its own* `@Component` decorator, before the class declaration has
  finished evaluating — `forwardRef` defers resolving the reference until it's needed.
- **`multi: true`** — `NG_VALUE_ACCESSOR` is a token multiple providers can contribute
  to (Angular ships several built-in accessors for native `<input>`, `<select>`, etc.);
  `multi: true` means "add me to the list," not "replace whatever's there." (This app
  only ever has one accessor per host element in practice, but the token is declared
  `multi` by the Forms API itself, so any provider for it must say so too.)

Chapter 07 covers the rest of `ControlValueAccessor` (`writeValue`, `registerOnChange`,
`registerOnTouched`, `setDisabledState`) — this chapter is only about how DI wires the
component into that slot in the first place.

## Parallel: NestJS DI in `apps/api`

`apps/api` (NestJS) is deliberately modelled on the same ideas, so the vocabulary
transfers:

```ts
// apps/api/src/app.module.ts
@Module({
  imports: [PlatformModule, OrganizationModule],
})
export class AppModule {}
```

```ts
// apps/api/src/modules/organization/application/org-units.service.ts (shape)
@Injectable()
export class OrgUnitsService {
  constructor(private readonly repo: OrgUnitRepository) {}
  ...
}
```

| Angular | NestJS | Same idea |
|---|---|---|
| `@Injectable({ providedIn: 'root' })` | `@Injectable()` + listed in a `@Module`'s `providers` | "this class is a DI-managed singleton" |
| `inject(Token)` / constructor injection | constructor injection (Nest only supports this form) | ask the injector, don't `new` it yourself |
| root injector + per-component injectors | root module injector + per-module providers | a tree/graph of scopes, not one global bag |
| `InjectionToken` | a string/symbol token with `@Inject(TOKEN)` | a key for a non-class dependency |
| `providers: [...]` on `@Component` | `providers: [...]` on `@Module` | where a provider is registered controls who can see it |
| hierarchical DI (ancestor component injection) | module-scoped providers, re-exported via `index.ts` (`CONVENTIONS.md` rule 2) | visibility follows structure, not import paths |

The biggest structural difference: Angular's injector tree mirrors the **rendered
component tree** (so `OrgTreeItem` can reach its literal ancestor `OrgTree` instance,
something with no NestJS equivalent), while NestJS's is a static **module graph**
resolved once at boot (`apps/api/src/modules/<name>/index.ts` is the only file another
module may import from — see `CONVENTIONS.md` "Module layout and boundaries"). Angular
DI is per-request-render-tree in spirit; NestJS DI is per-application-graph.

## Next

[05-routing.md](./05-routing.md) — how the router decides which component to create,
and how it feeds that component's inputs.
