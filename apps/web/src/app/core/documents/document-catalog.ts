/**
 * DocumentCatalog — the document types (`GET /documents/types`), loaded once per app, named in the ACTIVE language.
 *
 * Same pattern as core/leave/leave-catalog.ts (read its header): a root service holds one `httpResource`, and
 * `computed()`s combine it with `LanguageService.current()`, so a language switch re-labels every type on screen
 * without a request; `reload()` after a settings edit refreshes every screen that shows a type.
 *
 * Only the documents screens inject it (register, issue, settings, My documents): a root service is created on first
 * `inject()`, so users who never open those screens never send the request. Notifications and task summaries do not
 * need it — they carry the type's labels, or its fixed code (`documents.typeNames.<code>` in the i18n files).
 */
import { computed, Injectable, inject } from '@angular/core';
import { Session } from '../auth/session';
import { LanguageService } from '../i18n/language.service';
import { pickLabel } from '../leave/leave-catalog';
import type { Labels } from '../leave/leave.models';
import { DocumentsApi } from './documents-api';
import type { DocumentTypeView } from './documents.models';

@Injectable({ providedIn: 'root' })
export class DocumentCatalog {
  private readonly language = inject(LanguageService);
  private readonly session = inject(Session);
  private readonly resource = inject(DocumentsApi).typesResource(() => this.session.isAuthenticated());

  /** Every type, in the API's order (`sortOrder`). */
  readonly types = computed<readonly DocumentTypeView[]>(() =>
    this.resource.hasValue() ? this.resource.value().items.toSorted((a, b) => a.sortOrder - b.sortOrder) : [],
  );
  readonly activeTypes = computed(() => this.types().filter((type) => type.active));
  /** Types an employee may request for themselves. */
  readonly selfServiceTypes = computed(() => this.activeTypes().filter((type) => type.selfService));
  readonly loaded = computed(() => this.resource.hasValue());
  readonly error = computed(() => this.resource.error());

  private readonly byCode = computed(() => new Map(this.types().map((type) => [type.code, type])));

  type(code: string): DocumentTypeView | undefined {
    return this.byCode().get(code);
  }

  /** A type's name in the active language; the code until the catalogue is loaded (or for an unknown code). */
  nameOfCode(code: string): string {
    const type = this.type(code);
    return type ? pickLabel(type.labels, this.language.current()) : code;
  }

  /** Any `{fr, ar, en}` label in the active language. */
  labelOf(labels: Labels | null | undefined): string {
    return pickLabel(labels, this.language.current());
  }

  reload(): void {
    this.resource.reload();
  }
}
