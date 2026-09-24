/**
 * Guardrail: i18n-parity (CONVENTIONS.md › Web › Transloco).
 *  - fr and ar have identical nested key sets                       → error
 *  - en missing a key present in fr                                   → warning (en may lag)
 *  - en key absent from fr (stale)                                    → warning
 *  - every leaf is a non-empty string (no arrays/numbers/empty text)  → error
 *  - {{placeholders}} are the same set for a key in every language    → error
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJsonWithLines } from '../lib/json-lines.ts';
import { type GuardResult, isMain, REPO_ROOT, runCli, type Violation } from '../lib/report.ts';

export const I18N_DIR = 'apps/web/public/i18n';
export const PRIMARY = 'fr';
export const MUST_MATCH = ['ar'];
export const MAY_LAG = ['en'];
const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*\}\}/g;

interface LangFile {
  lang: string;
  file: string;
  leaves: Map<string, unknown>;
  lines: Map<string, number>;
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out.set(prefix, value);
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  out.set(prefix, value);
}

export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))].toSorted();
}

function load(root: string, dir: string, lang: string, violations: Violation[]): LangFile | undefined {
  const file = `${dir}/${lang}.json`;
  let text: string;
  try {
    text = readFileSync(path.join(root, file), 'utf8');
  } catch {
    violations.push({ file, rule: 'i18n/missing-file', message: `translation file for "${lang}" not found` });
    return undefined;
  }
  try {
    const { value, lines } = parseJsonWithLines(text);
    const leaves = new Map<string, unknown>();
    flatten(value, '', leaves);
    return { lang, file, leaves, lines };
  } catch (error) {
    violations.push({ file, rule: 'i18n/invalid-json', message: (error as Error).message });
    return undefined;
  }
}

function at(f: LangFile, key: string): { file: string; line: number } {
  return { file: f.file, line: f.lines.get(key) ?? 1 };
}

export function checkI18n(root: string = REPO_ROOT, dir = I18N_DIR): GuardResult {
  const violations: Violation[] = [];
  const primary = load(root, dir, PRIMARY, violations);
  const strict = MUST_MATCH.map((l) => load(root, dir, l, violations)).filter((f): f is LangFile => !!f);
  const lagging = MAY_LAG.map((l) => load(root, dir, l, violations)).filter((f): f is LangFile => !!f);
  if (!primary) return { name: 'i18n-parity', violations };
  const all = [primary, ...strict, ...lagging];

  // Leaf shape: non-empty strings only.
  for (const f of all) {
    for (const [key, value] of f.leaves) {
      if (typeof value !== 'string') {
        violations.push({ ...at(f, key), rule: 'i18n/leaf-type', message: `"${key}" must be a string (got ${Array.isArray(value) ? 'array' : typeof value === 'object' ? 'empty object' : typeof value})` });
      } else if (value.trim() === '') {
        violations.push({ ...at(f, key), rule: 'i18n/empty', message: `"${key}" is an empty string` });
      }
    }
  }

  // Key parity.
  for (const f of strict) {
    for (const key of primary.leaves.keys()) {
      if (!f.leaves.has(key)) {
        violations.push({ ...at(primary, key), rule: 'i18n/parity', message: `"${key}" exists in ${PRIMARY} but is missing from ${f.lang} (${f.file})` });
      }
    }
    for (const key of f.leaves.keys()) {
      if (!primary.leaves.has(key)) {
        violations.push({ ...at(f, key), rule: 'i18n/parity', message: `"${key}" exists in ${f.lang} but is missing from ${PRIMARY} (${primary.file})` });
      }
    }
  }
  for (const f of lagging) {
    for (const key of primary.leaves.keys()) {
      if (!f.leaves.has(key)) {
        violations.push({ ...at(primary, key), severity: 'warning', rule: 'i18n/lagging', message: `"${key}" is not translated in ${f.lang} yet` });
      }
    }
    for (const key of f.leaves.keys()) {
      if (!primary.leaves.has(key)) {
        violations.push({ ...at(f, key), severity: 'warning', rule: 'i18n/stale', message: `"${key}" exists in ${f.lang} but not in ${PRIMARY} (stale key?)` });
      }
    }
  }

  // Placeholders.
  for (const [key, value] of primary.leaves) {
    if (typeof value !== 'string') continue;
    const expected = placeholders(value).join(', ');
    for (const f of [...strict, ...lagging]) {
      const other = f.leaves.get(key);
      if (typeof other !== 'string') continue;
      const actual = placeholders(other).join(', ');
      if (actual !== expected) {
        violations.push({
          ...at(f, key),
          rule: 'i18n/placeholders',
          message: `"${key}" placeholders differ: ${PRIMARY} has {${expected}}, ${f.lang} has {${actual}}`,
        });
      }
    }
  }
  return { name: 'i18n-parity', violations };
}

if (isMain(import.meta.url)) await runCli(() => checkI18n());
