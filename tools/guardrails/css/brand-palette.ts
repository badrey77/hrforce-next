/**
 * Guardrail: brand palette (docs/contracts/branding.md › Palette, › Colour under the CSP, › Web tests).
 *
 * A brand colour is a CODE everywhere except in one place: `apps/web/src/styles.css`, where one rule per code
 * (`[data-brand='<code>'] { --color-primary: #…; }`) turns it into a colour. This check ties the three lists together:
 *   - the codes     = the web's `BRAND_COLORS` (apps/web/src/app/core/branding/branding.models.ts), which must equal
 *                     the API's (apps/api/src/modules/branding/domain/types.ts) and the contract table's, in order;
 *   - the hex values = the contract's palette table (docs/contracts/branding.md) — the single source of truth;
 *   - the stylesheet has EXACTLY one `[data-brand='<code>']` rule setting `--color-primary` per code, with that hex
 *     value, and none for an unknown code;
 *   - every hex value reaches 4.5:1 (WCAG 2.x) against white (the text on it: `--color-on-primary`) and against the
 *     three light surfaces it is used on as text or border colour (`--color-surface`, `--color-surface-alt`,
 *     `--color-hover`), whose values in the stylesheet must still be the contract's.
 * Run by `npm run test:tools` (brand-palette.spec.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, type Violation } from '../lib/report.ts';

export const CONTRACT_FILE = 'docs/contracts/branding.md';
export const STYLES_FILE = 'apps/web/src/styles.css';
export const WEB_PALETTE_FILE = 'apps/web/src/app/core/branding/branding.models.ts';
export const API_PALETTE_FILE = 'apps/api/src/modules/branding/domain/types.ts';

/** The surfaces a brand colour sits on (contract table columns), by the custom property that holds them. */
export const SURFACES = { '--color-on-primary': '#ffffff', '--color-surface': '#ffffff', '--color-surface-alt': '#f6f8fa', '--color-hover': '#eaeef2' } as const;
export const MIN_CONTRAST = 4.5;
const RULE = 'brand-palette';

export interface PaletteEntry {
  code: string;
  hex: string;
}

/** The rows of the contract's palette table: `| \`code\` (default) | fr | ar | en | \`#rrggbb\` | … |`. */
export function parseContractPalette(markdown: string): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim());
    const code = /^`([a-z]+)`(?: \(default\))?$/.exec(cells[1] ?? '');
    const hex = /^`(#[0-9a-fA-F]{6})`$/.exec(cells[5] ?? '');
    if (code?.[1] && hex?.[1]) entries.push({ code: code[1], hex: hex[1].toLowerCase() });
  }
  return entries;
}

/** The string literals of `export const BRAND_COLORS = [ … ] as const` in a TypeScript source. */
export function parseBrandColorsList(source: string): string[] | undefined {
  const match = /export const BRAND_COLORS\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!match) return undefined;
  return [...(match[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

export interface BrandRule {
  selector: string;
  /** the code of a selector that is exactly `[data-brand='<code>']`, else undefined */
  code: string | undefined;
  /** the `--color-primary` value, lower-cased */
  value: string;
}

/** Every rule whose selector mentions `[data-brand` and whose block sets `--color-primary`. */
export function parseBrandRules(css: string): BrandRule[] {
  const rules: BrandRule[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim();
    const declaration = /(?:^|;)\s*--color-primary\s*:\s*([^;]+)/.exec(m[2] ?? '');
    if (!selector.includes('[data-brand') || !declaration) continue;
    const exact = /^\[data-brand=(['"])([^'"]+)\1\]$/.exec(selector);
    rules.push({ selector, code: exact?.[2], value: (declaration[1] ?? '').trim().toLowerCase() });
  }
  return rules;
}

/** The value of a custom property declared in the first `:root { … }` block. */
export function rootProperty(css: string, name: string): string | undefined {
  const root = /:root\s*\{([^{}]*)\}/.exec(stripComments(css));
  const declaration = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(root?.[1] ?? '');
  return declaration?.[1]?.trim().toLowerCase();
}

/** WCAG 2.x relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.x contrast ratio of two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export interface PaletteSources {
  contract: string;
  styles: string;
  web: string;
  api: string;
}

export function readPaletteSources(root: string = REPO_ROOT): PaletteSources {
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  return { contract: read(CONTRACT_FILE), styles: read(STYLES_FILE), web: read(WEB_PALETTE_FILE), api: read(API_PALETTE_FILE) };
}

export function checkBrandPalette(sources: PaletteSources): Violation[] {
  const violations: Violation[] = [];
  const fail = (file: string, message: string) => violations.push({ file, rule: RULE, message });

  const palette = parseContractPalette(sources.contract);
  if (palette.length === 0) return [{ file: CONTRACT_FILE, rule: RULE, message: 'no palette table found (rows `| `code` | fr | ar | en | `#rrggbb` | …`)' }];
  const codes = palette.map((p) => p.code);

  for (const [file, source] of [[WEB_PALETTE_FILE, sources.web], [API_PALETTE_FILE, sources.api]] as const) {
    const list = parseBrandColorsList(source);
    if (!list) fail(file, '`export const BRAND_COLORS = [...]` not found');
    else if (list.join() !== codes.join()) fail(file, `BRAND_COLORS is [${list.join(', ')}] but the contract's palette is [${codes.join(', ')}] (same codes, same order)`);
  }

  const rules = parseBrandRules(sources.styles);
  for (const rule of rules) {
    if (rule.code === undefined) fail(STYLES_FILE, `\`${rule.selector}\` sets --color-primary: only the plain rule \`[data-brand='<code>']\` may turn a code into a colour`);
    else if (!codes.includes(rule.code)) fail(STYLES_FILE, `[data-brand='${rule.code}'] is not a palette code`);
  }
  for (const { code, hex } of palette) {
    const own = rules.filter((r) => r.code === code);
    if (own.length !== 1) fail(STYLES_FILE, `expected exactly one [data-brand='${code}'] rule setting --color-primary, found ${own.length}`);
    for (const rule of own) {
      if (rule.value !== hex) fail(STYLES_FILE, `[data-brand='${code}'] sets --color-primary to ${rule.value}; the contract's palette says ${hex}`);
    }
    for (const [property, surface] of Object.entries(SURFACES)) {
      const ratio = contrastRatio(hex, surface);
      if (ratio < MIN_CONTRAST) fail(CONTRACT_FILE, `${code} ${hex} reaches only ${ratio.toFixed(2)}:1 against ${surface} (${property}); ${MIN_CONTRAST}:1 is required`);
    }
  }

  // the surfaces the ratios were computed against are still the stylesheet's, and the default is the first code
  for (const [property, expected] of Object.entries(SURFACES)) {
    const actual = rootProperty(sources.styles, property);
    if (actual !== expected) fail(STYLES_FILE, `:root ${property} is ${actual ?? 'missing'}; the palette's contrast ratios assume ${expected}`);
  }
  const fallback = rootProperty(sources.styles, '--color-primary');
  if (palette[0] && fallback !== palette[0].hex) fail(STYLES_FILE, `:root --color-primary is ${fallback ?? 'missing'}; the default code ${palette[0].code} is ${palette[0].hex}`);
  return violations;
}
