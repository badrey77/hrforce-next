/**
 * « Format d'export » tab of /payroll/settings: the layout, separators, encoding, header row, the columns as an
 * ordered pick list (up / down / remove, add from the columns the layout allows), the period format and the file
 * extension. The preview box shows the first lines of a file with the SAVED settings
 * (`GET /payroll/settings/preview`), reloaded after each save.
 */
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { PayrollApi } from '../../core/payroll/payroll-api';
import {
  allowedColumns,
  columnsProblem,
  DEFAULT_PAYROLL_SETTINGS,
  MAX_COLUMNS,
  PAYROLL_DECIMALS,
  PAYROLL_ENCODINGS,
  PAYROLL_EXTENSIONS,
  PAYROLL_LAYOUTS,
  PAYROLL_PERIOD_FORMATS,
  PAYROLL_SEPARATORS,
  type PayrollDecimalSeparator,
  type PayrollEncoding,
  type PayrollExtension,
  type PayrollLayout,
  type PayrollPeriodFormat,
  type PayrollSeparator,
  type PayrollSettings,
  type SettingsPreview,
} from '../../core/payroll/payroll.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { moveColumn, normalizeColumns, settingsProblemToForm } from './payroll-settings-forms';

@Component({
  selector: 'app-payroll-format-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './format-settings.html',
  styleUrl: './payroll-settings.css',
})
export class FormatSettings {
  private readonly api = inject(PayrollApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly layouts = PAYROLL_LAYOUTS;
  protected readonly separators = PAYROLL_SEPARATORS;
  protected readonly decimals = PAYROLL_DECIMALS;
  protected readonly encodings = PAYROLL_ENCODINGS;
  protected readonly periodFormats = PAYROLL_PERIOD_FORMATS;
  protected readonly extensions = PAYROLL_EXTENSIONS;
  protected readonly maxColumns = MAX_COLUMNS;

  protected readonly settings = this.api.settingsResource();
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly columnsServerError = signal<string | null>(null);

  protected readonly preview = signal<SettingsPreview | null>(null);
  protected readonly previewState = signal<'loading' | 'ready' | 'error'>('loading');

  protected readonly form = this.fb.group({
    layout: this.fb.control<PayrollLayout>(DEFAULT_PAYROLL_SETTINGS.layout),
    separator: this.fb.control<PayrollSeparator>(DEFAULT_PAYROLL_SETTINGS.separator),
    decimalSeparator: this.fb.control<PayrollDecimalSeparator>(DEFAULT_PAYROLL_SETTINGS.decimalSeparator),
    encoding: this.fb.control<PayrollEncoding>(DEFAULT_PAYROLL_SETTINGS.encoding),
    headerRow: this.fb.control(DEFAULT_PAYROLL_SETTINGS.headerRow),
    periodFormat: this.fb.control<PayrollPeriodFormat>(DEFAULT_PAYROLL_SETTINGS.periodFormat),
    fileExtension: this.fb.control<PayrollExtension>(DEFAULT_PAYROLL_SETTINGS.fileExtension),
  });

  protected readonly layout = signal<PayrollLayout>(DEFAULT_PAYROLL_SETTINGS.layout);
  protected readonly columns = signal<readonly string[]>(DEFAULT_PAYROLL_SETTINGS.columns);
  protected readonly available = computed(() => allowedColumns(this.layout()).filter((c) => !this.columns().includes(c)));
  protected readonly problem = computed(() => columnsProblem(this.layout(), this.columns()));
  /** Columns the layout requires: they cannot be removed. */
  protected readonly required = computed<readonly string[]>(() => (this.layout() === 'per_line' ? ['matricule', 'rubrique', 'value'] : ['matricule']));

  constructor() {
    effect(() => {
      if (!this.settings.hasValue()) return;
      const s = this.settings.value();
      this.form.reset({
        layout: s.layout,
        separator: s.separator,
        decimalSeparator: s.decimalSeparator,
        encoding: s.encoding,
        headerRow: s.headerRow,
        periodFormat: s.periodFormat,
        fileExtension: s.fileExtension,
      });
      this.layout.set(s.layout);
      this.columns.set(s.columns);
    });
    this.form.controls.layout.valueChanges.pipe(takeUntilDestroyed()).subscribe((layout) => {
      if (layout === this.layout()) return;
      this.layout.set(layout);
      this.columns.set(normalizeColumns(layout, this.columns()));
      this.columnsServerError.set(null);
    });
    this.loadPreview();
  }

  protected loadPreview(): void {
    this.previewState.set('loading');
    this.api
      .getPreview()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (preview) => {
          this.preview.set(preview);
          this.previewState.set('ready');
        },
        error: () => this.previewState.set('error'),
      });
  }

  protected move(index: number, delta: -1 | 1): void {
    this.columns.set(moveColumn(this.columns(), index, delta));
    this.columnsServerError.set(null);
  }

  protected remove(column: string): void {
    this.columns.set(this.columns().filter((c) => c !== column));
    this.columnsServerError.set(null);
  }

  protected add(column: string): void {
    if (this.columns().length >= MAX_COLUMNS || this.columns().includes(column)) return;
    this.columns.set([...this.columns(), column]);
    this.columnsServerError.set(null);
  }

  protected save(): void {
    this.formError.set(null);
    this.feedback.set(null);
    if (!this.settings.hasValue() || this.problem()) return;
    const body: PayrollSettings = { ...this.settings.value(), ...this.form.getRawValue(), columns: [...this.columns()] };
    this.saving.set(true);
    this.api.updateSettings(body).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('payroll.settings.saved');
        this.settings.reload();
        this.loadPreview();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(settingsProblemToForm(this.form, error, (key) => this.columnsServerError.set(key)));
      },
    });
  }
}
