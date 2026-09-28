/**
 * Cross-platform way to run a package's CLI or npm from a guardrail.
 *
 * `node_modules/.bin/<name>` is a shell script on Linux/macOS but a `.cmd` shim on Windows, and Node refuses to
 * spawn `.cmd`/`.bat` files without a shell (and `npm` itself is `npm.cmd` there). Running the package's JS entry
 * point with the current Node binary (`process.execPath`) works the same everywhere and needs no shell.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './report.ts';

export interface Command {
  command: string;
  args: string[];
  /** only for the npm fallback on Windows (`npm.cmd` needs a shell; its arguments must be plain words) */
  shell?: boolean;
}

/** `node <package bin script> ...args` for a package installed in the repo's root node_modules. */
export function packageBin(pkg: string, args: string[], binName: string = pkg): Command {
  const dir = path.join(REPO_ROOT, 'node_modules', pkg);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (!rel) throw new Error(`${pkg} has no bin "${binName}"`);
  return { command: process.execPath, args: [path.join(dir, rel), ...args] };
}

/**
 * `npm ...args`: through npm's own CLI script when we were started by npm (`npm_execpath`, set by `npm run`),
 * else the `npm` on PATH (through a shell on Windows, where it is `npm.cmd`).
 */
export function npmCommand(args: string[]): Command {
  const cli = process.env['npm_execpath'];
  if (cli && /\.[cm]?js$/.test(cli)) return { command: process.execPath, args: [cli, ...args] };
  return process.platform === 'win32' ? { command: 'npm', args, shell: true } : { command: 'npm', args };
}
