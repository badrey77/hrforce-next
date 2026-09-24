import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJsonWithLines } from '../lib/json-lines.ts';
import { checkI18n, I18N_DIR, placeholders } from './i18n-parity.ts';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-i18n-'));
  temps.push(root);
  mkdirSync(path.join(root, I18N_DIR), { recursive: true });
  for (const [lang, content] of Object.entries(files)) {
    writeFileSync(path.join(root, I18N_DIR, `${lang}.json`), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}
const summary = (root: string) => checkI18n(root).violations.map((v) => `${v.severity ?? 'error'} ${v.rule} ${v.file}:${v.line} ${v.message}`);

describe('i18n-parity', () => {
  it('passes when fr/ar match; en lagging is only a warning', () => {
    const root = fixture({
      fr: { a: { b: 'Bonjour {{name}}', c: 'x' } },
      ar: { a: { b: 'مرحبا {{ name }}', c: 'س' } },
      en: { a: { b: 'Hello {{name}}' } },
    });
    const result = checkI18n(root);
    expect(result.violations).toEqual([expect.objectContaining({ severity: 'warning', rule: 'i18n/lagging', line: 4 })]);
  });

  it('fails when fr and ar key sets differ (both directions), with file:line', () => {
    const root = fixture({
      fr: { nav: { home: 'Accueil', settings: 'Paramètres' } },
      ar: { nav: { home: 'الرئيسية', extra: 'زائد' } },
      en: { nav: { home: 'Home', settings: 'Settings' } },
    });
    expect(summary(root)).toEqual([
      `error i18n/parity ${I18N_DIR}/fr.json:4 "nav.settings" exists in fr but is missing from ar (${I18N_DIR}/ar.json)`,
      `error i18n/parity ${I18N_DIR}/ar.json:4 "nav.extra" exists in ar but is missing from fr (${I18N_DIR}/fr.json)`,
    ]);
  });

  it('fails on empty strings, non-string leaves and placeholder mismatches', () => {
    const root = fixture({
      fr: { a: '  ', b: 'Bonjour {{name}}', c: ['x'], d: 'Total: {{count}}' },
      ar: { a: 'أ', b: 'مرحبا {{user}}', c: 'ج', d: 'المجموع' },
      en: { a: 'A', b: 'Hello {{name}}', c: 'C', d: 'Total: {{count}} {{extra}}' },
    });
    expect(summary(root)).toEqual([
      `error i18n/empty ${I18N_DIR}/fr.json:2 "a" is an empty string`,
      `error i18n/leaf-type ${I18N_DIR}/fr.json:4 "c" must be a string (got array)`,
      `error i18n/placeholders ${I18N_DIR}/ar.json:3 "b" placeholders differ: fr has {name}, ar has {user}`,
      `error i18n/placeholders ${I18N_DIR}/ar.json:5 "d" placeholders differ: fr has {count}, ar has {}`,
      `error i18n/placeholders ${I18N_DIR}/en.json:5 "d" placeholders differ: fr has {count}, en has {count, extra}`,
    ]);
  });

  it('reports invalid JSON and missing files', () => {
    const root = fixture({ fr: '{ "a": ', en: {} });
    expect(summary(root)).toEqual([
      expect.stringMatching(/error i18n\/invalid-json .*fr\.json/),
      expect.stringMatching(/error i18n\/missing-file .*ar\.json/),
    ]);
  });

  it('placeholders() and parseJsonWithLines() helpers', () => {
    expect(placeholders('{{ b }} and {{a}} and {{b}}')).toEqual(['a', 'b']);
    const { lines } = parseJsonWithLines('{\n  "a": {\n    "b": "x\\"y",\n    "c": [1, {"d": 2}]\n  },\n  "e": ""\n}');
    expect(Object.fromEntries(lines)).toEqual({ a: 2, 'a.b': 3, 'a.c': 4, 'a.c[1].d': 4, e: 6 });
  });
});
