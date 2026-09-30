/**
 * Settings › Bornes — the entrance kiosks (docs/contracts/attendance.md › Settings › Bornes, ADR 009 §1): a table
 * (label, site, status, last seen "il y a 2 min", allowed networks), "Nouvelle borne" → a large one-time PAIRING CODE
 * with its expiry countdown and the instructions for the tablet, "Nouveau code" (re-pair), edit (labels, site,
 * networks), revoke (final, with a reason), and the kiosk's history (timeline `attendance_device:<id>`, `audit.read`).
 *
 * The pairing code is shown ONCE: the API stores only its hash. Leaving the page loses it — "Nouveau code" makes
 * another (the paired tablet keeps working until the new code is used).
 *
 * Angular concepts:
 * - **A countdown as a signal fed by a timer**: while a code is on screen, `setInterval` writes `now` every second
 *   and the remaining time is a `computed()`; the interval is cleared when the code is dismissed or expires, and by
 *   `DestroyRef.onDestroy` if the page goes away first. The relative "last seen" times reuse the same `now` signal
 *   (`relativeTime` pure pipe with a `now` argument, chapter 16).
 * - **A modal `<dialog>` for a FINAL action** (revoke): `showModal()` makes the page inert; a required reason
 *   (3–500 characters) goes into the audit trail.
 * - **`@defer (on viewport)` for the history** (chapter 13): the timeline's code is downloaded only when a history
 *   panel is opened.
 * - **A textarea as a list** (allowed networks, one CIDR per line): the form keeps a string, `networksOf()` turns it
 *   into the API's array; the API validates each entry (422 `allowedNetworks.<i>`) and the error lands on the
 *   textarea.
 */
import { DatePipe, DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { formatPairingCode, kioskLabel, type KioskView, type PairingCodeView } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { isApiProblemError } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import { attendanceProblemToForm, reasonErrorKey, reasonValidator } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { RelativeTimePipe } from '../../shared/relative-time/relative-time.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { Timeline } from '../../shared/timeline/timeline';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';
import { KIOSK_SLUGS } from './settings-problems';

export const MAX_NETWORKS = 10;

/** Textarea → the API's list (one entry per line, blanks dropped). */
export function networksOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** "9:41" left of a code (mm:ss), from milliseconds. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly kiosk: KioskView };

@Component({
  selector: 'app-attendance-kiosks-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, RelativeTimePipe, RevealAlert, ControlError, Timeline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './kiosks-settings.html',
  styles: `
    .pairing { display: grid; gap: var(--space-2); justify-items: start; border-color: var(--color-primary); border-width: 2px; }
    .pairing-code { margin: 0; font-family: var(--font-mono); font-size: 2.5rem; font-weight: 700; letter-spacing: 0.15em; }
    .networks { margin: 0; padding: 0; list-style: none; font-family: var(--font-mono); font-size: 0.8125rem; }
    .field textarea { font-family: var(--font-mono); }
  `,
})
export class KiosksSettings {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canAudit = inject(Session).allows('audit.read');
  private readonly canSites = inject(Session).allows('site.read');
  /** The address to type on the tablet (same origin as this app). */
  protected readonly kioskUrl = `${inject(DOCUMENT).location.origin}/kiosk`;

  protected readonly list = this.api.kiosksResource();
  protected readonly kiosks = computed(() => (this.list.hasValue() ? this.list.value().items : []));
  private readonly sitesList = inject(OrgApi).sitesResource(() => undefined, this.canSites);
  protected readonly sites = computed(() => (this.sitesList.hasValue() ? this.sitesList.value().items : []));

  /**
   * Names for the kiosk history: the timeline shows `site_id` as the site ("CNE Constantine"), not its id. The
   * resolver reads signals, and the Timeline calls it inside a `computed()`, so the names appear once the sites load.
   */
  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    if (kind !== 'site') return undefined;
    const site = this.sites().find((s) => s.id === value) ?? this.kiosks().find((k) => k.site.id === value)?.site;
    return site ? `${site.code} ${site.name}` : undefined;
  };

  protected readonly editing = signal<Editing | null>(null);
  protected readonly history = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly maxNetworks = MAX_NETWORKS;

  protected readonly form = this.fb.group({
    siteId: ['', Validators.required],
    fr: ['', [Validators.required, Validators.maxLength(120)]],
    ar: ['', [Validators.required, Validators.maxLength(120)]],
    networks: [''],
  });

  // --- Pairing code and its countdown ------------------------------------------------------------------------------

  protected readonly pairing = signal<{ readonly kiosk: string; readonly code: PairingCodeView } | null>(null);
  protected readonly now = signal(Date.now());
  private ticker: ReturnType<typeof setInterval> | undefined;
  protected readonly remaining = computed(() => {
    const pairing = this.pairing();
    return pairing ? Date.parse(pairing.code.expiresAt) - this.now() : 0;
  });
  protected readonly countdown = computed(() => countdown(this.remaining()));
  protected readonly formatCode = formatPairingCode;

  constructor() {
    this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(this.ticker));
  }

  protected label(kiosk: KioskView): string {
    return kioskLabel(kiosk.labels, this.lang());
  }

  protected showPairing(kiosk: KioskView, code: PairingCodeView): void {
    this.now.set(Date.now());
    this.pairing.set({ kiosk: this.label(kiosk), code });
  }

  protected dismissPairing(): void {
    this.pairing.set(null);
  }

  // --- Create / edit ------------------------------------------------------------------------------------------------

  protected open(editing: Editing): void {
    this.feedback.set(null);
    this.formError.set(null);
    if (editing.kind === 'new') {
      this.form.reset({ siteId: this.sites()[0]?.id ?? '', fr: '', ar: '', networks: '' });
    } else {
      const k = editing.kiosk;
      this.form.reset({ siteId: k.site.id, fr: k.labels.fr, ar: k.labels.ar, networks: k.allowedNetworks.join('\n') });
    }
    this.editing.set(editing);
  }

  protected submit(): void {
    const editing = this.editing();
    this.formError.set(null);
    if (!editing) return;
    const networks = networksOf(this.form.controls.networks.value);
    if (networks.length > MAX_NETWORKS) this.form.controls.networks.setErrors({ tooMany: { max: MAX_NETWORKS } });
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const body = { siteId: v.siteId, labels: { fr: v.fr.trim(), ar: v.ar.trim() }, allowedNetworks: networks };
    this.saving.set(true);
    if (editing.kind === 'new') {
      this.api.createKiosk(body).subscribe({
        next: (created) => {
          this.done('attendance.kiosks.created');
          this.showPairing(created.kiosk, created.pairing);
        },
        error: (error: unknown) => this.fail(error),
      });
    } else {
      this.api.updateKiosk(editing.kiosk.id, body).subscribe({
        next: () => this.done('attendance.kiosks.saved'),
        error: (error: unknown) => this.fail(error),
      });
    }
  }

  protected newCode(kiosk: KioskView): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.saving.set(true);
    this.api.newPairingCode(kiosk.id).subscribe({
      next: (code) => {
        this.done(null);
        this.showPairing(kiosk, code);
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  protected toggleHistory(kiosk: KioskView): void {
    this.history.update((id) => (id === kiosk.id ? null : kiosk.id));
  }

  // --- Revoke dialog ------------------------------------------------------------------------------------------------

  private readonly revokeDialog = viewChild.required<ElementRef<HTMLDialogElement>>('revokeDialog');
  protected readonly revoking = signal<KioskView | null>(null);
  protected readonly revokeError = signal<FormMessage | null>(null);
  protected readonly revokeForm = this.fb.group({ reason: ['', reasonValidator()] });
  protected readonly reasonErrorKey = reasonErrorKey;

  protected openRevoke(kiosk: KioskView): void {
    this.feedback.set(null);
    this.revokeError.set(null);
    this.revokeForm.reset({ reason: '' });
    this.revoking.set(kiosk);
    this.revokeDialog().nativeElement.showModal();
  }

  protected closeRevoke(): void {
    this.revokeDialog().nativeElement.close();
  }

  protected onRevokeClosed(): void {
    this.revoking.set(null);
    this.saving.set(false);
  }

  protected submitRevoke(): void {
    const kiosk = this.revoking();
    this.revokeError.set(null);
    if (!kiosk) return;
    if (this.revokeForm.invalid) {
      this.revokeForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    const request: Observable<unknown> = this.api.revokeKiosk(kiosk.id, this.revokeForm.getRawValue().reason.trim());
    request.subscribe({
      next: () => {
        this.closeRevoke();
        this.done('attendance.kiosks.revokedDone');
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.revokeError.set(attendanceProblemToForm(this.revokeForm, error, KIOSK_SLUGS));
        if (isApiProblemError(error) && error.status === 409) this.list.reload();
      },
    });
  }

  private fail(error: unknown): void {
    this.saving.set(false);
    // `allowedNetworks.<i>` → the textarea.
    const codes = Object.fromEntries(
      Array.from({ length: MAX_NETWORKS }, (_, i) => [`allowedNetworks.${i}:invalid`, { key: 'attendance.kiosks.networkInvalid', control: 'networks' }]),
    );
    this.formError.set(attendanceProblemToForm(this.form, error, KIOSK_SLUGS, codes));
  }

  private done(key: string | null): void {
    this.saving.set(false);
    this.editing.set(null);
    this.feedback.set(key);
    this.list.reload();
  }
}
