/**
 * Guardrail: css-logical (CONVENTIONS.md › Web: "Use CSS logical properties"; ar is RTL).
 * Fails on physical-direction CSS in apps/web/src:
 *   margin|padding|border-(left|right)*, border-(top|bottom)-(left|right)-radius, left:/right: (position offsets),
 *   text-align: left|right, float|clear: left|right
 * Checked in .css/.scss files, inline `styles`/`template` of @Component in .ts, `style="…"` and
 * `[style.margin-left]`-style bindings in .html templates.
 * Escape hatch for a deliberate physical property: a `css-logical-ignore` comment on the same line.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type AstNode, decoratorCall, nameOf, parseTs, prop, propList, walk } from '../lib/ast.ts';
import { LineIndex, listFiles } from '../lib/files.ts';
import { type GuardResult, isMain, REPO_ROOT, relativeTo, runCli, type Violation } from '../lib/report.ts';

export const WEB_SRC = 'apps/web/src';
const IGNORE_MARKER = 'css-logical-ignore';

interface Finding {
  offset: number;
  message: string;
}

const LOGICAL_SIDE: Record<string, string> = { left: 'inline-start', right: 'inline-end' };
const LOGICAL_CORNER: Record<string, string> = {
  'top-left': 'start-start',
  'top-right': 'start-end',
  'bottom-left': 'end-start',
  'bottom-right': 'end-end',
};

/** Checks one declaration (`property`, `value`); returns a message or undefined. */
export function checkDeclaration(property: string, value: string): string | undefined {
  const p = property.trim().toLowerCase();
  const v = value.trim().toLowerCase().replace(/\s*!important$/, '');
  let m = /^(margin|padding|scroll-margin|scroll-padding)-(left|right)$/.exec(p);
  if (m) return `use ${m[1]}-${LOGICAL_SIDE[m[2] ?? '']} instead of ${p}`;
  m = /^border-(left|right)(-(?:width|style|color))?$/.exec(p);
  if (m) return `use border-${LOGICAL_SIDE[m[1] ?? '']}${m[2] ?? ''} instead of ${p}`;
  m = /^border-(top|bottom)-(left|right)-radius$/.exec(p);
  if (m) return `use border-${LOGICAL_CORNER[`${m[1]}-${m[2]}`]}-radius instead of ${p}`;
  m = /^(left|right)$/.exec(p);
  if (m) return `use inset-${LOGICAL_SIDE[m[1] ?? '']} instead of ${p}`;
  if (/^(text-align|text-align-last)$/.test(p) && /^(left|right)$/.test(v)) {
    return `use ${p}: ${v === 'left' ? 'start' : 'end'} instead of ${p}: ${v}`;
  }
  if (/^(float|clear)$/.test(p) && /^(left|right)$/.test(v)) {
    return `use ${p}: inline-${v === 'left' ? 'start' : 'end'} instead of ${p}: ${v}`;
  }
  return undefined;
}

/** Blanks out comments (keeping offsets and newlines) so offsets map back to the source. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (match, lead: string | undefined) => {
    const keep = match.startsWith('/*') ? '' : (lead ?? '');
    return keep + match.slice(keep.length).replace(/[^\n]/g, ' ');
  });
}

/** Scans a stylesheet (CSS or SCSS) for physical declarations. */
export function scanCss(css: string): Finding[] {
  const text = stripComments(css);
  const findings: Finding[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? text.length : close;
      continue;
    }
    if (c === '(') {
      // skip url(...) / functions that could contain ; or {
      let level = 1;
      while (level > 0 && ++i < text.length) level += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
      continue;
    }
    if (c !== ';' && c !== '{' && c !== '}' && i !== text.length) continue;
    const segment = text.slice(segmentStart, i);
    // A segment ending in "{" is a selector / at-rule prelude; otherwise it is a declaration when inside a block.
    if (c !== '{' && (depth > 0 || i === text.length)) {
      const colon = segment.indexOf(':');
      if (colon > 0) {
        const property = segment.slice(0, colon);
        if (/^\s*[a-zA-Z-]+\s*$/.test(property)) {
          const message = checkDeclaration(property, segment.slice(colon + 1));
          if (message) findings.push({ offset: segmentStart + (segment.length - segment.trimStart().length), message });
        }
      }
    }
    if (c === '{') depth++;
    if (c === '}') depth = Math.max(0, depth - 1);
    segmentStart = i + 1;
  }
  return findings;
}

/** Inline declarations list, e.g. the content of style="…". */
export function scanDeclarations(declarations: string): Finding[] {
  return scanCss(`{${declarations}}`).map((f) => ({ ...f, offset: f.offset - 1 }));
}

/** style="…" attributes and [style.prop] bindings in an Angular template. */
export function scanTemplate(html: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const body = m[2] ?? m[3] ?? '';
    const bodyOffset = (m.index ?? 0) + m[0].indexOf(body);
    for (const f of scanDeclarations(body)) findings.push({ offset: bodyOffset + f.offset, message: f.message });
  }
  for (const m of html.matchAll(/\[style\.([a-zA-Z-]+)(?:\.[a-z%]+)?\]\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const property = m[1] ?? '';
    // The bound value is an expression; only the property can be judged (and text-align/float literal values).
    const literal = /^'([^']*)'$/.exec((m[3] ?? m[4] ?? '').trim())?.[1] ?? '';
    const message = checkDeclaration(property, literal);
    if (message) findings.push({ offset: m.index ?? 0, message });
  }
  return findings;
}

/** Inline `styles` / `styles: [...]` / `template` of @Component decorators in a .ts file. */
export function scanComponentSource(file: string, source: string): { offset: number; message: string }[] {
  if (!source.includes('@Component')) return [];
  const parsed = parseTs(file, source);
  const findings: Finding[] = [];
  const scanLiteral = (node: AstNode, scanner: (text: string) => Finding[]) => {
    if (node.type === 'Literal' && typeof node['value'] === 'string') {
      // offset + 1 skips the opening quote; escapes are rare in CSS so raw offsets are close enough
      for (const f of scanner(source.slice(node.start + 1, node.end - 1))) findings.push({ offset: node.start + 1 + f.offset, message: f.message });
    } else if (node.type === 'TemplateLiteral') {
      for (const quasi of propList(node, 'quasis')) {
        for (const f of scanner(source.slice(quasi.start, quasi.end))) findings.push({ offset: quasi.start + f.offset, message: f.message });
      }
    } else if (node.type === 'ArrayExpression') {
      for (const element of propList(node, 'elements')) scanLiteral(element, scanner);
    }
  };
  walk(parsed.program, (node) => {
    if (node.type !== 'Decorator' || decoratorCall(node).name !== 'Component') return;
    const options = decoratorCall(node).args[0];
    if (options?.type !== 'ObjectExpression') return;
    for (const property of propList(options, 'properties')) {
      const key = nameOf(prop(property, 'key'));
      const value = prop(property, 'value');
      if (!value) continue;
      if (key === 'styles') scanLiteral(value, scanCss);
      if (key === 'template') scanLiteral(value, scanTemplate);
      if (key === 'host' && value.type === 'ObjectExpression') {
        for (const hostProp of propList(value, 'properties')) {
          const hostKey = nameOf(prop(hostProp, 'key')) ?? '';
          const styleBinding = /^\[style\.([a-zA-Z-]+)/.exec(hostKey);
          const message = styleBinding ? checkDeclaration(styleBinding[1] ?? '', '') : undefined;
          if (message) findings.push({ offset: hostProp.start, message });
          if (hostKey === 'style') {
            const hostValue = prop(hostProp, 'value');
            if (hostValue) scanLiteral(hostValue, scanDeclarations);
          }
        }
      }
    }
  });
  return findings;
}

export function scanFile(file: string, text: string): Violation[] {
  let findings: Finding[] = [];
  if (/\.(s?css)$/.test(file)) findings = scanCss(text);
  else if (file.endsWith('.html')) findings = scanTemplate(text);
  else if (file.endsWith('.ts')) findings = scanComponentSource(file, text);
  const lines = new LineIndex(text);
  const sourceLines = text.split('\n');
  return findings
    .map((f) => ({ ...lines.position(f.offset), message: f.message }))
    .filter((f) => !(sourceLines[f.line - 1] ?? '').includes(IGNORE_MARKER))
    .map((f) => ({ file, line: f.line, column: f.column, rule: 'css-logical', message: f.message }));
}

export function checkCssLogical(root: string = REPO_ROOT, dir = WEB_SRC): GuardResult {
  const files = listFiles(path.join(root, dir), (f) => /\.(s?css|html)$/.test(f) || (f.endsWith('.ts') && !f.endsWith('.spec.ts')));
  const violations = files.flatMap((file) => scanFile(relativeTo(root, file), readFileSync(file, 'utf8')));
  return { name: 'css-logical', violations };
}

if (isMain(import.meta.url)) await runCli(() => checkCssLogical());
