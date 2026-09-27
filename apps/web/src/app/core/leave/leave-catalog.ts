/**
 * LeaveCatalog — leave types (`GET /leave/types`), loaded once per app, with names in the ACTIVE language.
 *
 * Same pattern as core/org/kind-catalog.ts (read its header first): a root service holds one `httpResource`, and a
 * `computed()` combines the API data with `LanguageService.current()`, so a language switch re-labels every leave
 * type on screen without a request. Leave type names are business data (HR edits them in /leave/settings), so they
 * come from the API in fr/ar/en — never from `public/i18n/*.json`.
 *
 * What is new here:
 * - **A catalogue that waits for a session.** `GET /leave/types` needs a signed-in caller. The resource's request
 *   function reads `Session.isAuthenticated()`: signed out → `undefined` → no request; signing in flips the signal and
 *   the request goes out. (The kind catalogue never needed this: only signed-in pages inject it.) Here the nav badge
 *   and several pages inject it, so it must be safe to create before login.
 * - **`labelOf()` for any `Labels`/string** — holidays and workflow step labels use the same `{fr, ar, en}` shape, so
 *   one function (`pickLabel`) serves them all, with a fallback to French then to any non-empty text.
 * - **`reload()` after a settings edit**: `/leave/settings` changes a type, then reloads THIS shared resource, and
 *   every page that shows a type name picks up the new label.
 */
import { computed, Injectable, inject } from '@angular/core';
import { Session } from '../auth/session';
import { LanguageService } from '../i18n/language.service';
import type { AppLanguage } from '../i18n/languages';
import { LeaveApi } from './leave-api';
import type { Labels, LeaveType, LocalizedText } from './leave.models';

/** The text for `lang` (then French, then any non-empty one). A plain string is already localised. */
export function pickLabel(text: LocalizedText | null | undefined, lang: AppLanguage): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  return text[lang] || text.fr || text.en || text.ar || '';
}

@Injectable({ providedIn: 'root' })
export class LeaveCatalog {
  private readonly language = inject(LanguageService);
  private readonly session = inject(Session);
  private readonly resource = inject(LeaveApi).typesResource(() => this.session.isAuthenticated());

  /** Every type the API returned (active or not), in API order. */
  readonly types = computed<readonly LeaveType[]>(() => (this.resource.hasValue() ? this.resource.value().items : []));
  /** Types a request can be made for. */
  readonly activeTypes = computed(() => this.types().filter((type) => type.active));
  readonly loaded = computed(() => this.resource.hasValue());
  readonly error = computed(() => this.resource.error());

  private readonly byId = computed(() => new Map(this.types().map((type) => [type.id, type])));
  /** id → name in the active language. Rebuilt when the catalogue or the language changes. */
  private readonly names = computed(() => {
    const lang = this.language.current();
    return new Map(this.types().map((type) => [type.id, pickLabel(type.labels, lang)]));
  });

  /** code → name in the active language (notifications carry the type's CODE, not its id). */
  private readonly namesByCode = computed(() => {
    const lang = this.language.current();
    return new Map(this.types().map((type) => [type.code, pickLabel(type.labels, lang)]));
  });

  type(id: string): LeaveType | undefined {
    return this.byId().get(id);
  }

  /** Name of a type in the active language; the id until the catalogue is loaded (or for an unknown id). */
  nameOf(id: string): string {
    return this.names().get(id) || id;
  }

  /** Name of a type by its code (e.g. `annual`); the code itself until loaded or when unknown. */
  nameOfCode(code: string): string {
    return this.namesByCode().get(code) || code;
  }

  /** Any `{fr, ar, en}` label (holiday, workflow step) in the active language. Reads the language signal. */
  labelOf(text: LocalizedText | Labels | null | undefined): string {
    return pickLabel(text, this.language.current());
  }

  reload(): void {
    this.resource.reload();
  }
}
