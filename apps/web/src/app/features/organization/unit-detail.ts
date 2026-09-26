/**
 * Read-only view of one org unit: identity, parent chain, effective site and version history.
 * `<app-unit-detail [unit]="…" [names]="…" [siteNames]="…" />`.
 *
 * Angular concepts:
 * - **Presentational ("dumb") component**: data in through inputs, nothing fetched, no side effects. The page
 *   owns loading/error states and the actions; this keeps the view trivial to test and reuse.
 * - **`computed()`** derives the parent-name lookup; it re-runs only when `unit` or `names` change, not on every
 *   change-detection pass (a method called from the template would run each time the view is checked).
 * - **`@for … ; track $index`**: versions have no id of their own; the list is replaced wholesale on reload, so
 *   tracking by position is fine here.
 * - **`@empty`** after `@for` renders when the list is empty.
 * - The kind badge comes from `KindCatalog.labelOf()` (API data in the active language), not from `t()`.
 * - Names in the UI language: the title and the version names go through the `displayName` pipe (Arabic name in the
 *   Arabic UI when there is one). The breadcrumb names come from the `names` input first — the page builds that map
 *   from the tree in the active language, because the contract's `path` items carry only the Latin `name`.
 * - `class="nowrap"` on date and code cells (global utility, styles.css): "2026-01-01" must not break at a hyphen.
 *
 * Site: `unit.site` is the EFFECTIVE site; when `siteInherited` is true it comes from an ancestor, which the view
 * says. In the history, a version's `siteId` is its OWN site, so `null` reads "inherited".
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { LanguageService } from '../../core/i18n/language.service';
import { KindCatalog } from '../../core/org/kind-catalog';
import type { OrgUnitDetail, OrgUnitPathItem } from '../../core/org/org.models';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';

@Component({
  selector: 'app-unit-detail',
  imports: [TranslocoDirective, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let u = unit();
      <h2 class="title">
        <span class="badge">{{ kindCatalog.labelOf(u.kind) }}</span>&ngsp;{{ u | displayName: lang() }}
      </h2>
      <dl class="facts">
        <dt>{{ t('org.detail.code') }}</dt>
        <dd class="code">{{ u.code }}</dd>
        <dt>{{ t('org.detail.nameLatin') }}</dt>
        <dd data-field="name">{{ u.name }}</dd>
        <dt>{{ t('org.detail.nameAr') }}</dt>
        <dd data-field="nameAr" dir="auto">{{ u.nameAr || t('org.detail.none') }}</dd>
        <dt>{{ t('org.detail.path') }}</dt>
        <dd>
          @if (u.path.length) {
            <ol class="breadcrumb">
              @for (step of u.path; track step.id) {
                <li>{{ pathName(step) }}</li>
              }
            </ol>
          } @else {
            {{ t('org.detail.rootUnit') }}
          }
        </dd>
        <dt>{{ t('org.detail.site') }}</dt>
        <dd data-field="site">
          @if (u.site; as site) {
            {{ site.name }} <span class="code">({{ site.code }})</span>
            @if (u.siteInherited) {
              <span class="hint">{{ t('org.detail.siteInherited') }}</span>
            }
          } @else {
            {{ t('org.detail.none') }}
          }
        </dd>
        <dt>{{ t('org.detail.createdAt') }}</dt>
        <dd>{{ u.createdAt.slice(0, 10) }}</dd>
      </dl>

      <h3>{{ t('org.detail.versions') }}</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{{ t('org.detail.validFrom') }}</th>
              <th scope="col">{{ t('org.detail.validTo') }}</th>
              <th scope="col">{{ t('org.detail.name') }}</th>
              <th scope="col">{{ t('org.detail.parent') }}</th>
              <th scope="col">{{ t('org.detail.site') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (version of u.versions; track $index) {
              <tr>
                <td class="nowrap">{{ version.validFrom }}</td>
                <td class="nowrap">{{ version.validTo ?? t('org.detail.open') }}</td>
                <td>{{ version | displayName: lang() }}</td>
                <td>{{ version.parentId ? parentName(version.parentId) : t('org.detail.none') }}</td>
                <td>{{ version.siteId ? siteName(version.siteId) : t('org.detail.inherited') }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="5">{{ t('org.detail.none') }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </ng-container>
  `,
  styles: `
    .title { display: flex; align-items: center; gap: var(--space-2); margin-block: 0 var(--space-3); font-size: 1.25rem; }
    .facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-4); margin: 0; }
    dt { color: var(--color-text-muted); }
    dd { margin: 0; }
    .code { font-family: ui-monospace, monospace; }
    .hint { color: var(--color-text-muted); font-size: 0.8125rem; margin-inline-start: var(--space-2); }
    h3 { font-size: 1rem; margin-block: var(--space-4) var(--space-2); }
    .table-scroll { overflow-x: auto; }
    table { border-collapse: collapse; inline-size: 100%; font-size: 0.875rem; }
    th, td { padding-block: var(--space-1); padding-inline: var(--space-2); text-align: start; }
    th { border-block-end: 2px solid var(--color-border); }
    td { border-block-end: 1px solid var(--color-border); }
  `,
})
export class UnitDetail {
  protected readonly kindCatalog = inject(KindCatalog);
  protected readonly lang = inject(LanguageService).current;
  readonly unit = input.required<OrgUnitDetail>();
  /** id → name of units known from the tree, to name the parent of older versions. */
  readonly names = input<ReadonlyMap<string, string>>(new Map());
  /** id → label of known sites, to name the site of older versions. */
  readonly siteNames = input<ReadonlyMap<string, string>>(new Map());

  private readonly lookup = computed(() => {
    const map = new Map(this.names());
    for (const step of this.unit().path) if (!map.has(step.id)) map.set(step.id, displayNameOf(step, this.lang()));
    return map;
  });

  private readonly siteLookup = computed(() => {
    const map = new Map(this.siteNames());
    const site = this.unit().site;
    if (site && !map.has(site.id)) map.set(site.id, `${site.name} (${site.code})`);
    return map;
  });

  /** A breadcrumb step in the UI language: from the page's (language-aware) name map, else the step itself. */
  protected pathName(step: OrgUnitPathItem): string {
    return this.names().get(step.id) ?? displayNameOf(step, this.lang());
  }

  protected parentName(id: string): string {
    return this.lookup().get(id) ?? id;
  }

  protected siteName(id: string): string {
    return this.siteLookup().get(id) ?? id;
  }
}
