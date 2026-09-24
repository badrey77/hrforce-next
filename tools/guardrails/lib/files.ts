import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.angular', '.git']);

/** Recursively lists files under `dir` (absolute paths, sorted) accepted by `accept`. Missing dir → []. */
export function listFiles(dir: string, accept: (file: string) => boolean): string[] {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir).toSorted();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) out.push(...listFiles(full, accept));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Precomputed line starts for offset → line/column conversion. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  /** 1-based line and column of a 0-based UTF-16 offset. */
  position(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.starts[lo] ?? 0) + 1 };
  }
}
