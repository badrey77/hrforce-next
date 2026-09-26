/**
 * /organization — the org tree as of a date, a detail panel for the selected unit, and create/change forms.
 * Sites have their own sub-route, /organization/sites (sites.page.ts); `<app-org-nav>` links the two.
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
 * - **App-wide reference data**: `KindCatalog` is injected here too; it is the same root instance the tree and
 *   forms use, so the kind catalogue is fetched once whatever the number of consumers. The "Add a sub-unit" button
 *   needs BOTH the server's `create_child` action and at least one allowed child kind in the catalogue.
 * - **Scopes** (docs/contracts/authorization.md): the tree holds the caller's units plus their ancestors as muted,
 *   unselectable context nodes (org-tree.ts); buttons still come from the server's `_actions`, never from
 *   `Session.can()` — holding `org_unit.update` somewhere does not mean it applies to THIS unit.
 * - **Arabic unit names** (employment contract): `names` reads `LanguageService.current()` next to the tree, so the
 *   id → name map (breadcrumbs, version parents, audit history) is rebuilt in Arabic on a language switch.
 * - `sites` (`GET /org/sites`) is loaded once by the page and handed down as an input to the forms (select options)
 *   and the detail (site names in the history), instead of each child fetching it.
 * - **History tab** (docs/contracts/audit.md › Web): `<app-history-tabs>` wraps the detail view (content projection)
 *   and adds a "History" tab with the unit's audit timeline for `audit.read` holders. `auditNames` is the
 *   `resolver` input: it names parent units and sites from the tree and the sites list this page already holds. It
 *   is a FIELD (one stable function), and it reads signals (`names()`, `siteNames()`), so the timeline's `computed()`
 *   re-runs when they load. See shared/timeline/history-tabs.ts for the `@defer` block behind the tab.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isIsoDate, todayIso } from '../../core/date/iso-date';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { LanguageService } from '../../core/i18n/language.service';
import type { AppLanguage } from '../../core/i18n/languages';
import { KindCatalog } from '../../core/org/kind-catalog';
import { OrgApi } from '../../core/org/org-api';
import type { OrgAction, OrgTreeNode, OrgUnitDetail, Site } from '../../core/org/org.models';
import { displayNameOf } from '../../shared/display-name/display-name.pipe';
import { HistoryTabs } from '../../shared/timeline/history-tabs';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';
import { ChangeUnitForm } from './change-unit-form';
import { CreateUnitForm } from './create-unit-form';
import { OrgNav } from './org-nav';
import { OrgTree } from './org-tree';
import { UnitDetail } from './unit-detail';
import { UnitHead } from './unit-head';

type Mode = 'view' | 'create' | 'change';

interface Feedback {
  readonly key: string;
  readonly name: string;
}

/** Translation key for a failed read (the resource's `error()`). */
function loadErrorKey(error: unknown, fallback: string, notFound = 'org.problems.notFound'): string {
  if (!isApiProblemError(error)) return fallback;
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 403) return 'errors.forbidden';
  if (error.status === 404) return notFound;
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

function collectNames(node: OrgTreeNode, lang: AppLanguage, into: Map<string, string>): Map<string, string> {
  into.set(node.id, displayNameOf(node, lang));
  for (const child of node.children) collectNames(child, lang, into);
  return into;
}

@Component({
  selector: 'app-organization-page',
  imports: [TranslocoDirective, OrgNav, OrgTree, UnitDetail, UnitHead, CreateUnitForm, ChangeUnitForm, HistoryTabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './organization.page.html',
  styleUrl: './organization.page.css',
})
export class OrganizationPage {
  private readonly api = inject(OrgApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly kindCatalog = inject(KindCatalog);
  private readonly lang = inject(LanguageService).current;

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
  /** All sites (no search): options of the site selects and names for the version history. */
  private readonly sitesResource = this.api.sitesResource(() => '');
  protected readonly sites = computed<readonly Site[]>(() =>
    this.sitesResource.hasValue() ? this.sitesResource.value().items : [],
  );
  protected readonly siteNames = computed(
    () => new Map(this.sites().map((site) => [site.id, `${site.name} (${site.code})`])),
  );

  protected readonly root = computed(() => (this.tree.hasValue() ? this.tree.value().root : null));
  /** id → unit name in the UI language (Arabic when present): breadcrumbs, version parents, audit history. */
  protected readonly names = computed(() => {
    const root = this.root();
    return root ? collectNames(root, this.lang(), new Map()) : new Map<string, string>();
  });

  /** Names for ids in the audit history: units from the tree, sites from the sites list, kinds from the catalogue. */
  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    if (kind === 'unit') return this.names().get(value);
    if (kind === 'site') return this.siteNames().get(value);
    if (kind === 'kind') return this.kindCatalog.labelOf(value);
    return undefined;
  };

  /** What the user may do on the selected unit: from its tree node, else (not in the tree at this date) its detail. */
  protected readonly actions = computed<readonly OrgAction[]>(() => {
    const id = this.selectedId();
    const root = this.root();
    const node = id && root ? findNode(root, id) : undefined;
    // A context node (outside the caller's scope) is never actionable, whatever it carries.
    if (node?.inScope === false) return [];
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    if (node) return node._actions;
    // oxlint-disable-next-line no-underscore-dangle -- idem
    return this.detail.hasValue() ? this.detail.value()._actions : [];
  });

  protected readonly treeErrorKey = computed(() => loadErrorKey(this.tree.error(), 'org.tree.loadError'));
  /**
   * A 404 on the detail reads "not found", never "forbidden": out-of-scope ids are 404 by design (ADR 002), and the
   * page must not hint that the unit exists.
   */
  protected readonly detailErrorKey = computed(() =>
    loadErrorKey(this.detail.error(), 'org.detail.loadError', 'org.detail.notFound'),
  );

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

  /** `create_child` from the server, and at least one kind the catalogue allows under this unit. */
  protected canCreateUnder(unit: OrgUnitDetail): boolean {
    return this.can('create_child') && this.kindCatalog.allowedChildKinds(unit.kind).length > 0;
  }

  protected startMode(mode: Mode): void {
    this.feedback.set(null);
    this.mode.set(mode);
  }

  protected onCreated(unit: OrgUnitDetail): void {
    this.feedback.set({ key: 'org.feedback.created', name: displayNameOf(unit, this.lang()) });
    this.tree.reload();
    this.selectedId.set(unit.id); // loads the new unit's detail; `mode` resets to 'view' (linkedSignal)
  }

  protected onChanged(unit: OrgUnitDetail): void {
    this.feedback.set({ key: 'org.feedback.changed', name: displayNameOf(unit, this.lang()) });
    this.mode.set('view');
    this.tree.reload();
    this.detail.reload();
  }
}
