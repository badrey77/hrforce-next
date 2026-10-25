/**
 * `<app-profile-request-diff [request]="r" />` — what a profile change request changes (profile-changes contract ›
 * Self-service requests): one row per changed field with the section's value when the request was made (« Avant ») and
 * the requested one (« Après »), the children list compared child by child, the note of an error report, the
 * employee's comment, the rejection comment, the « modifié depuis la demande » warning and the supporting files (each
 * opened in a new tab). Used by the task panel in « Mes tâches » and the HR lists. Values come from the API as the
 * viewer may see them (the RIB masked unless the viewer holds `employee.bank.read`).
 * `filesFrom="me"` links the files through `/me/profile/requests/…` (the requester), else through the HR routes.
 */
import { formatDate } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { MY_PROFILE_BASE, PROFILE_REQUESTS_BASE } from '../../core/profile/profile-api';
import type { ProfileRequestView } from '../../core/profile/profile.models';
import { wilayaLabel } from '../../core/profile/wilayas';
import { FileSizePipe } from '../file-size/file-size.pipe';

/** A value as shown: a translation key, or text (`dir` for phone numbers and codes). */
export type DiffValue = { readonly key: string } | { readonly text: string; readonly ltr?: boolean } | null;

interface ChildLike {
  readonly id?: string;
  readonly firstName?: string;
  readonly birthDate?: string;
  readonly sex?: 'M' | 'F' | null;
  readonly dependent?: boolean;
}

export interface ChildDiffRow {
  readonly key: string;
  readonly before: ChildLike | null;
  readonly after: ChildLike | null;
  readonly state: 'added' | 'removed' | 'changed' | 'same';
}

const DATE_FIELDS = new Set(['maritalStatusSince', 'birthDate']);
const LTR_FIELDS = new Set(['mobilePhone', 'otherPhone', 'phone', 'personalEmail', 'postalCode', 'rib']);
const ENUM_PREFIX: Readonly<Record<string, string>> = {
  relationship: 'personal.relationship.',
  maritalStatus: 'personal.maritalStatus.',
  spouseEmployed: 'personal.spouseEmployed.',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function childrenOf(value: unknown): ChildLike[] {
  const children = record(value)?.['children'];
  return Array.isArray(children) ? (children as ChildLike[]) : [];
}

function sameChild(a: ChildLike, b: ChildLike): boolean {
  return a.firstName === b.firstName && a.birthDate === b.birthDate && (a.sex ?? null) === (b.sex ?? null) && a.dependent === b.dependent;
}

/** Children before / after, matched by id: rows without an id were added, ids that disappeared were removed. */
export function childDiff(before: unknown, after: unknown): ChildDiffRow[] {
  const old = childrenOf(before);
  const next = childrenOf(after);
  const rows: ChildDiffRow[] = [];
  next.forEach((child, index) => {
    const previous = child.id ? old.find((o) => o.id === child.id) : undefined;
    if (!previous) rows.push({ key: child.id ?? `new-${index}`, before: null, after: child, state: 'added' });
    else rows.push({ key: child.id ?? `new-${index}`, before: previous, after: child, state: sameChild(previous, child) ? 'same' : 'changed' });
  });
  for (const child of old) {
    if (!next.some((n) => n.id !== undefined && n.id === child.id)) rows.push({ key: child.id ?? child.firstName ?? '', before: child, after: null, state: 'removed' });
  }
  return rows;
}

@Component({
  selector: 'app-profile-request-diff',
  imports: [TranslocoDirective, FileSizePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let r = request();
      @if (r.changedSince && r.status === 'pending') {
        <p class="warning" role="note" data-state="changed-since">{{ t('personal.diff.changedSince') }}</p>
      }
      @if (r.section === 'identity_note') {
        <h4 class="diff-heading">{{ t('personal.diff.note') }}</h4>
        <p class="prose" data-field="note"><bdi>{{ note() }}</bdi></p>
      } @else {
        <div class="table-scroll diff-frame">
          <table class="data diff" data-table="diff">
            <caption class="visually-hidden">{{ t('personal.diff.caption') }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ t('personal.diff.field') }}</th>
                <th scope="col">{{ t('personal.diff.before') }}</th>
                <th scope="col">{{ t('personal.diff.after') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (field of flatFields(); track field) {
                <tr [attr.data-diff]="field">
                  <th scope="row">{{ t('personal.fields.' + field) }}</th>
                  @for (side of [beforeOf(field), afterOf(field)]; track $index) {
                    <td [class.after]="$index === 1" [attr.data-label]="t($index === 1 ? 'personal.diff.after' : 'personal.diff.before')">
                      @if (side === null) {
                        <span class="muted">—</span>
                      } @else if ('key' in side) {
                        {{ t(side.key) }}
                      } @else {
                        <bdi [attr.dir]="side.ltr ? 'ltr' : 'auto'">{{ side.text }}</bdi>
                      }
                    </td>
                  }
                </tr>
              }
              @for (row of children(); track row.key) {
                <tr [attr.data-child-diff]="row.state">
                  <th scope="row">
                    {{ t('personal.fields.children') }}
                    @if (row.state === 'added' || row.state === 'removed') {
                      <span class="tag" [attr.data-state]="row.state">{{ t(row.state === 'added' ? 'personal.diff.childAdded' : 'personal.diff.childRemoved') }}</span>
                    }
                  </th>
                  <td [attr.data-label]="t('personal.diff.before')">
                    @if (row.before; as c) {
                      @for (part of childParts(c, (c.sex ? t('personal.childSex.' + c.sex) : ''), t(c.dependent ? 'personal.dependent.yes' : 'personal.dependent.no')); track $index) {
                        @if (!$first) { · }<bdi>{{ part }}</bdi>
                      }
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td class="after" [attr.data-label]="t('personal.diff.after')">
                    @if (row.after; as c) {
                      @for (part of childParts(c, (c.sex ? t('personal.childSex.' + c.sex) : ''), t(c.dependent ? 'personal.dependent.yes' : 'personal.dependent.no')); track $index) {
                        @if (!$first) { · }<bdi>{{ part }}</bdi>
                      }
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                </tr>
              }
              @if (flatFields().length === 0 && children().length === 0) {
                <tr>
                  <td colspan="3" class="muted">{{ t('personal.diff.noChange') }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (ribMasked()) {
          <p class="field-hint" data-state="rib-masked">{{ t('personal.diff.ribMasked') }}</p>
        }
      }
      @if (r.comment) {
        <h4 class="diff-heading">{{ t('personal.diff.comment') }}</h4>
        <p class="prose" data-field="comment"><bdi>{{ r.comment }}</bdi></p>
      }
      @if (r.rejectionComment) {
        <h4 class="diff-heading">{{ t('personal.diff.rejection') }}</h4>
        <p class="prose" data-field="rejection"><bdi>{{ r.rejectionComment }}</bdi></p>
      }
      @if (r.section !== 'identity_note' || r.files.length) {
        <h4 class="diff-heading">{{ t('personal.diff.files') }}</h4>
        <ul class="diff-files" data-list="files">
          @for (f of r.files; track f.id) {
            <li [attr.data-file]="f.id">
              @if (f.purged) {
                <span class="muted">{{ t('personal.diff.filePurged', { name: f.filename }) }}</span>
              } @else {
                <a [href]="fileUrl(f.id)" target="_blank" rel="noopener" [attr.aria-label]="t('personal.diff.fileOpen', { name: f.filename })"><bdi>{{ f.filename }}</bdi></a>
                <span class="muted"> · {{ f.sizeBytes | fileSize: lang() }}</span>
              }
            </li>
          } @empty {
            <li class="muted">{{ t('personal.diff.noFiles') }}</li>
          }
        </ul>
      }
    </ng-container>
  `,
  styles: `
    :host { display: block; }
    .diff th[scope='row'] { font-weight: 600; text-align: start; vertical-align: top; }
    .diff td.after { font-weight: 600; }
    .diff-heading { margin-block: var(--space-3) var(--space-1); font-size: 1rem; }
    .diff-files { margin: 0; padding-inline-start: var(--space-4); }
    .prose { white-space: pre-line; overflow-wrap: anywhere; }
    .tag {
      display: inline-block; margin-inline-start: var(--space-1); padding-inline: var(--space-2);
      border: 1px solid var(--color-border); border-radius: 999px; font-size: 0.75rem; font-weight: 400; line-height: 1.6;
    }
    tr[data-child-diff='same'] td { color: var(--color-text-muted); font-weight: 400; }
    /* A narrow panel (phones): one block per field, « Avant » / « Après » named on each value, nothing to scroll. */
    .diff-frame { container-type: inline-size; }
    @container (max-width: 520px) {
      .diff thead { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
      .diff, .diff tbody, .diff tr, .diff th[scope='row'], .diff td { display: block; inline-size: auto; }
      .diff tr { padding-block: var(--space-2); border-block-end: 1px solid var(--color-border); }
      .diff th[scope='row'], .diff td { border: 0; padding-block: var(--space-1); }
      .diff td[data-label]::before { content: attr(data-label) ' : '; font-weight: 400; color: var(--color-text-muted); }
      .diff td[colspan] { display: block; }
    }
  `,
})
export class ProfileRequestDiff {
  protected readonly lang = inject(LanguageService).current;
  private readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly request = input.required<ProfileRequestView>();
  /** Whose file routes to link: the HR ones (task candidates, `employee.personal.read`) or the requester's own. */
  readonly filesFrom = input<'hr' | 'me'>('hr');

  protected readonly flatFields = computed(() => this.request().changedFields.filter((f) => f !== 'children' && f !== 'note'));
  protected readonly children = computed(() => {
    const r = this.request();
    return r.section === 'family' && r.changedFields.includes('children') ? childDiff(r.before, r.payload) : [];
  });
  protected readonly note = computed(() => {
    const note = record(this.request().payload)?.['note'];
    return typeof note === 'string' ? note : '';
  });
  protected readonly ribMasked = computed(() => {
    const r = this.request();
    if (r.section !== 'bank') return false;
    const rib = record(r.payload)?.['rib'];
    return typeof rib === 'string' && /[^0-9\s]/.test(rib);
  });

  protected beforeOf(field: string): DiffValue {
    return this.format(field, record(this.request().before)?.[field]);
  }

  protected afterOf(field: string): DiffValue {
    return this.format(field, record(this.request().payload)?.[field]);
  }

  protected format(field: string, value: unknown): DiffValue {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return { key: value ? 'personal.spouseEmployed.yes' : 'personal.spouseEmployed.no' };
    const text = String(value);
    const prefix = ENUM_PREFIX[field];
    if (prefix) return { key: prefix + text };
    if (field === 'wilayaCode') return { text: wilayaLabel(text, this.lang()) };
    if (DATE_FIELDS.has(field)) return { text: this.date(text) };
    return { text, ltr: LTR_FIELDS.has(field) };
  }

  /**
   * « Lina », « 1 sept. 2026 », « Fille », « À charge » — labels translated by the template, which isolates each part
   * (`<bdi>`): a Latin first name next to an Arabic date otherwise reorders the date's digits in RTL.
   */
  protected childParts(child: ChildLike, sex: string, dependent: string): string[] {
    const parts = [child.firstName ?? ''];
    if (child.birthDate) parts.push(this.date(child.birthDate));
    if (child.sex) parts.push(sex);
    parts.push(dependent);
    return parts;
  }

  protected fileUrl(fileId: string): string {
    const r = this.request();
    const base = this.filesFrom() === 'me' ? `${MY_PROFILE_BASE}/requests` : PROFILE_REQUESTS_BASE;
    return `${base}/${encodeURIComponent(r.id)}/files/${encodeURIComponent(fileId)}`;
  }

  private date(value: string): string {
    try {
      return formatDate(value, 'mediumDate', this.locale());
    } catch {
      return value;
    }
  }
}
