/**
 * Document numbers (docs/contracts/documents.md › Numbering). Pure: no Nest, no Kysely.
 *
 * A format is literal characters `[A-Z0-9/_.-]` and the tokens `{YYYY}` (4-digit year), `{YY}` (2 digits), `{SEQ}` or
 * `{SEQ:n}` (n = 1–9: zero-padded to at least n digits; larger numbers simply grow). Exactly one `{SEQ…}`, at least
 * one year token, at most 40 characters once rendered. The counter is per company × type × calendar year of the issue
 * date, so every format must name the year (two types or two years never produce the same number by construction —
 * except for formats crafted to collide, which the unique index on the number catches: 409 document-number-taken).
 */

type Part = { kind: 'literal'; text: string } | { kind: 'yyyy' } | { kind: 'yy' } | { kind: 'seq'; width: number };

export const NUMBER_MAX_LENGTH = 40;
/** The rendered length is checked with a sequence number of this many digits (room to grow). */
const CHECK_DIGITS = 5;

const TOKEN = /\{(YYYY|YY|SEQ(?::([1-9]))?)\}/g;
const LITERAL = /^[A-Z0-9/_.-]*$/;

/** The parts of a valid format, or null when it is invalid. */
export function parseNumberFormat(format: string): Part[] | null {
  if (format.length === 0 || format.length > 60) return null;
  const parts: Part[] = [];
  let last = 0;
  for (const match of format.matchAll(TOKEN)) {
    const literal = format.slice(last, match.index);
    if (!LITERAL.test(literal)) return null;
    if (literal) parts.push({ kind: 'literal', text: literal });
    const token = match[1] ?? '';
    if (token === 'YYYY') parts.push({ kind: 'yyyy' });
    else if (token === 'YY') parts.push({ kind: 'yy' });
    else parts.push({ kind: 'seq', width: match[2] ? Number(match[2]) : 1 });
    last = (match.index ?? 0) + match[0].length;
  }
  const tail = format.slice(last);
  if (!LITERAL.test(tail)) return null;
  if (tail) parts.push({ kind: 'literal', text: tail });
  if (parts.filter((p) => p.kind === 'seq').length !== 1) return null;
  if (!parts.some((p) => p.kind === 'yyyy' || p.kind === 'yy')) return null;
  if (render(parts, 2026, 10 ** (CHECK_DIGITS - 1)).length > NUMBER_MAX_LENGTH) return null;
  return parts;
}

export function isValidNumberFormat(format: string): boolean {
  return parseNumberFormat(format) !== null;
}

function render(parts: readonly Part[], year: number, seq: number | null): string {
  return parts
    .map((p) => {
      switch (p.kind) {
        case 'literal':
          return p.text;
        case 'yyyy':
          return String(year).padStart(4, '0');
        case 'yy':
          return String(year % 100).padStart(2, '0');
        case 'seq':
          return seq === null ? '…' : String(seq).padStart(p.width, '0');
      }
    })
    .join('');
}

function partsOf(format: string): Part[] {
  const parts = parseNumberFormat(format);
  if (!parts) throw new Error(`invalid number format: ${format}`);
  return parts;
}

/** ATT-{YYYY}-{SEQ:5}, 2026, 42 → ATT-2026-00042. */
export function formatNumber(format: string, year: number, seq: number): string {
  return render(partsOf(format), year, seq);
}

/** The number a preview shows: the sequence replaced by an ellipsis (ATT-2026-…). */
export function specimenNumber(format: string, year: number): string {
  return render(partsOf(format), year, null);
}
