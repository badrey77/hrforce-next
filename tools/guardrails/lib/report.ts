import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root (tools/guardrails/lib → ../../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export type Severity = 'error' | 'warning';

export interface Violation {
  /** Path relative to the root the guard ran against (forward slashes). */
  file: string;
  /** 1-based line, when known. */
  line?: number;
  /** 1-based column, when known. */
  column?: number;
  rule: string;
  message: string;
  severity?: Severity;
}

export interface GuardResult {
  name: string;
  violations: Violation[];
  /** Extra human-readable output (e.g. the route table). */
  info?: string;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function relativeTo(root: string, file: string): string {
  return toPosix(path.relative(root, file));
}

export function formatViolation(v: Violation): string {
  const location = `${v.file}${v.line ? `:${v.line}${v.column ? `:${v.column}` : ''}` : ''}`;
  return `${location}: ${v.severity === 'warning' ? 'warning' : 'error'} [${v.rule}] ${v.message}`;
}

export function errorsOf(result: GuardResult): Violation[] {
  return result.violations.filter((v) => v.severity !== 'warning');
}

/** Prints a guard result; returns true when it has no errors (warnings do not fail). */
export function printResult(result: GuardResult, out: NodeJS.WritableStream = process.stdout): boolean {
  if (result.info) out.write(`${result.info}\n`);
  const errors = errorsOf(result);
  const warnings = result.violations.length - errors.length;
  for (const v of result.violations) {
    (v.severity === 'warning' ? out : process.stderr).write(`${formatViolation(v)}\n`);
  }
  const summary = errors.length
    ? `✖ ${result.name}: ${errors.length} error(s)${warnings ? `, ${warnings} warning(s)` : ''}`
    : `✔ ${result.name}: ok${warnings ? ` (${warnings} warning(s))` : ''}`;
  (errors.length ? process.stderr : out).write(`${summary}\n`);
  return errors.length === 0;
}

/** Runs a guard as a CLI: prints its result and sets the exit code. */
export async function runCli(fn: () => Promise<GuardResult> | GuardResult): Promise<void> {
  try {
    const ok = printResult(await fn());
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 2;
  }
}

/** True when the module at `metaUrl` is the process entry point (`node file.ts`). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(metaUrl);
}
