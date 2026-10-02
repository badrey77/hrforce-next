import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readImageHeader, withinImageLimits } from './image-header.js';
import { PdfRenderError, PdfRenderer, type RenderInput } from './pdf-renderer.js';
import type { RenderJob, RenderReply, RenderWorkerData } from './render-worker.js';

/** Typst embedded by the pinned binding (`@myriaddreamin/typst-ts-node-compiler` 0.7.0 ships Typst 0.14.2). */
export const TYPST_VERSION = '0.14.2';

function bindingVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('@myriaddreamin/typst-ts-node-compiler/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Cap on what one render may carry (data + options JSON + assets). Documents carry a few KB of JSON and a logo of at
 * most 256 KB; anything near this cap is a bug or an attack, and refusing it keeps the engine's memory bounded.
 */
export const RENDER_INPUT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Why an input must not reach Typst, or null. A Typst allocation failure aborts the render process (ADR 008), so an
 * image asset is refused when its header is unreadable or declares more pixels than the limits (image-header.ts):
 * the engine would decode all of them. Non-image assets pass (their size still counts).
 */
export function unsafeRenderInput(job: { data: string; options: string; assets: readonly { path: string; bytes: Uint8Array }[] }): string | null {
  const size = job.data.length + job.options.length + job.assets.reduce((n, a) => n + a.bytes.byteLength, 0);
  if (size > RENDER_INPUT_MAX_BYTES) return `render input too large (${size} bytes)`;
  for (const asset of job.assets) {
    const header = readImageHeader(asset.bytes);
    if (!header.ok && header.reason === 'malformed') return `unreadable image header: ${asset.path}`;
    if (header.ok && !withinImageLimits(header)) return `image too large: ${asset.path} (${header.width} × ${header.height} px)`;
  }
  return null;
}

/** apps/api (this file is src/platform/pdf/… or dist/platform/pdf/…: three levels below the package root). */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** `<dir>/fonts` and `<dir>/templates`; default apps/api/assets/pdf (copied into the image, apps/api/Dockerfile). */
export function pdfAssetsDir(override?: string): string {
  return override ? path.resolve(override) : path.join(PACKAGE_ROOT, 'assets', 'pdf');
}

/** The compiled render script next to this file (.js), or its TypeScript source under the test runner. */
function workerScript(): string {
  const js = fileURLToPath(new URL('./render-worker.js', import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL('./render-worker.ts', import.meta.url));
}

/** Resident memory of a process in bytes (Linux `/proc`), or null where it cannot be read (other platforms). */
function residentBytes(pid: number): number | null {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export interface TypstRendererOptions {
  assetsDir?: string;
  /** per render (default 15 s) */
  timeoutMs?: number;
  /** render processes (default 1, max 4) */
  concurrency?: number;
  /**
   * Resident memory a render process may reach while rendering (default 1 GiB); above it the process is killed and
   * the render fails with `PdfRenderError('memory')`. Read from /proc (Linux, as in production); elsewhere unchecked.
   */
  maxMemoryBytes?: number;
}

interface Pending {
  job: RenderJob;
  resolve: (pdf: Buffer) => void;
  reject: (error: Error) => void;
}

/** One render process and the job it is running. */
interface Slot {
  child: ChildProcess | null;
  current: (Pending & { timer: NodeJS.Timeout; watch: NodeJS.Timeout | null }) | null;
}

/** How often the memory of a busy render process is sampled. */
const MEMORY_SAMPLE_MS = 50;

/**
 * {@link PdfRenderer} on Typst (ADR 008): a small pool of child processes (render-worker.ts), each with its own
 * compiler, started at first use; a FIFO queue in front. The binding is native code, and a fault in it (a crash, an
 * out-of-memory abort) would end whatever process runs it: in a child, it ends only that child — the job fails with
 * `PdfRenderError('error')`, the process is replaced at the next job, and the API keeps serving. A render that exceeds
 * the time limit, or the memory ceiling, gets its process killed (SIGKILL really stops native code, which a thread's
 * terminate() could not) and fails with `PdfRenderError('timeout' | 'memory')`. Engine errors (template or data) fail
 * with `PdfRenderError('error')` and keep the process.
 *
 * The children get an empty environment: no database URL, key or secret of the API ever reaches the renderer.
 */
export class TypstPdfRenderer extends PdfRenderer {
  readonly engine = `typst ${TYPST_VERSION} / typst-ts ${bindingVersion()}`;
  private readonly assetsDir: string;
  private readonly timeoutMs: number;
  private readonly maxMemoryBytes: number;
  private readonly slots: Slot[];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: TypstRendererOptions = {}) {
    super();
    this.assetsDir = pdfAssetsDir(options.assetsDir);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxMemoryBytes = options.maxMemoryBytes ?? 1024 * 1024 * 1024;
    const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 1));
    this.slots = Array.from({ length: concurrency }, () => ({ child: null, current: null }));
  }

  render(input: RenderInput): Promise<Buffer> {
    if (this.closed) return Promise.reject(new PdfRenderError('error', 'renderer closed'));
    const job: RenderJob = {
      id: this.nextId++,
      template: input.template,
      data: JSON.stringify(input.data),
      options: JSON.stringify(input.options ?? {}),
      assets: (input.assets ?? []).map((a) => ({ path: a.path, bytes: a.bytes })),
      standard: input.standard === undefined ? 'a-2b' : input.standard,
    };
    // never hand Typst an input that could exhaust memory: the render would fail, and cost a process restart
    const unsafe = unsafeRenderInput(job);
    if (unsafe) return Promise.reject(new PdfRenderError('error', unsafe));
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  /** The running render processes (diagnostics and tests). */
  processIds(): number[] {
    return this.slots.flatMap((slot) => (slot.child?.pid === undefined ? [] : [slot.child.pid]));
  }

  /** Nest lifecycle (the platform module provides this adapter through a factory). */
  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  /** Stops every render process (Nest shutdown / end of a script). Pending renders fail. */
  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) pending.reject(new PdfRenderError('error', 'renderer closed'));
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.current) this.finish(slot, new PdfRenderError('error', 'renderer closed'));
        const child = slot.child;
        slot.child = null;
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          child.kill('SIGKILL');
          await exited;
        }
      }),
    );
  }

  private spawn(slot: Slot): ChildProcess {
    const data: RenderWorkerData = { templatesDir: path.join(this.assetsDir, 'templates'), fontsDir: path.join(this.assetsDir, 'fonts') };
    const child = fork(workerScript(), [JSON.stringify(data)], {
      // no inherited CLI flags (e.g. --input-type, --inspect) and no environment (no secret reaches the renderer)
      execArgv: [],
      // Windows: Node itself needs SystemRoot (not a secret)
      env: process.platform === 'win32' ? { SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows' } : {},
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (reply: RenderReply) => {
      if (slot.child !== child || !slot.current || slot.current.job.id !== reply.id) return;
      if (reply.ok) this.finish(slot, null, Buffer.from(reply.pdf.buffer, reply.pdf.byteOffset, reply.pdf.byteLength));
      else this.finish(slot, new PdfRenderError('error', reply.error));
    });
    const onDeath = (reason: string) => {
      if (slot.child !== child) return;
      slot.child = null;
      if (slot.current) this.finish(slot, new PdfRenderError('error', `render process stopped: ${reason}`));
    };
    child.on('error', (error) => onDeath(error.message));
    child.on('exit', (code, signal) => onDeath(signal ? `signal ${signal}` : `exit ${code}`));
    slot.child = child;
    return child;
  }

  /** Kills the slot's process for a runaway job and fails the job with `reason`. */
  private abort(slot: Slot, error: PdfRenderError): void {
    const stuck = slot.child;
    slot.child = null;
    this.finish(slot, error);
    stuck?.kill('SIGKILL');
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.current || this.closed) continue;
      const next = this.queue.shift();
      if (!next) return;
      const child = slot.child ?? this.spawn(slot);
      const timer = setTimeout(() => this.abort(slot, new PdfRenderError('timeout', `render exceeded ${this.timeoutMs} ms`)), this.timeoutMs);
      const pid = child.pid;
      const watch =
        pid === undefined
          ? null
          : setInterval(() => {
              const rss = residentBytes(pid);
              if (rss !== null && rss > this.maxMemoryBytes) {
                this.abort(slot, new PdfRenderError('memory', `render exceeded ${Math.round(this.maxMemoryBytes / 1048576)} MB`));
              }
            }, MEMORY_SAMPLE_MS);
      slot.current = { ...next, timer, watch };
      child.send(next.job);
    }
  }

  private finish(slot: Slot, error: Error | null, pdf?: Buffer): void {
    const current = slot.current;
    if (!current) return;
    clearTimeout(current.timer);
    if (current.watch) clearInterval(current.watch);
    slot.current = null;
    if (error) current.reject(error);
    else current.resolve(pdf ?? Buffer.alloc(0));
    this.pump();
  }
}
