/**
 * Read-only view of one org unit: identity, parent chain and version history. `<app-unit-detail [unit]="…" />`.
 *
 * Angular concepts:
 * - **Presentational ("dumb") component**: data in through inputs, nothing fetched, no side effects. The page
 *   owns loading/error states and the actions; this keeps the view trivial to test and reuse.
 * - **`computed()`** derives the parent-name lookup; it re-runs only when `unit` or `names` change, not on every
 *   change-detection pass (a method called from the template would run each time the view is checked).
 * - **`@for … ; track $index`**: versions have no id of their own; the list is replaced wholesale on reload, so
 *   tracking by position is fine here.
 * - **`@empty`** after `@for` renders when the list is empty.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import type { OrgUnitDetail } from '../../core/org/org.models';

@Component({
  selector: 'app-unit-detail',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let u = unit();
      <h2 class="title">
        <span class="badge">{{ t('org.kind.' + u.kind) }}</span>&ngsp;{{ u.name }}
      </h2>
      <dl class="facts">
        <dt>{{ t('org.detail.code') }}</dt>
        <dd class="code">{{ u.code }}</dd>
        <dt>{{ t('org.detail.path') }}</dt>
        <dd>
          @if (u.path.length) {
            <ol class="breadcrumb">
              @for (step of u.path; track step.id) {
                <li>{{ step.name }}</li>
              }
            </ol>
          } @else {
            {{ t('org.detail.rootUnit') }}
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
            </tr>
          </thead>
          <tbody>
            @for (version of u.versions; track $index) {
              <tr>
                <td>{{ version.validFrom }}</td>
                <td>{{ version.validTo ?? t('org.detail.open') }}</td>
                <td>{{ version.name }}</td>
                <td>{{ version.parentId ? parentName(version.parentId) : t('org.detail.none') }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4">{{ t('org.detail.none') }}</td>
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
    h3 { font-size: 1rem; margin-block: var(--space-4) var(--space-2); }
    .table-scroll { overflow-x: auto; }
    table { border-collapse: collapse; inline-size: 100%; font-size: 0.875rem; }
    th, td { padding-block: var(--space-1); padding-inline: var(--space-2); text-align: start; }
    th { border-block-end: 2px solid var(--color-border); }
    td { border-block-end: 1px solid var(--color-border); }
  `,
})
export class UnitDetail {
  readonly unit = input.required<OrgUnitDetail>();
  /** id → name of units known from the tree, to name the parent of older versions. */
  readonly names = input<ReadonlyMap<string, string>>(new Map());

  private readonly lookup = computed(() => {
    const map = new Map(this.names());
    for (const step of this.unit().path) map.set(step.id, step.name);
    return map;
  });

  protected parentName(id: string): string {
    return this.lookup().get(id) ?? id;
  }
}
