/**
 * Values of the fields HR types when issuing a designed document (docs/contracts/document-templates.md › Issuing):
 * checks and formatting. Pure: no Nest, no Kysely.
 */
import { dateText } from './snapshot.js';
import { stripBidiControls, type LayoutError, type TemplateField } from './template-layout.js';
import type { DocumentLanguage } from './types.js';

const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const NUMBER = /^-?\d{1,12}([.,]\d{1,4})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_LF = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

export const FIELD_TEXT_MAX = 500;
export const FIELD_LONG_TEXT_MAX = 2_000;

function realDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

/**
 * The values typed at issue time against the template's fields: unknown keys, missing required ones, values of the
 * wrong kind → errors on `fields.<key>`. Returns the cleaned values (trimmed, bidi controls removed, empty optional
 * ones left out; a number with a comma is stored with a dot).
 */
export function checkFieldValues(fields: readonly TemplateField[], input: Record<string, unknown> | undefined): { values: Record<string, string>; errors: LayoutError[] } {
  const errors: LayoutError[] = [];
  const values: Record<string, string> = {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(input ?? {})) {
    if (!byKey.has(key)) errors.push({ field: `fields.${key}`, code: 'unknown_field', message: 'This template has no such field.' });
  }
  for (const field of fields) {
    const at = `fields.${field.key}`;
    // own keys only: a field may be called `constructor`, which every object inherits
    const raw = input && Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      errors.push({ field: at, code: 'invalid_value', message: 'A text value is expected.' });
      continue;
    }
    const value = stripBidiControls(raw ?? '').trim();
    if (value === '') {
      if (field.required) errors.push({ field: at, code: 'required', message: 'Required.' });
      continue;
    }
    switch (field.kind) {
      case 'text':
        if (value.length > FIELD_TEXT_MAX || CONTROL.test(value)) {
          errors.push({ field: at, code: 'invalid_value', message: `At most ${FIELD_TEXT_MAX} characters on one line.` });
          continue;
        }
        break;
      case 'longText':
        if (value.length > FIELD_LONG_TEXT_MAX || CONTROL_EXCEPT_LF.test(value.replace(/\r\n/g, '\n'))) {
          errors.push({ field: at, code: 'invalid_value', message: `At most ${FIELD_LONG_TEXT_MAX} characters.` });
          continue;
        }
        values[field.key] = value.replace(/\r\n/g, '\n');
        continue;
      case 'date':
        if (!realDate(value)) {
          errors.push({ field: at, code: 'invalid_value', message: 'A date written YYYY-MM-DD.' });
          continue;
        }
        break;
      case 'number':
        if (!NUMBER.test(value)) {
          errors.push({ field: at, code: 'invalid_value', message: 'A number (up to 12 digits, 4 decimals).' });
          continue;
        }
        values[field.key] = value.replace(',', '.');
        continue;
      case 'choice':
        if (!field.options?.some((o) => o.value === value)) {
          errors.push({ field: at, code: 'invalid_value', message: 'One of the listed options.' });
          continue;
        }
        break;
    }
    values[field.key] = value;
  }
  return { values, errors };
}

/** The checked values as printed in `lang` (dates in words, the decimal comma in French, a choice's label). */
export function formatFieldValues(fields: readonly TemplateField[], values: Record<string, string>, lang: DocumentLanguage): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    if (value === undefined) {
      out[field.key] = null;
      continue;
    }
    switch (field.kind) {
      case 'date':
        out[field.key] = dateText(value, lang);
        break;
      case 'number':
        out[field.key] = lang === 'fr' ? value.replace('.', ',') : value;
        break;
      case 'choice':
        out[field.key] = field.options?.find((o) => o.value === value)?.labels[lang] ?? value;
        break;
      default:
        out[field.key] = value;
    }
  }
  return out;
}

/** Sample values of a preview with sample data: a value of each field's kind. */
export function sampleFieldValues(fields: readonly TemplateField[], lang: DocumentLanguage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    switch (field.kind) {
      case 'date':
        out[field.key] = '2026-10-15';
        break;
      case 'number':
        out[field.key] = '3';
        break;
      case 'choice':
        out[field.key] = field.options?.[0]?.value ?? '';
        break;
      default:
        out[field.key] = `${field.labels[lang]}`;
    }
  }
  return out;
}
