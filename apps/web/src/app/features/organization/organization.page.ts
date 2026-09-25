/**
 * /organization — the org tree as of a date, a detail panel for the selected unit, and create/change forms.
 *
 * Angular concepts:
 * - **Router → component input binding.** `app.config.ts` enables `withComponentInputBinding()`: the router then
 *   copies route params, query params and route `data` into component inputs *of the same name*. So
 *   `/organization?asOf=2025-01-31` arrives as the signal input `asOf()` — no `ActivatedRoute` subscription.
 *   When the query param changes (back button, a shared link, our own date picker), the input updates and
 *   everything derived from it (`effectiveAsOf` → the tree request) follows automatically.
 * - **Resources as page state.** `tree` and `detail` are `httpResource`s (see core/org/org-api.ts). They re-fetch
 *   when their signals change (`effectiveAsOf`, `selectedId`), cancel superseded requests, and expose
 *   `hasValue()`, `isLoading()`, `error()` — the template derives the loading / error / content states from them.
 *   `reload()` re-runs the same request (used after a successful write); during a reload the old value stays
 *   visible (status `reloading`), so the tree does not flash.
 * - **`linkedSignal()`** is a writable signal that *resets itself* whenever its `source` changes. `mode`
 *   ('view' | 'create' | 'change') is set by the buttons, and snaps back to 'view' when another unit is selected.
 * - **`inject(Router)` + `router.navigate([], { queryParams, queryParamsHandling: 'merge' })`** changes only the
 *   query string of the current URL; the component is reused and its `asOf` input updates.
 * - **`[(selectedId)]`** in the template is two-way binding to the tree's `model()` input (see org-tree.ts).
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isIsoDate, todayIso } from '../../core/date/iso-date';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { OrgApi } from '../../core/org/org-api';
import type { OrgAction, OrgTreeNode, OrgUnitDetail } from '../../core/org/org.models';
import { ChangeUnitForm } from './change-unit-form';
import { CreateUnitForm } from './create-unit-form';
import { OrgTree } from './org-tree';
import { UnitDetail } from './unit-detail';

type Mode = 'view' | 'create' | 'change';

interface Feedback {
  readonly key: string;
  readonly name: string;
}

/** Translation key for a failed read (the resource's `error()`). */
function loadErrorKey(error: unknown, fallback: string): string {
  if (!isApiProblemError(error)) return fallback;
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 403) return 'errors.forbidden';
  if (error.status === 404) return 'org.problems.notFound';
  return fallback;
}

function findNode(node: OrgTreeNode, id: string): OrgTreeNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function collectNames(node: OrgTreeNode, into: Map<string, string>): Map<string, string> {
  into.set(node.id, node.name);
  for (const child of node.children) collectNames(child, into);
  return into;
}

@Component({
  selector: 'app-organization-page',
  imports: [TranslocoDirective, OrgTree, UnitDetail, CreateUnitForm, ChangeUnitForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './organization.page.html',
  styleUrl: './organization.page.css',
})
export class OrganizationPage {
  private readonly api = inject(OrgApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** `?asOf=YYYY-MM-DD`, bound by the router (withComponentInputBinding). Absent → undefined. */
  readonly asOf = input<string>();

  /** The date actually shown: a valid `asOf`, else today. */
  protected readonly effectiveAsOf = computed(() => {
    const asOf = this.asOf();
    return isIsoDate(asOf) ? asOf : todayIso();
  });

  protected readonly tree = this.api.treeResource(this.effectiveAsOf);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly detail = this.api.unitResource(this.selectedId);
  protected readonly mode = linkedSignal<string | null, Mode>({ source: this.selectedId, computation: () => 'view' });
  protected readonly feedback = signal<Feedback | null>(null);

  protected readonly root = computed(() => (this.tree.hasValue() ? this.tree.value().root : null));
  protected readonly names = computed(() => {
    const root = this.root();
    return root ? collectNames(root, new Map()) : new Map<string, string>();
  });

  /** What the user may do on the selected unit: from its tree node, else (not in the tree at this date) its detail. */
  protected readonly actions = computed<readonly OrgAction[]>(() => {
    const id = this.selectedId();
    const root = this.root();
    const node = id && root ? findNode(root, id) : undefined;
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    if (node) return node._actions;
    // oxlint-disable-next-line no-underscore-dangle -- idem
    return this.detail.hasValue() ? this.detail.value()._actions : [];
  });

  protected readonly treeErrorKey = computed(() => loadErrorKey(this.tree.error(), 'org.tree.loadError'));
  protected readonly detailErrorKey = computed(() => loadErrorKey(this.detail.error(), 'org.detail.loadError'));

  protected onAsOfChange(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.feedback.set(null);
    void this.router.navigate([], {
      relativeTo: this.route,
      // `null` removes the param: back to "today".
      queryParams: { asOf: isIsoDate(value) ? value : null },
      queryParamsHandling: 'merge',
    });
  }

  protected can(action: OrgAction): boolean {
    return this.actions().includes(action);
  }

  protected startMode(mode: Mode): void {
    this.feedback.set(null);
    this.mode.set(mode);
  }

  protected onCreated(unit: OrgUnitDetail): void {
    this.feedback.set({ key: 'org.feedback.created', name: unit.name });
    this.tree.reload();
    this.selectedId.set(unit.id); // loads the new unit's detail; `mode` resets to 'view' (linkedSignal)
  }

  protected onChanged(unit: OrgUnitDetail): void {
    this.feedback.set({ key: 'org.feedback.changed', name: unit.name });
    this.mode.set('view');
    this.tree.reload();
    this.detail.reload();
  }
}
