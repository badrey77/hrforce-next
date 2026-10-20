/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|html)$/.test(name) ? [path] : [];
  });
}

/** The designer package imports nothing from the app (contract › Designer package). */
describe('document-designer boundary', () => {
  const root = [join(process.cwd(), 'src', 'lib', 'document-designer'), join(process.cwd(), 'apps', 'web', 'src', 'lib', 'document-designer')].find((dir) =>
    existsSync(dir),
  ) as string;

  it('has source files', () => {
    expect(files(root).length).toBeGreaterThan(5);
  });

  it('never imports from src/app', () => {
    const offenders = files(root).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].some(([, spec]) => /(^|\/)app\//.test(spec ?? '') || (spec ?? '').startsWith('../../app'));
    });
    expect(offenders).toEqual([]);
  });
});
