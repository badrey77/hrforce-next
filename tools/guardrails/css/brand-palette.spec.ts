import { describe, expect, it } from 'vitest';
import { formatViolation } from '../lib/report.ts';
import {
  checkBrandPalette,
  contrastRatio,
  MIN_CONTRAST,
  parseBrandColorsList,
  parseBrandRules,
  parseContractPalette,
  readPaletteSources,
  rootProperty,
  SURFACES,
  type PaletteSources,
} from './brand-palette.ts';

const CONTRACT = [
  '| Code | fr | ar | en | Hex | White text on it | On `#ffffff` | On `#f6f8fa` (surface-alt) | On `#eaeef2` (hover) |',
  '|---|---|---|---|---|---|---|---|---|',
  '| `blue` (default) | Bleu HRForce | أزرق | Blue | `#1f4e79` | 8.66 | 8.66 | 8.14 | 7.43 |',
  '| `navy` | Bleu marine | أزرق داكن | Navy | `#1B3358` | 12.64 | 12.64 | 11.88 | 10.84 |',
].join('\n');
const STYLES = [
  ':root {',
  '  --color-primary: #1f4e79;',
  '  --color-on-primary: #ffffff;',
  '  --color-surface: #ffffff;',
  '  --color-surface-alt: #f6f8fa;',
  '  --color-hover: #eaeef2;',
  '}',
  "/* [data-brand='ghost'] { --color-primary: #000000; } */",
  "[data-brand='blue'] { --color-primary: #1f4e79; }",
  '[data-brand="navy"] {',
  '  --color-primary: #1B3358;',
  '}',
  ".swatch[data-brand] { background: var(--color-primary); }",
].join('\n');
const LIST = "export const BRAND_COLORS = ['blue', 'navy'] as const;";
const sources = (over: Partial<PaletteSources> = {}): PaletteSources => ({ contract: CONTRACT, styles: STYLES, web: LIST, api: LIST, ...over });
const messages = (over: Partial<PaletteSources>) => checkBrandPalette(sources(over)).map((v) => v.message);

describe('brand-palette: parsing', () => {
  it('reads the contract table (code, lower-cased hex), ignoring the header and other tables', () => {
    expect(parseContractPalette(`${CONTRACT}\n| \`settings.branding\` | a | b | c | \`settings\`, 1010 | x |`)).toEqual([
      { code: 'blue', hex: '#1f4e79' },
      { code: 'navy', hex: '#1b3358' },
    ]);
  });

  it('reads BRAND_COLORS from a TypeScript source', () => {
    expect(parseBrandColorsList(`/** doc */\n${LIST}\nexport type BrandColor = (typeof BRAND_COLORS)[number];`)).toEqual(['blue', 'navy']);
    expect(parseBrandColorsList('export const BRAND_COLORS = [\n  "blue",\n  "navy",\n] as const;')).toEqual(['blue', 'navy']);
    expect(parseBrandColorsList('export const OTHER = [];')).toBeUndefined();
  });

  it('reads the rules that turn a code into a colour, not comments nor rules that only use the colour', () => {
    expect(parseBrandRules(STYLES)).toEqual([
      { selector: "[data-brand='blue']", code: 'blue', value: '#1f4e79' },
      { selector: '[data-brand="navy"]', code: 'navy', value: '#1b3358' },
    ]);
    expect(rootProperty(STYLES, '--color-surface-alt')).toBe('#f6f8fa');
    expect(rootProperty(STYLES, '--color-missing')).toBeUndefined();
  });
});

describe('brand-palette: contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#1f4e79', '#ffffff')).toBeCloseTo(8.66, 2);
    expect(contrastRatio('#ffffff', '#1f4e79')).toBeCloseTo(8.66, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });
});

describe('brand-palette: check', () => {
  it('passes on a consistent set', () => {
    expect(checkBrandPalette(sources())).toEqual([]);
  });

  it('flags a missing, duplicated, unknown or wrong rule', () => {
    expect(messages({ styles: STYLES.replace("[data-brand='blue'] { --color-primary: #1f4e79; }", '') })).toEqual([expect.stringContaining("exactly one [data-brand='blue'] rule setting --color-primary, found 0")]);
    expect(messages({ styles: `${STYLES}\n[data-brand='blue'] { --color-primary: #1f4e79; }` })).toEqual([expect.stringContaining('found 2')]);
    expect(messages({ styles: `${STYLES}\n[data-brand='red'] { --color-primary: #cc0000; }` })).toEqual(["[data-brand='red'] is not a palette code"]);
    expect(messages({ styles: STYLES.replace("{ --color-primary: #1f4e79; }", '{ --color-primary: #1f4e7a; }') })).toEqual([expect.stringContaining("[data-brand='blue'] sets --color-primary to #1f4e7a; the contract's palette says #1f4e79")]);
    expect(messages({ styles: `${STYLES}\n.dark [data-brand='blue'] { --color-primary: #1f4e79; }` })).toEqual([expect.stringContaining('only the plain rule')]);
  });

  it('flags a code list that differs from the contract (missing, extra, reordered), in the web and in the API', () => {
    expect(messages({ web: "export const BRAND_COLORS = ['blue'] as const;" })).toEqual([expect.stringContaining('BRAND_COLORS is [blue]')]);
    expect(messages({ api: "export const BRAND_COLORS = ['navy', 'blue'] as const;" })).toEqual([expect.stringContaining('BRAND_COLORS is [navy, blue]')]);
    expect(messages({ web: 'export const COLORS = [];' })).toEqual(['`export const BRAND_COLORS = [...]` not found']);
    expect(checkBrandPalette(sources({ api: "export const BRAND_COLORS = ['blue', 'navy', 'red'] as const;" }))[0]?.file).toBe('apps/api/src/modules/branding/domain/types.ts');
  });

  it('flags a colour below 4.5:1 on white or on a surface, and surfaces that changed', () => {
    // #6f7f8f: 4.07 on white — too light for white text and for text on the surfaces
    const light = { contract: CONTRACT.replace('#1B3358', '#6f7f8f'), styles: STYLES.replace('#1B3358', '#6f7f8f') };
    const found = messages(light);
    expect(found).toHaveLength(4);
    expect(found[0]).toMatch(/^navy #6f7f8f reaches only 4\.\d\d:1 against #ffffff \(--color-on-primary\); 4\.5:1 is required$/);
    expect(messages({ styles: STYLES.replace('--color-hover: #eaeef2', '--color-hover: #d0d7de') })).toEqual([":root --color-hover is #d0d7de; the palette's contrast ratios assume #eaeef2"]);
    expect(messages({ styles: STYLES.replace('--color-primary: #1f4e79;\n  --color-on', '--color-primary: #000000;\n  --color-on') })).toEqual([':root --color-primary is #000000; the default code blue is #1f4e79']);
    expect(messages({ contract: 'no table' })).toEqual([expect.stringContaining('no palette table found')]);
  });
});

describe('brand-palette: this repository', () => {
  const real = readPaletteSources();

  it('the contract lists ten colours, each ≥ 4.5:1 under white text and on the three light surfaces', () => {
    const palette = parseContractPalette(real.contract);
    expect(palette.map((p) => p.code)).toEqual(['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate']);
    for (const { code, hex } of palette) {
      for (const surface of Object.values(SURFACES)) expect(contrastRatio(hex, surface), `${code} ${hex} on ${surface}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it("styles.css has exactly one [data-brand='<code>'] rule per code of the web's BRAND_COLORS, with the contract's hex value; the API's list matches", () => {
    expect(checkBrandPalette(real).map(formatViolation)).toEqual([]);
  });
});
