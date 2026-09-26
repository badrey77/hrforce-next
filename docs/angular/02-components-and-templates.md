# 2. Components and templates

See also: [01-mental-model.md](./01-mental-model.md) for how a component gets created
in the first place, [03-signals-and-state.md](./03-signals-and-state.md) for what makes
a component re-render.

## Anatomy of a standalone component

```ts
// src/app/app.ts
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslocoDirective, LanguageSwitcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly navLinks: readonly NavLink[] = [ /* ... */ ];
}
```

- **`selector`** — the HTML tag this component renders as, `<app-root>`. Angular
  components always use element selectors (never attribute-only) in this codebase.
- **`imports`** — every directive, component and pipe the template uses, listed
  directly. This is what "standalone" means: no `NgModule` declares this component or
  its dependencies. Forget to list one and the compiler errors on the template, not at
  runtime.
- **`changeDetection: OnPush`** — every component in this app opts into `OnPush` (see
  chapter 03). `CONVENTIONS.md` requires it.
- **`templateUrl`/`styleUrl`** vs **`template`/`styles`** — a separate `.html`/`.css`
  file for anything non-trivial (`App`, `OrganizationPage`, `OrgUnitPicker`), inline
  strings for small, template-only components (`HomePage`, `NotFoundPage`,
  `PlaceholderPage`). Both are legitimate; pick based on size.
- **Component styles are scoped** to the component by Angular's emulated encapsulation
  — a rule in `org-unit-picker.css` never leaks out and style `.listbox` in some
  unrelated feature. See the comment at the top of that file.

## Template syntax, with real examples

### Interpolation and property/attribute/class bindings

```html
<!-- src/app/features/organization/organization.page.html -->
<input id="org-as-of" type="date" [value]="effectiveAsOf()" (change)="onAsOfChange($event)" />
```

- `{{ expression }}` — interpolation, text content only (`{{ t('org.title') }}`).
- `[prop]="expr"` — a **property** binding: sets the DOM/JS property (`value`,
  `disabled`, a component's `@Input`). `[value]="effectiveAsOf()"` sets the input
  element's `.value` property, not the HTML attribute.
- `[attr.x]="expr"` — an **attribute** binding, for things that have no DOM property
  (ARIA attributes mostly): `[attr.aria-expanded]="expanded()"` in
  `org-tree.ts`. A `null`/`undefined` value removes the attribute — used deliberately in
  `org-unit-picker.html`'s `[attr.aria-describedby]`.
- `[class.x]="expr"` — toggles one class from a boolean:
  `[class.selected]="selected()"` in `org-tree.ts`.
- `(event)="handler($event)"` — an event binding. `org-unit-picker.html` has
  `(input)="onInput($event)"`, `(keydown)="onKeydown($event)"`.

### Two-way binding with `model()`

```html
<!-- organization.page.html -->
<app-org-tree [root]="rootNode" [(selectedId)]="selectedId" />
```

`[(selectedId)]` — "banana in a box" — is sugar for
`[selectedId]="selectedId" (selectedIdChange)="selectedId.set($event)"`. It only works
because `OrgTree` declares `selectedId` with `model()` (`org-tree.ts`), which creates
both the input and its matching `…Change` output automatically. Calling
`this.selectedId.set(id)` inside `OrgTree` updates the parent's signal directly.

### Control flow: `@if`, `@for`, `@switch`, `@let`

These replaced the old `*ngIf`/`*ngFor`/`ngSwitch` structural directives; nothing in
this codebase uses the old syntax.

```html
<!-- organization.page.html -->
@if (tree.error()) {
  ...
} @else if (root(); as rootNode) {
  <app-org-tree [root]="rootNode" [(selectedId)]="selectedId" />
} @else {
  <p class="muted">{{ t('org.tree.loading') }}</p>
}
```

`@if (expr; as name)` both tests the condition and, when it's truthy, binds it to
`name` for the block — used throughout so `tree.value()` (or `feedback()`) is read
once and reused, instead of re-evaluating the signal call repeatedly.

```html
<!-- unit-detail.ts template -->
@for (version of u.versions; track $index) {
  <tr>...</tr>
} @empty {
  <tr><td colspan="4">{{ t('org.detail.none') }}</td></tr>
}
```

`@for (item of list; track expr)` — `track` is **mandatory** and tells Angular how to
match old and new list items so it can reuse/move DOM nodes instead of
destroying-and-recreating everything on each change. `track child.id` in `org-tree.ts`'s
template tracks by identity (stable across reorders); `track $index` in `unit-detail.ts`
is used deliberately where items have no id and the whole list is replaced wholesale on
reload (the comment there explains why that's safe). `@for` also exposes `$index`,
`$first`, `$last`, `$even`, `$odd`, `$count` as implicit variables (`let i = $index` in
`org-unit-picker.html`), and `@empty` renders when the list is empty.

```html
<!-- organization.page.html -->
@switch (mode()) {
  @case ('create') { <app-create-unit-form ... /> }
  @case ('change') { <app-change-unit-form ... /> }
  @default { ... }
}
```

`@switch`/`@case`/`@default` picks one block by value — used here to render exactly one
of "create form", "change form" or "view + action buttons" based on the `mode` signal.

```html
<!-- organization.page.html -->
@let unit = detail.value();
```

`@let` declares a template-local, block-scoped variable computed once per render pass
and reused below — not a signal, just a name for an expression, used throughout the
org feature (`@let code = form.controls.code;` in `create-unit-form.html`) so a
`form.controls.x` expression isn't repeated five times with five separate error-lookup
calls each.

### `ng-template` and `&ngsp;`

`<ng-template>` is a **blueprint**: it renders nothing by itself, and a directive decides
when to stamp copies of it. The `else` of the permission directive is one, named with a
template reference variable (below) and handed to the directive as an input:

```html
<!-- src/app/features/access/roles.page.ts -->
<a *appCan="'access.manage_roles'; else readOnlyNote" class="btn" routerLink="/access/roles/new">…</a>
<ng-template #readOnlyNote>
  <p class="muted" data-note="read-only">{{ t('access.roles.readOnlyNote') }}</p>
</ng-template>
```

The `*` prefix is itself shorthand for an `<ng-template>` around the element. Chapter 12
([12-permission-aware-ui.md](./12-permission-aware-ui.md)) takes that apart and shows the
directive's `TemplateRef`/`ViewContainerRef` side.

The code does **not** use `<ng-template>` for structural recursion. `org-tree.ts`'s header
comment explains why: a recursive component (`<app-org-tree-item>` referencing itself)
was chosen over `ngTemplateOutlet`, because a template-outlet context variable
(`let-node`) is untyped under `strictTemplates`, while a component `input()` is fully
checked.

`&ngsp;` is Angular's "non-collapsing space" entity. Angular strips whitespace-only text
between tags by default (for smaller output); `&ngsp;` inserts a real space where the
*accessible name* of an element depends on one, e.g. in `org-tree.ts`:

```html
<span class="badge">{{ kindCatalog.labelOf(item.kind) }}</span>&ngsp;<span class="code">{{ item.code }}</span>&ngsp;<span>{{ item.name }}</span>
```

Without it, a screen reader would announce `"RégionREG-ESTRégion Est"` instead of
`"Région REG-EST Région Est"`. (The badge text comes from the kind catalogue, not from
`t()` — see chapter 03, "Combining an app-wide cache signal with the language signal".)

### Template reference variables

`#name` on an element names it for the rest of the template. `sites.page.html` uses one
to read a search box on submit without any form library:

```html
<form class="search" role="search" (submit)="search($event, searchInput.value)">
  <input #searchInput id="sites-q" type="search" [value]="q() ?? ''" ... />
```

`searchInput` is the `HTMLInputElement` itself. Because the form has no `[formGroup]`,
Angular's forms directives leave it alone, so `search()` calls
`event.preventDefault()` to stop the browser's page reload.

### Reaching an element from the class: `viewChild()` and a native `<dialog>`

Templates normally *receive* state. Sometimes the class must call a DOM method itself,
such as `showModal()` on a `<dialog>`. A **view query** gives the class the element:

```ts
// src/app/features/access/user-detail.page.ts
private readonly endDialog = viewChild.required<ElementRef<HTMLDialogElement>>('endDialog');

protected openEnd(grant: GrantView): void {
  …
  this.endDialog().nativeElement.showModal();
}
```

```html
<!-- src/app/features/access/user-detail.page.html -->
<dialog #endDialog aria-labelledby="end-grant-title" (close)="onEndClosed()">
```

- `viewChild('endDialog')` finds the element marked `#endDialog` **in this component's own
  template**. Content projected from a parent is not searched; that would be
  `contentChild()`. For a plain element the result is an `ElementRef`, and
  `.nativeElement` is the DOM node.
- It is a **signal**: `this.endDialog()` reads the current match, and a `computed()` could
  depend on it. `viewChild.required` promises a match. The type has no `undefined`, and
  reading it before the view exists throws. Plain `viewChild()` returns
  `Signal<T | undefined>`, which suits an element inside an `@if`.
- The older decorator form, `@ViewChild('endDialog') dialog!: ElementRef`, is a plain
  property that is only set after `ngAfterViewInit`. The signal version needs no lifecycle
  hook.
- **Why a native `<dialog>`.** `showModal()` gives a real modal for free. The rest of the
  page becomes inert, focus stays inside, Escape closes it, and `::backdrop` styles the
  overlay. No overlay library, no z-index. The dialog stays in the DOM (closed), and
  `(close)` fires however it was closed (our Cancel button, Escape, `close()` after a
  save), so cleanup lives in one handler. jsdom lacks `showModal()`, so the specs install
  a tiny polyfill (`src/testing/dialog-polyfill.ts`, chapter 09).

## Inputs, outputs, and `model()`

```ts
// src/app/features/organization/org-tree.ts
export class OrgTreeItem {
  readonly node = input.required<OrgTreeNode>();
  ...
}

export class OrgTree {
  readonly root = input.required<OrgTreeNode>();
  readonly selectedId = model<string | null>(null);
}
```

- **`input()`** declares a signal-backed `@Input`, read-only from the component's own
  side (`org-tree.ts`'s `OrgTreeItem.node`, or `PlaceholderPage.titleKey` with a default
  value: `input('app.title')`).
- **`input.required<T>()`** — same, but the compiler requires the template using this
  component to bind it (`<app-org-unit-picker [kinds]="...">` — if you forget, it's a
  compile error, not `undefined` at runtime). Used for `OrgTreeItem.node`,
  `UnitDetail.unit`, `CreateUnitForm.parent`.
- **`output()`** declares an event source: `readonly saved = output<OrgUnitDetail>();`
  in `create-unit-form.ts`; `this.saved.emit(unit)` fires it, and a parent listens with
  `(saved)="onCreated($event)"`.
- **`model()`** — both at once, two-way: see `OrgTree.selectedId` above.

## Host bindings

```ts
// src/app/shared/org-unit-picker/org-unit-picker.ts
@Component({
  ...
  host: { '(focusout)': 'onFocusOut($event)' },
})
export class OrgUnitPicker { ... }
```

`host` metadata binds events (or properties/attributes/classes) directly on the
component's own host element — `<app-org-unit-picker>` itself — without needing a
wrapper `<div>` inside the template just to attach a listener.

## `OnPush` in one sentence

`ChangeDetectionStrategy.OnPush` tells Angular: only re-check this component's view
when one of its `@Input`s changes *by reference*, one of its own template's signals
changes, or an event originating inside it fires. Because every component here reads
its state through signals (`input()`, `signal()`, `computed()`), `OnPush` "just works"
without the manual `markForCheck()` calls older Angular code needed — chapter 03 goes
into why signals and `OnPush` fit together.

## Next

[03-signals-and-state.md](./03-signals-and-state.md) — signals, `computed`, `effect`,
resources, and why zoneless change detection needs all of this.
