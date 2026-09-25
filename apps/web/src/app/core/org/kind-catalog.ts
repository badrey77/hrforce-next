/**
 * KindCatalog — the org-unit kind catalogue (`GET /org/kinds`), loaded once per app, as signals.
 *
 * Contract v2 made kinds DATA: their codes, labels (fr/ar/en) and parent rules live in the database, so the web
 * holds no kind union, no parent table and no `org.kind.*` translation keys any more. Everything that needs a
 * kind label or rule asks this service.
 *
 * Angular concepts:
 * - **A root service as an app-wide cache.** `providedIn: 'root'` means one instance for the whole app, created on
 *   the first `inject(KindCatalog)`. Its field initializer creates an `httpResource` whose request function reads
 *   no signal, so the request is sent once and the value is kept for the life of the app: every component that
 *   injects the catalogue shares it, and navigating away and back does not re-fetch. Why this rather than the
 *   alternatives (see docs/angular/06-http-and-errors.md, "Reference data: fetch once per app"):
 *     - `http.get().pipe(shareReplay(1))` caches too, but leaves us with an Observable that every template would
 *       have to subscribe to (or wrap in `toSignal`), and a failed request is replayed forever unless we add
 *       retry logic by hand.
 *     - `httpResource()` in each component would re-fetch on every page visit.
 *     - `httpResource()` held by a root service (chosen) gives signals directly (`value()`, `status()`, `error()`)
 *       and a built-in `reload()` to retry after a failure.
 * - **Combining two signals from different worlds in one `computed()`.** `labels` reads the catalogue (API data)
 *   AND `LanguageService.current()` (the active UI language). A computed re-runs when ANY signal it read changes,
 *   so switching the language rebuilds the code → label map, and every template that called `labelOf()`
 *   re-renders with the new label — exactly like Transloco's `t()` does for static texts.
 *   Rule of thumb: texts the team writes (buttons, messages) come from `public/i18n/*.json` through `t()`;
 *   labels of reference data the business maintains (kinds today, wilayas later) come from the API with one
 *   label per language, and are picked with the language signal, as here.
 * - Methods such as `labelOf(code)` are plain functions, but they READ signals: when a template or a `computed`
 *   calls them, the signals read inside become dependencies of that template/computed. So `{{ kinds.labelOf(x) }}`
 *   in a template stays live without the template knowing anything about signals.
 */
import { computed, Injectable, inject } from '@angular/core';
import { LanguageService } from '../i18n/language.service';
import { OrgApi } from './org-api';
import type { OrgKind, OrgUnitKind } from './org.models';

@Injectable({ providedIn: 'root' })
export class KindCatalog {
  private readonly language = inject(LanguageService);
  /** Created once, with this root service: the one `GET /org/kinds` of the app. */
  private readonly resource = inject(OrgApi).kindsResource();

  /** The catalogue in sortOrder (the API sorts it); empty until loaded or on error. */
  readonly kinds = computed<readonly OrgKind[]>(() => (this.resource.hasValue() ? this.resource.value().items : []));
  readonly loaded = computed(() => this.resource.hasValue());
  /** The load error, if any (an `ApiProblemError`); the page shows it with a retry. */
  readonly error = computed(() => this.resource.error());

  /** code → label in the ACTIVE language. Rebuilt when the catalogue or the language changes. */
  private readonly labels = computed(() => {
    const lang = this.language.current();
    return new Map(this.kinds().map((kind) => [kind.code, kind.labels[lang]]));
  });

  private readonly byCode = computed(() => new Map(this.kinds().map((kind) => [kind.code, kind])));

  /** Label of a kind in the active language; the code itself until the catalogue is loaded (or for an unknown code). */
  labelOf(code: OrgUnitKind): string {
    return this.labels().get(code) || code;
  }

  /** Kinds that may be created under a unit of `parentKind`, in sortOrder. Empty → no "create" for that unit. */
  allowedChildKinds(parentKind: OrgUnitKind): OrgUnitKind[] {
    return this.kinds()
      .filter((kind) => kind.allowedParents.includes(parentKind))
      .map((kind) => kind.code);
  }

  /** Kinds a unit of `kind` may hang under (move targets). Empty for the root kind. */
  allowedParentKinds(kind: OrgUnitKind): readonly OrgUnitKind[] {
    return this.byCode().get(kind)?.allowedParents ?? [];
  }

  /** Retry after a failed load. */
  reload(): void {
    this.resource.reload();
  }
}
