import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCssLogical, checkDeclaration, scanFile } from './css-logical.ts';

const lines = (file: string, text: string) => scanFile(file, text).map((v) => `${v.line}:${v.column} ${v.message}`);

describe('css-logical', () => {
  it.each([
    ['margin-left', '4px', 'margin-inline-start'],
    ['padding-right', '0', 'padding-inline-end'],
    ['border-left', '1px solid', 'border-inline-start'],
    ['border-right-color', 'red', 'border-inline-end-color'],
    ['border-top-left-radius', '4px', 'border-start-start-radius'],
    ['left', '0', 'inset-inline-start'],
    ['right', '1rem', 'inset-inline-end'],
    ['text-align', 'left', 'text-align: start'],
    ['text-align', 'right !important', 'text-align: end'],
    ['float', 'right', 'float: inline-end'],
    ['clear', 'left', 'clear: inline-start'],
  ])('flags %s: %s', (property, value, suggestion) => {
    expect(checkDeclaration(property, value)).toContain(suggestion);
  });

  it.each([
    ['margin-inline-start', '4px'],
    ['inset-inline-end', '0'],
    ['text-align', 'center'],
    ['text-align', 'start'],
    ['float', 'inline-start'],
    ['margin', '0 auto'],
    ['transition-property', 'left'],
  ])('allows %s: %s', (property, value) => {
    expect(checkDeclaration(property, value)).toBeUndefined();
  });

  it('parses stylesheets: selectors, pseudo-classes, nesting, comments, url() and the ignore marker', () => {
    const css = [
      '.left:hover, .right { color: red; }', // selectors named left/right are fine
      '.card {',
      '  margin-left: 4px;',
      '  background: url("data:image/svg+xml;utf8,<svg style=\'left:0\'/>");',
      '  /* padding-right: 2px; */',
      '  // text-align: left;',
      '  &:hover { text-align: right }',
      '  position: absolute; left: 0',
      '}',
      '.x { float: left; } /* css-logical-ignore: third-party widget */',
    ].join('\n');
    expect(lines('a.scss', css)).toEqual([
      '3:3 use margin-inline-start instead of margin-left',
      '7:13 use text-align: end instead of text-align: right',
      '8:23 use inset-inline-start instead of left',
    ]);
  });

  it('checks style="" attributes and [style.x] bindings in templates', () => {
    const html = '<div style="padding-left: 2px; color: red">\n  <span [style.margin-right.px]="gap" [style.margin-inline-end.px]="gap"></span>\n</div>';
    expect(lines('a.html', html)).toEqual([
      '1:13 use padding-inline-start instead of padding-left',
      '2:9 use margin-inline-end instead of margin-right',
    ]);
  });

  it('checks inline styles and templates of @Component in .ts files', () => {
    const ts = [
      "import { Component } from '@angular/core';",
      '@Component({',
      "  selector: 'x-a',",
      '  template: `<p style="text-align: left">hi</p>`,',
      '  styles: [`',
      '    :host { display: block; }',
      '    p { border-right: 1px solid; }',
      '  `],',
      "  host: { '[style.left.px]': 'x' },",
      '})',
      'export class A {}',
    ].join('\n');
    expect(lines('a.ts', ts)).toEqual([
      '4:24 use text-align: start instead of text-align: left',
      '7:9 use border-inline-end instead of border-right',
      '9:11 use inset-inline-start instead of left',
    ]);
    expect(lines('b.ts', 'export const notAComponent = "margin-left: 0";')).toEqual([]);
  });

  it('scans a directory tree (fixture)', () => {
    const result = checkCssLogical(path.join(import.meta.dirname, '__fixtures__'), 'src');
    expect(result.violations.map((v) => `${v.file}:${v.line}`)).toEqual(['src/app/bad.component.css:3', 'src/app/bad.component.ts:5']);
  });
});
