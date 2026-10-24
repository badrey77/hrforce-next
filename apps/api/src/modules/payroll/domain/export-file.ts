/**
 * The payroll export file (docs/contracts/payroll-variables.md › Export file) — pure: lines + settings → bytes.
 *
 * - `per_line`: one row per line (employee × rubrique × origin month), sorted matricule, rubrique order, origin month.
 *   `per_employee`: one row per (employee, origin month), the listed identity columns then one column per rubrique
 *   (active ones and any rubrique that has a line), in rubrique order, header = export code, empty cell for no value.
 * - Values: two decimals trimmed (`2`, `2,5`, `12,25`), the decimal separator setting, no thousands separator.
 * - Cells: a text cell starting with = + - @ TAB or CR gets a leading `'` (numbers never); a cell holding the
 *   separator, `"`, CR or LF is quoted, `"` doubled. CRLF after every row.
 * - Windows-1252 through an explicit table (Node's `latin1` is ISO-8859-1: € œ ’ … differ); what it cannot encode
 *   becomes `?`. Text is NFC-normalised first, so a decomposed « é » stays one character.
 * The same input always gives the same bytes (a closed month re-exports identically).
 */
import type { ExportColumn, PayrollSettings, PeriodFormat } from './settings.js';

export interface ExportLine {
  employeeId: string;
  /** the matricule the file prints (payroll matricule, else HRForce matricule) */
  matricule: string;
  lastName: string;
  firstName: string;
  unitCode: string | null;
  rubriqueId: string;
  exportCode: string;
  /** the rubrique's French name (the `label` column) */
  label: string;
  unit: 'days' | 'hours' | 'amount';
  sortOrder: number;
  /** `YYYY-MM` */
  originMonth: string;
  value: number;
}

export interface ExportRubrique {
  id: string;
  exportCode: string;
  sortOrder: number;
  active: boolean;
}

export type ExportFormat = Pick<PayrollSettings, 'layout' | 'separator' | 'decimalSeparator' | 'encoding' | 'headerRow' | 'columns' | 'periodFormat'>;

const SEPARATOR_CHAR = { semicolon: ';', comma: ',', tab: '\t', pipe: '|' } as const;
const UNIT_LABEL = { days: 'J', hours: 'H', amount: 'DA' } as const;

/** The header of each column key (French, ASCII). */
export const COLUMN_HEADERS: Readonly<Record<ExportColumn, string>> = {
  matricule: 'matricule',
  last_name: 'nom',
  first_name: 'prenom',
  rubrique: 'rubrique',
  label: 'libelle',
  value: 'valeur',
  unit: 'unite',
  period: 'periode',
  origin_period: 'periode_origine',
  unit_code: 'code_unite',
};

const FORMULA_START = /^[=+\-@\t\r]/;

/** `YYYY-MM` in the configured format. */
export function formatPeriod(month: string, format: PeriodFormat): string {
  const y = month.slice(0, 4);
  const m = month.slice(5, 7);
  switch (format) {
    case 'mm_yyyy':
      return `${m}/${y}`;
    case 'yyyymm':
      return `${y}${m}`;
    case 'yyyy_mm':
      return `${y}-${m}`;
  }
}

/** Two decimals trimmed, the decimal separator setting, a minus sign for negatives, no thousands separator. */
export function formatValue(value: number, decimal: 'comma' | 'dot'): string {
  let r = Math.round(Math.abs(value) * 100 + Number.EPSILON) / 100;
  if (!Number.isFinite(r)) r = 0;
  let text = r.toFixed(2).replace(/\.?0+$/, '');
  if (text === '') text = '0';
  if (value < 0 && text !== '0') text = `-${text}`;
  return decimal === 'comma' ? text.replace('.', ',') : text;
}

/** A text cell (formula-guarded) or an already formatted number (never prefixed). */
export type Cell = { text: string } | { number: string };

function cellText(cell: Cell, separator: string): string {
  let text: string;
  if ('number' in cell) text = cell.number;
  else text = FORMULA_START.test(cell.text) ? `'${cell.text}` : cell.text;
  const needsQuotes = text.includes(separator) || /["\r\n]/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function compareLines(a: ExportLine, b: ExportLine): number {
  return (
    byString(a.matricule, b.matricule) ||
    byString(a.employeeId, b.employeeId) ||
    a.sortOrder - b.sortOrder ||
    byString(a.exportCode, b.exportCode) ||
    byString(a.rubriqueId, b.rubriqueId) ||
    byString(a.originMonth, b.originMonth)
  );
}

/** The file's text (before encoding). `month` = the exported month `YYYY-MM`. */
export function exportText(format: ExportFormat, month: string, lines: readonly ExportLine[], rubriques: readonly ExportRubrique[]): string {
  const sep = SEPARATOR_CHAR[format.separator];
  const period = formatPeriod(month, format.periodFormat);
  const rows: Cell[][] = [];
  const identity = (l: ExportLine, column: ExportColumn): Cell => {
    switch (column) {
      case 'matricule':
        return { text: l.matricule };
      case 'last_name':
        return { text: l.lastName };
      case 'first_name':
        return { text: l.firstName };
      case 'unit_code':
        return { text: l.unitCode ?? '' };
      case 'period':
        return { text: period };
      case 'origin_period':
        return { text: formatPeriod(l.originMonth, format.periodFormat) };
      case 'rubrique':
        return { text: l.exportCode };
      case 'label':
        return { text: l.label };
      case 'value':
        return { number: formatValue(l.value, format.decimalSeparator) };
      case 'unit':
        return { text: UNIT_LABEL[l.unit] };
    }
  };
  const sorted = lines.filter((l) => l.value !== 0).toSorted(compareLines);

  if (format.layout === 'per_line') {
    if (format.headerRow) rows.push(format.columns.map((c) => ({ text: COLUMN_HEADERS[c] })));
    for (const l of sorted) rows.push(format.columns.map((c) => identity(l, c)));
  } else {
    // the rubrique columns: active rubriques and any rubrique that has a line, in order
    const columns = new Map<string, { id: string; exportCode: string; sortOrder: number }>();
    for (const r of rubriques) if (r.active) columns.set(r.id, r);
    for (const l of sorted) {
      if (columns.has(l.rubriqueId)) continue;
      const known = rubriques.find((r) => r.id === l.rubriqueId);
      columns.set(l.rubriqueId, known ?? { id: l.rubriqueId, exportCode: l.exportCode, sortOrder: l.sortOrder });
    }
    const ordered = [...columns.values()].toSorted((a, b) => a.sortOrder - b.sortOrder || byString(a.exportCode, b.exportCode) || byString(a.id, b.id));
    if (format.headerRow) rows.push([...format.columns.map((c) => ({ text: COLUMN_HEADERS[c] })), ...ordered.map((r) => ({ text: r.exportCode }))]);
    const groups = new Map<string, ExportLine[]>();
    for (const l of sorted) {
      const key = `${l.employeeId}|${l.originMonth}`;
      const group = groups.get(key);
      if (group) group.push(l);
      else groups.set(key, [l]);
    }
    const keys = [...groups.values()].toSorted((a, b) => {
      const x = a[0] as ExportLine;
      const y = b[0] as ExportLine;
      return byString(x.matricule, y.matricule) || byString(x.employeeId, y.employeeId) || byString(x.originMonth, y.originMonth);
    });
    for (const group of keys) {
      const first = group[0] as ExportLine;
      const values = new Map(group.map((l) => [l.rubriqueId, l.value]));
      rows.push([
        ...format.columns.map((c) => identity(first, c)),
        ...ordered.map((r): Cell => {
          const v = values.get(r.id);
          return v === undefined ? { number: '' } : { number: formatValue(v, format.decimalSeparator) };
        }),
      ]);
    }
  }
  return delimitedRows(rows, sep);
}

/** Rows joined with `separator`, CRLF after every row (quoting and formula guard per cell). */
export function delimitedRows(rows: readonly (readonly Cell[])[], separator: string): string {
  return rows.map((row) => row.map((c) => cellText(c, separator)).join(separator) + '\r\n').join('');
}

// ── encoding ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Windows-1252 bytes 0x80–0x9F (the five holes 0x81, 0x8D, 0x8F, 0x90, 0x9D are not assigned). */
const CP1252_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const QUESTION = 0x3f;

export function encodeWindows1252(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else out.push(CP1252_HIGH[cp] ?? QUESTION);
  }
  return Uint8Array.from(out);
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function encodeText(text: string, encoding: PayrollSettings['encoding']): Uint8Array {
  if (encoding === 'windows1252') return encodeWindows1252(text);
  const utf8 = new TextEncoder().encode(text.normalize('NFC'));
  if (encoding === 'utf8') return utf8;
  const out = new Uint8Array(utf8.length + UTF8_BOM.length);
  out.set(UTF8_BOM, 0);
  out.set(utf8, UTF8_BOM.length);
  return out;
}

/** The whole file: text and its bytes. */
export function buildExportFile(format: ExportFormat, month: string, lines: readonly ExportLine[], rubriques: readonly ExportRubrique[]): { text: string; bytes: Uint8Array } {
  const text = exportText(format, month, lines, rubriques);
  return { text, bytes: encodeText(text, format.encoding) };
}

/** `variables-paie-YYYY-MM[-<unit code>][-brouillon].<ext>` (the unit code reduced to safe characters). */
export function exportFilename(month: string, unitCode: string | null, draft: boolean, extension: 'csv' | 'txt'): string {
  const unit = unitCode ? `-${unitCode.replace(/[^A-Za-z0-9_-]/g, '_')}` : '';
  return `variables-paie-${month}${unit}${draft ? '-brouillon' : ''}.${extension}`;
}

/** `Content-Type` of the file. */
export function exportContentType(encoding: PayrollSettings['encoding']): string {
  return encoding === 'windows1252' ? 'text/csv; charset=windows-1252' : 'text/csv; charset=utf-8';
}
