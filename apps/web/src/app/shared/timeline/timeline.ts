/**
 * `<app-timeline [subject]="'org_unit:' + unit.id" [resolver]="names" />` — the audit history of one subject
 * (docs/contracts/audit.md › Web): newest first, grouped by day, actor + time, one line per changed field, masked
 * values, event sentences, empty / loading / error states and "load more".
 *
 * Angular concepts:
 * - **Accumulating cursor pages with signals.** A resource holds ONE response. "Load more" needs all pages so far.
 *   The design here:
 *     1. `cursor` — a `linkedSignal` of the subject: "load more" sets it to the last page's `nextCursor`; a new
 *        subject resets it to `null` (the newest page) by itself.
 *     2. `page` — an `httpResource` keyed on `{ subject, cursor }` (AuditApi.timelineResource): a new cursor sends
 *        the next request, and cancels one still in flight.
 *     3. `pages` — a `linkedSignal` whose `computation(source, previous)` receives its own PREVIOUS value: it
 *        appends each newly arrived page to what it had, and starts from `[]` when the subject changed.
 *   Everything else (`entries`, `groups`, `nextCursor`) is `computed()` from `pages`.
 *   Alternatives considered:
 *     - `scan()` over a `Subject` of cursors (`cursor$.pipe(concatMap(api.timeline), scan(append))` + `toSignal`)
 *       works well and is the classic RxJS answer, but loading/error flags and "reset on new subject" must then be
 *       built by hand (`startWith`, `catchError`, a `switchMap` on the subject), and the result is converted to a
 *       signal anyway for the template. The resource gives `isLoading()`, `error()` and `reload()` for free.
 *     - An imperative `loadMore()` that subscribes and does `pages.update(p => [...p, page])` is the shortest, but
 *       every state flag (loading, error, stale response after a subject change) is again ours to manage.
 *   "Load more" vs infinite scroll: an audit trail is consulted, not browsed; a button keeps the user in control,
 *   keeps the page footer reachable, is keyboard- and screen-reader-friendly by default, and never fires requests
 *   the user did not ask for. Infinite scroll would be the same `cursor.set()` driven by an `IntersectionObserver`
 *   on the last row (or a `@defer (on viewport)` sentinel) — the accumulation above would not change.
 * - **Grouping in a `computed()`, not a pipe.** `entries | groupByDay` (a pure pipe) would also be memoised — it
 *   re-runs only when the array reference changes. A `computed()` is chosen because its inputs are already
 *   signals (pages, the resolver's data, and the names it reads), it re-runs when ANY of them changes (a role
 *   catalogue arriving re-names the lines), and it keeps the template a plain `@for`. Rule of thumb: a
 *   formatting helper you want in many templates → pipe (`dayHeading`); view-model derivation for one component →
 *   `computed()`.
 * - **Pipes in templates.** `{{ entry.at | date: 'shortTime' : undefined : locale() }}` uses Angular's built-in
 *   `DatePipe` (import `DatePipe` in `imports`); `: arg` passes arguments — format, timezone (`undefined` = the
 *   browser's), locale. Passing the locale explicitly makes a language switch re-format (see date-locale.ts).
 *   `{{ group.day | dayHeading: lang() }}` is our own pure pipe (day-heading.pipe.ts).
 * - **Names through an input (`resolver`), not DI.** Ids in the diff (parent unit, site, role, permission…) are
 *   named from data the HOST PAGE already holds: the org page has the tree and the sites, the access pages have
 *   the role catalogue. An input makes that dependency explicit at the call site and trivial to fake in a test. The
 *   DI alternative — an `InjectionToken<AuditNameResolver>` the page provides in its `providers` — pays off when
 *   the component sits several levels below the page (no input threading), at the cost of a less visible contract.
 *   The resolver may read signals: it is called inside the `groups` computed, so names appear once the page's
 *   data arrives.
 * - `@for (…; track entry.id)`: ids are unique across changes and events (`c:`/`e:` prefixes), so appending a page
 *   only creates DOM for the new rows.
 *
 * Field labels come from `audit.fields.<table>.<column>`; an unknown key falls back to the column name (the
 * template compares `t(key)` with the key, which is what Transloco returns for a missing key).
 */
import { DatePipe, formatDate } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { AuditApi } from '../../core/audit/audit-api';
import type { AuditSubject, TimelinePage } from '../../core/audit/audit.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { DayHeadingPipe } from './day-heading.pipe';
import { TimelineValue } from './timeline-value';
import { type AuditNameResolver, buildTimeline, NO_NAMES } from './timeline-view';

interface PageSource {
  readonly subject: AuditSubject;
  readonly page: TimelinePage | undefined;
}

@Component({
  selector: 'app-timeline',
  imports: [TranslocoDirective, DatePipe, DayHeadingPipe, TimelineValue],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline.html',
  styleUrl: './timeline.css',
})
export class Timeline {
  private readonly api = inject(AuditApi);
  private readonly language = inject(LanguageService);

  /** `<type>:<id>` — `org_unit`, `site`, `role` or `user`. */
  readonly subject = input.required<AuditSubject>();
  /** Names ids the host page knows (see header). Default: show values as stored. */
  readonly resolver = input<AuditNameResolver>(NO_NAMES);

  protected readonly lang = this.language.current;
  protected readonly locale = computed(() => dateLocaleOf(this.language.current()));

  /** Cursor of the page to fetch; resets to the newest page (`null`) when the subject changes. */
  private readonly cursor = linkedSignal<AuditSubject, string | null>({ source: this.subject, computation: () => null });
  protected readonly page = this.api.timelineResource(() => ({ subject: this.subject(), cursor: this.cursor() }));

  /** Every page received for the current subject, oldest request first. */
  private readonly pages = linkedSignal<PageSource, readonly TimelinePage[]>({
    source: () => ({ subject: this.subject(), page: this.page.hasValue() ? this.page.value() : undefined }),
    computation: (source, previous) => {
      const kept = previous && previous.source.subject === source.subject ? previous.value : [];
      if (!source.page || kept.includes(source.page)) return kept;
      return [...kept, source.page];
    },
  });

  protected readonly entries = computed(() => this.pages().flatMap((page) => page.items));
  protected readonly groups = computed(() => {
    const locale = this.locale();
    // dates in event sentences (validFrom/validTo), like the field lines: medium format (Angular reads YYYY-MM-DD as a local day)
    return buildTimeline(this.entries(), this.resolver(), new Date(), (day) => formatDate(day, 'mediumDate', locale));
  });
  /** `null` once the last page said so: the "load more" button disappears. */
  protected readonly nextCursor = computed(() => this.pages().at(-1)?.nextCursor ?? null);
  protected readonly started = computed(() => this.pages().length > 0);

  protected readonly errorKey = computed(() => {
    const error = this.page.error();
    if (!isApiProblemError(error)) return 'audit.loadError';
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 403) return 'errors.forbidden';
    // Out-of-scope or unknown subject (ADR 002: 404, never 403).
    if (error.status === 404) return 'audit.notFound';
    return 'audit.loadError';
  });

  protected loadMore(): void {
    const next = this.nextCursor();
    if (next) this.cursor.set(next);
  }

  /** Retry the failed request (first page or a later one): same subject, same cursor. */
  protected retry(): void {
    this.page.reload();
  }
}
