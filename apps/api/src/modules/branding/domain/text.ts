import { BRANDING_MAX_LINES, BRANDING_TEXT_FIELDS, isBrandColor, LANGS, type BrandColor, type BrandingTextField, type Lang3 } from './types.js';

/**
 * Text rules of the branding settings (docs/contracts/branding.md › Text rules). Pure.
 *
 * Every text is DATA: it is stored as typed (`<`, `>`, `&`, `"` included — nothing is HTML-escaped at rest) and the
 * web renders it by interpolation only. What is removed here is what could change how the SURROUNDING page reads:
 * control characters, zero-width characters, and the bidi marks and overrides (an RTL override in a footer would
 * mirror the text next to it — the same reason documents strip them from printed data).
 */

// C0 except LF (handled per field), DEL, C1
// oxlint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
/** U+200B zero-width space, U+FEFF BOM, the bidi marks U+200E U+200F U+061C, the embeddings / overrides / isolates. */
const INVISIBLE = /[​﻿‎‏؜‪-‮⁦-⁩]/g;

/** Half of a surrogate pair (not valid text: it would be stored as U+FFFD). */
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * 1. NFC; CRLF / CR → LF; tab → space.
 * 2. Controls (C0, DEL, C1), U+200B, U+FEFF and the bidi marks and controls are removed; U+200C / U+200D are kept
 *    (Arabic-script shaping).
 * 3. Single-line: LF → space. Multi-line: spaces around a line break are dropped, three or more LF → two.
 * 4. Runs of spaces → one; trimmed; empty → null.
 * The length rule (code points) and the line limit are {@link validateBrandingTexts}'.
 */
export function cleanBrandingText(value: string | null | undefined, multiline: boolean): string | null {
  if (value === null || value === undefined) return null;
  let text = value
    .replace(LONE_SURROGATES, '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROLS, '')
    .replace(INVISIBLE, '');
  if (multiline) {
    text = text
      .replace(/ +/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^[ \n]+|[ \n]+$/g, '');
  } else {
    text = text.replace(/\n/g, ' ').replace(/ +/g, ' ').trim();
  }
  return text === '' ? null : text;
}

/** Length in Unicode code points (what Postgres' char_length counts), not UTF-16 units. */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export interface BrandingFieldError {
  field: string;
  code: 'too_long' | 'too_many_lines' | 'fr_required' | 'invalid_color';
  message: string;
}

/**
 * Cleans the given fields and checks them: `too_long` / `too_many_lines` on `<name>.<lang>`, `fr_required` on
 * `<name>.fr` when Arabic or English is set without French. Returns the cleaned values with the errors.
 */
export function validateBrandingTexts<F extends BrandingTextField>(input: Record<F, Lang3>): { values: Record<F, Lang3>; errors: BrandingFieldError[] } {
  const errors: BrandingFieldError[] = [];
  const values = {} as Record<F, Lang3>;
  for (const name of Object.keys(input) as F[]) {
    const rule = BRANDING_TEXT_FIELDS[name];
    const cleaned: Lang3 = { fr: null, ar: null, en: null };
    for (const lang of LANGS) {
      const text = cleanBrandingText(input[name][lang], rule.multiline);
      cleaned[lang] = text;
      if (text === null) continue;
      if (codePointLength(text) > rule.max) {
        errors.push({ field: `${name}.${lang}`, code: 'too_long', message: `At most ${rule.max} characters.` });
      } else if (rule.multiline && text.split('\n').length > BRANDING_MAX_LINES) {
        errors.push({ field: `${name}.${lang}`, code: 'too_many_lines', message: `At most ${BRANDING_MAX_LINES} lines.` });
      }
    }
    if (cleaned.fr === null && (cleaned.ar !== null || cleaned.en !== null)) {
      errors.push({ field: `${name}.fr`, code: 'fr_required', message: 'French is required as soon as another language is filled.' });
    }
    values[name] = cleaned;
  }
  return { values, errors };
}

/** A palette code (or null where the level may inherit); anything else → `invalid_color` on `color`. */
export function validateBrandColor(value: string | null, nullable: boolean): { color: BrandColor | null; error?: BrandingFieldError } {
  if (value === null && nullable) return { color: null };
  if (isBrandColor(value)) return { color: value };
  return { color: null, error: { field: 'color', code: 'invalid_color', message: 'Unknown colour code.' } };
}
