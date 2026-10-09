import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { DEFAULT_PRESENCE_QUERY, type BoardStatus } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { BrandingService } from '../../core/branding/branding.service';
import { EmployeesApi } from '../../core/employees/employees-api';
import { DEFAULT_EMPLOYEE_QUERY } from '../../core/employees/employees.models';
import { LeaveApi } from '../../core/leave/leave-api';
import { DEFAULT_LEAVE_QUERY } from '../../core/leave/leave.models';
import { ATTENDANCE_SELF_SERVICE_PERMISSION, MyEmployment, SELF_SERVICE_PERMISSION } from '../../core/leave/my-employment';
import { MyRecruitment, RECRUITMENT_READ } from '../../core/recruitment/my-recruitment';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { ACTIVE_STAGES } from '../../core/recruitment/recruitment.models';
import { TasksBadge } from '../../core/tasks/tasks-badge';

@Component({
  selector: 'app-home-page',
  imports: [TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <!-- Branding: the company's welcome texts and logo; the built-in title and intro when none is set. -->
      <header class="welcome">
        @if (branding.companyLogo(); as logo) {
          <img class="company-logo" [src]="logo.url" [attr.width]="logo.width" [attr.height]="logo.height" [alt]="session.company()?.name ?? ''" data-brand-logo="company" />
        }
        <div class="welcome-text">
          @if (branding.welcomeTitle(); as title) {
            <h1 dir="auto" [attr.lang]="branding.langAttr(title)">{{ title.text }}</h1>
          } @else {
            <h1>{{ t('home.title') }}</h1>
          }
          @if (branding.welcomeMessage(); as message) {
            <p class="intro" dir="auto" [attr.lang]="branding.langAttr(message)">{{ message.text }}</p>
          } @else {
            <p class="intro">{{ t('home.intro') }}</p>
          }
        </div>
      </header>

      <!-- The caller's own figures: open tasks for everyone; today's punches and the annual leave balance for a
           linked employee. Each section below is fetched and shown only with its permission. -->
      <section class="panel" aria-labelledby="home-mine-title" data-card="mine">
        <h2 id="home-mine-title">{{ t('home.mine') }}</h2>
        <ul class="counts">
          <li>
            <a routerLink="/tasks" class="tile" data-count="tasks"><strong>{{ tasks.count() }}</strong><span>{{ t('home.openTasks') }}</span></a>
          </li>
          @if (today(); as day) {
            <li>
              <a routerLink="/me/attendance" class="tile" data-count="arrival"><strong>{{ day.arrival?.localTime ?? '–' }}</strong><span>{{ t('home.arrival') }}</span></a>
            </li>
            <li>
              <a routerLink="/me/attendance" class="tile" data-count="departure"><strong>{{ day.departure?.localTime ?? '–' }}</strong><span>{{ t('home.departure') }}</span></a>
            </li>
          }
          @if (annualBalance(); as balance) {
            <li>
              <a routerLink="/me/leave" class="tile" data-count="leave-balance"><strong>{{ balance.balance }}</strong><span>{{ t('home.annualBalance') }}</span></a>
            </li>
          }
        </ul>
      </section>

      @if (presence.hasValue()) {
        @let counts = presence.value().counts;
        <section class="panel" aria-labelledby="home-presence-title" data-card="presence">
          <h2 id="home-presence-title">{{ t('home.presenceToday') }}</h2>
          <ul class="counts">
            @for (status of presenceStatuses; track status) {
              <li>
                <a routerLink="/attendance" [queryParams]="{ status: status }" class="tile" [attr.data-count]="status"><strong>{{ counts[status] }}</strong><span>{{ t('attendance.status.' + status) }}</span></a>
              </li>
            }
          </ul>
        </section>
      }

      @if (headcount.hasValue() || leavePending.hasValue()) {
        <section class="panel" aria-labelledby="home-overview-title" data-card="overview">
          <h2 id="home-overview-title">{{ t('home.overview') }}</h2>
          <ul class="counts">
            @if (headcount.hasValue()) {
              <li>
                <a routerLink="/employees" class="tile" data-count="headcount"><strong>{{ headcount.value().total }}</strong><span>{{ t('home.headcount') }}</span></a>
              </li>
            }
            @if (leavePending.hasValue()) {
              <li>
                <a routerLink="/leave" [queryParams]="{ status: 'pending' }" class="tile" data-count="leave-pending"><strong>{{ leavePending.value().total }}</strong><span>{{ t('home.leavePending') }}</span></a>
              </li>
            }
          </ul>
        </section>
      }

      <!-- Recruitment counts: scoped by the API to what the caller may read; each one opens the filtered list. -->
      @if (summary.hasValue()) {
        @let s = summary.value();
        <section class="panel" aria-labelledby="home-recruitment-title" data-card="recruitment">
          <h2 id="home-recruitment-title">{{ t('nav.recruitment') }}</h2>
          <ul class="counts">
            <li>
              <a routerLink="/recruitment" [queryParams]="{ status: 'pending' }" data-count="pending" class="tile"><strong>{{ s.openings.pending }}</strong><span>{{ t('recruitment.status.pending') }}</span></a>
            </li>
            <li>
              <a routerLink="/recruitment" [queryParams]="{ status: 'open' }" data-count="open" class="tile"><strong>{{ s.openings.open }}</strong><span>{{ t('recruitment.home.open') }}</span></a>
            </li>
            @for (stage of stages; track stage) {
              <li>
                <a routerLink="/recruitment/candidates" [queryParams]="{ stage: stage }" [attr.data-count]="stage" class="tile"><strong>{{ s.applications[stage] }}</strong><span>{{ t('recruitment.home.stage.' + stage) }}</span></a>
              </li>
            }
            <li data-count="interviews-next" class="tile tile--static"><strong>{{ s.interviewsNext7Days }}</strong><span>{{ t('recruitment.home.interviewsNext7Days') }}</span></li>
            <li>
              <a routerLink="/recruitment/candidates" [queryParams]="{ stage: 'offer' }" data-count="offers-pending" class="tile"><strong>{{ s.offersPending }}</strong><span>{{ t('recruitment.home.offersPending') }}</span></a>
            </li>
          </ul>
        </section>
      }
      @if (mine.showNav()) {
        <p class="panel" data-card="my-recruitment">
          <a routerLink="/me/recruitment" class="action">{{ t('nav.myRecruitment') }}</a>
          <span class="action-note">{{ t('recruitment.home.minePending', { count: pending() }) }}</span>
        </p>
      }
      @if (mine.showInterviewsNav()) {
        <p class="panel" data-card="my-interviews">
          <a routerLink="/me/interviews" class="action">{{ t('recruitment.home.interviewsLink', { count: mine.interviews() }) }}</a>
          <!-- Two different counts: interviews assigned to the caller, and evaluations that can be entered now
               (an upcoming interview is listed but cannot be evaluated before its time). -->
          <span class="action-note" data-count="evaluations-todo">
            {{ mine.evaluationsTodo() > 0 ? t('recruitment.home.evaluationsTodo', { count: mine.evaluationsTodo() }) : t('recruitment.home.evaluationsNone') }}
          </span>
        </p>
      }
    </ng-container>
  `,
  styles: `
    .welcome { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); margin-block-end: var(--space-4); }
    .welcome-text { flex: 1; min-inline-size: min(16rem, 100%); }
    .welcome h1 { margin-block-end: var(--space-2); overflow-wrap: anywhere; }
    .intro { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
    .company-logo { flex: none; inline-size: auto; block-size: auto; max-block-size: 4rem; max-inline-size: min(12rem, 100%); object-fit: contain; }
    .counts { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .counts li { display: flex; }
    /* A count as a tile: the number above its label; the whole tile is the link. */
    .tile { display: flex; flex: 1; flex-direction: column; gap: var(--space-1); padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface-alt); color: var(--color-text); text-decoration: none; line-height: 1.3; }
    .tile strong { color: var(--color-primary); font-size: 1.75rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
    .tile span { color: var(--color-text-muted); font-size: 0.9rem; }
    a.tile { border-inline-start: 3px solid var(--color-primary); transition: background-color 0.12s, border-color 0.12s, box-shadow 0.12s; }
    a.tile:hover { border-color: var(--color-primary); background: var(--color-hover); box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
    a.tile:hover span { color: var(--color-text); }
    .action { display: inline-block; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-primary); border-radius: var(--radius); color: var(--color-primary); font-weight: 600; text-decoration: none; }
    .action:hover { background: var(--color-primary); color: var(--color-on-primary); }
    .action-note { margin-inline-start: var(--space-2); color: var(--color-text-muted); }
    @media (prefers-reduced-motion: reduce) { a.tile { transition: none; } }
  `,
})
export class HomePage {
  protected readonly session = inject(Session);
  protected readonly branding = inject(BrandingService);
  private readonly me = inject(MyEmployment);
  private readonly attendance = inject(AttendanceApi);
  private readonly leave = inject(LeaveApi);
  protected readonly tasks = inject(TasksBadge);

  // Self-service figures need the permission AND a linked employment (as the « Pointage » and « Mes congés » pages).
  private readonly canPunch = computed(() => this.session.can(ATTENDANCE_SELF_SERVICE_PERMISSION) && this.me.linked() === true);
  private readonly canRequestLeave = computed(() => this.session.can(SELF_SERVICE_PERMISSION) && this.me.linked() === true);
  private readonly myDays = this.attendance.myDaysResource(() => (this.canPunch() ? {} : undefined));
  private readonly myBalances = this.leave.myBalancesResource(() => this.canRequestLeave());
  /** No dates sent: the API answers with today (Algiers). */
  protected readonly today = computed(() => (this.myDays.hasValue() ? this.myDays.value().items.at(-1) : undefined));
  protected readonly annualBalance = computed(() =>
    this.myBalances.hasValue() ? this.myBalances.value().items.find((item) => item.leaveTypeCode === 'annual') : undefined,
  );

  // HR figures: one small page each, read for its counts/total only; the API scopes them to what the caller may read.
  protected readonly presenceStatuses: readonly BoardStatus[] = ['present', 'late', 'absent', 'expected', 'on_leave'];
  protected readonly presence = this.attendance.presenceResource(() =>
    this.session.can('attendance.read') ? { ...DEFAULT_PRESENCE_QUERY, pageSize: 1 } : undefined,
  );
  protected readonly headcount = inject(EmployeesApi).listResource(() =>
    this.session.can('employee.read') ? { ...DEFAULT_EMPLOYEE_QUERY, pageSize: 1 } : undefined,
  );
  protected readonly leavePending = this.leave.listResource(() =>
    this.session.can('leave.read') ? { ...DEFAULT_LEAVE_QUERY, status: 'pending', pageSize: 1 } : undefined,
  );
  protected readonly mine = inject(MyRecruitment);
  protected readonly summary = inject(RecruitmentApi).summaryResource(() => this.session.can(RECRUITMENT_READ));
  protected readonly pending = computed(() => this.mine.summary()?.pendingOpenings ?? 0);
  protected readonly stages = ACTIVE_STAGES;
}
