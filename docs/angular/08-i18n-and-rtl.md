# 8. i18n and RTL

See also: [02-components-and-templates.md](./02-components-and-templates.md) for
`*transloco="let t"` as a structural directive, [10-project-structure-and-recipes.md](./10-project-structure-and-recipes.md)
for "add a translation key" step by step.

## Transloco setup

```ts
// src/app/app.config.ts
provideTransloco({
  config: {
    availableLangs: [...APP_LANGUAGES],
    defaultLang: DEFAULT_LANGUAGE,
    fallbackLang: DEFAULT_LANGUAGE,
    missingHandler: { useFallbackTranslation: true, logMissingKey: isDevMode() },
    reRenderOnLangChange: true,
    prodMode: !isDevMode(),
  },
  loader: TranslocoHttpLoader,
}),
provideAppInitializer(() => inject(LanguageService).init()),
```

[`@jsverse/transloco`](https://jsverse.github.io/transloco/) is a third-party i18n
library, not part of `@angular/*` — chosen here over Angular's own built-in i18n
(`$localize`) because Transloco supports **switching language at runtime** without a
separate build per language; Angular's built-in i18n bakes one language per build.
`APP_LANGUAGES` (`['fr', 'ar', 'en']`) and `DEFAULT_LANGUAGE` (`'fr'`) live in
`src/app/core/i18n/languages.ts`. `provideAppInitializer(() =>
inject(LanguageService).init())` runs before the app renders anything, restoring the
persisted language choice and waiting for its translation file — see `LanguageService`
below.

## Loading translation files

```ts
// src/app/core/i18n/transloco-http-loader.ts
@Injectable({ providedIn: 'root' })
export class TranslocoHttpLoader implements TranslocoLoader {
  private readonly http = inject(HttpClient);
  getTranslation(lang: string): Observable<Translation> {
    return this.http.get<Translation>(`/i18n/${encodeURIComponent(lang)}.json`);
  }
}
```

Translation files are `apps/web/public/i18n/{fr,ar,en}.json` — anything under
`public/` is served as a static asset at the site root (see `angular.json`'s
`"assets": [{ "glob": "**/*", "input": "public" }]`), so `fr.json` is fetched at
runtime as `/i18n/fr.json`. Keys are **nested** (`{"nav": {"employees": "..."}}`,
flattened to dotted paths like `nav.employees` when read).

## The `transloco` directive vs the service

Templates use the **structural directive** form almost everywhere:

```html
<ng-container *transloco="let t">
  <h1>{{ t('org.title') }}</h1>
```

`*transloco="let t"` exposes a translate function `t` to everything inside that
container; `t('org.title')` or, with interpolation values, `t('org.feedback.created', {
name: unit.name })` (used in `organization.page.html`). This is the idiomatic way to
translate inside a template — one directive at the top, then plain function calls, no
repeated pipe syntax on every string.

The **service**, `TranslocoService`, is injected directly only where translation needs
to happen *outside* a template — `LanguageService` (below) calls
`this.transloco.setActiveLang(lang)` and `this.transloco.load(lang)` from TypeScript,
not from a template.

## `LanguageService`: switching language and direction together

```ts
// src/app/core/i18n/language.service.ts
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly transloco = inject(TranslocoService);
  private readonly document = inject(DOCUMENT);
  private readonly currentLang = signal<AppLanguage>(DEFAULT_LANGUAGE);
  readonly current = this.currentLang.asReadonly();

  use(lang: AppLanguage): void {
    this.transloco.setActiveLang(lang);
    const root = this.document.documentElement;
    root.lang = lang;
    root.dir = directionOf(lang);
    this.currentLang.set(lang);
    this.persist(lang);
  }
  ...
}
```

`use(lang)` is the **only** sanctioned way to change language (`CONVENTIONS.md`:
"Switch languages only through `LanguageService.use(lang)`") because switching is four
things at once, and doing only one of them would leave the app inconsistent:

1. Tell Transloco which language's strings to render (`setActiveLang`).
2. Set `<html lang="…">` — accessibility/SEO metadata, and what screen readers use to
   pick a pronunciation.
3. Set `<html dir="…">` — this is what actually flips the whole page to right-to-left
   for Arabic; see below.
4. Update the `current` signal, so anything in the UI showing the active language
   (`LanguageSwitcher`) re-renders.

It also persists the choice to `localStorage` (best-effort — wrapped in `try/catch`,
since private browsing or blocked storage can throw) and, on `init()` (called once from
`provideAppInitializer`), restores a previously stored language before the app's first
render, falling back to `fr` if nothing was stored or the stored value isn't a known
language (`isAppLanguage()` in `languages.ts`).

`inject(DOCUMENT)` — not the global `document` — is used so the service is testable
(`language.service.spec.ts` injects a test `DOCUMENT` via `TestBed`) and so it would
work in a server-rendering context if one were ever added; this app doesn't do SSR
today, but the pattern costs nothing and is worth keeping.

## RTL and logical CSS

`ar` is the one RTL language (`RTL_LANGUAGES` in `languages.ts`). Flipping
`<html dir="rtl">` only *automatically* mirrors layout if the CSS uses **logical**
properties instead of physical ones:

```css
/* src/app/features/organization/organization.page.css */
.feedback {
  border-inline-start: 4px solid var(--color-primary);
}
```

`border-inline-start` means "the border on the side text starts from" — the *left* in
LTR, the *right* in RTL, automatically, because the browser resolves `inline-start`
against the element's writing direction. The physical equivalent, `border-left`, would
stay on the left in Arabic too, which is wrong — the accent bar should hug the side text
*begins* from, which flips with the reading direction. `CONVENTIONS.md`: "Use CSS
logical properties (`margin-inline-start`, not `margin-left`)." Every `.css` file in
this app — `app.css`, `organization.page.css`, `org-unit-picker.css`, `org-tree.ts`'s
inline `styles` — follows this: `padding-inline`, `inset-inline-start`,
`border-inline-end`, `padding-block`, never `left`/`right`/`margin-left`/etc.

The one place a *physical* transform is deliberately used is a chevron icon in
`org-tree.ts`, mirrored explicitly with a `:dir(rtl)` selector rather than logical
properties (rotation isn't expressible logically):

```css
.chevron:dir(rtl) { transform: scaleX(-1); }
```

### The css-logical guardrail

`tools/guardrails/css/css-logical.ts` is a CI check (not part of the Angular framework
itself, but specific to this repo) that scans `apps/web/src` — `.css`/`.scss` files,
inline `styles`/`template` in `@Component`, and `style="…"`/`[style.margin-left]`-style
bindings in `.html` — and fails the build on any physical-direction property
(`margin-left`, `padding-right`, `left:`, `text-align: left`, `float: right`, etc.),
suggesting the logical replacement in its error message. A deliberate physical property
can be excused with a `css-logical-ignore` comment on the same line (used for the
chevron transform above). This guardrail exists precisely because "forgot one
`margin-left`" is an easy, silent RTL bug that only shows up when someone actually
switches to Arabic and looks closely — the guardrail catches it at commit/CI time
instead.

## The i18n parity guardrail

`tools/guardrails/i18n/i18n-parity.ts` checks the three translation files against each
other:

- `fr` (the source of truth) and `ar` must have **identical** nested key sets — a
  missing Arabic translation is an **error**, because `ar` is a fully supported
  language, not a work-in-progress one.
- `en` may lag — a key present in `fr` but missing in `en`, or vice-versa, is only a
  **warning** (`CONVENTIONS.md`: "`en` may lag").
- Every leaf value must be a non-empty string.
- `{{placeholder}}` tokens inside a key's value must match across languages (a
  `{{name}}` in `fr` but no `{{name}}` in `ar` for the same key is an error) — this
  catches a translator dropping or renaming an interpolation placeholder.

`translations.spec.ts` (a unit test, separate from but consistent with the guardrail)
checks the same `fr`/`ar` key parity and the "`en` has no keys unknown to `fr`" and
"no empty strings" rules directly against the imported JSON files, so a broken parity
also fails `npm test`, not just the CI guardrail script.

## Labels that are data, not translation keys

Not every visible label belongs in `public/i18n/*.json`. Org-unit **kind** names
("Direction générale", "Agence"…) are maintained by the business in a database
catalogue with `label_fr`/`label_ar`/`label_en` (contract v2), because adding a kind must
not need a web release. So v2 **removed** the `org.kind.*` keys from all three files; the
web asks `KindCatalog.labelOf(code)` (`src/app/core/org/kind-catalog.ts`), which picks the
label for `LanguageService.current()` and re-renders on a language switch like `t()`
does. Chapter 03 shows the `computed()` that combines the two signals.

When deciding where a label goes: written by the team, part of the UI → i18n key.
Maintained by the business, part of the data → API field per language (and never a
translation key built from a data code like `t('org.kind.' + code)`: a new code would
show a missing key).

## Adding a key correctly

See chapter 10's "add a translation key" recipe for the concrete steps — in short: add
the key to `fr.json` (source of truth) and `ar.json` (must match), optionally `en.json`,
keep the same `{{placeholder}}` names across all three, then use it with
`t('your.new.key')` inside a `*transloco="let t"` block.

## Next

[09-testing.md](./09-testing.md) — Vitest, `TestBed`, and how tests like
`language.service.spec.ts` and `translations.spec.ts` are structured.
