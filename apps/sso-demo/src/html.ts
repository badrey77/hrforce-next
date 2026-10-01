/**
 * A tiny HTML template helper (no template engine): the `html` tag escapes every interpolated value unless it is
 * already a {@link SafeHtml} built by this tag. Arrays are joined, `null`/`undefined`/`false` render nothing.
 * Every value that reaches a page (claims, names, error codes) goes through here.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);
}

export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map((v: HtmlValue) => render(v)).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}
