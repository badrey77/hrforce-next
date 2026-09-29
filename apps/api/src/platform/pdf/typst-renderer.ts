import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
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
 * Why an input must not reach Typst, or null. A Typst allocation failure aborts the whole process (ADR 008), so an
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

/** The compiled thread script next to this file (.js), or its TypeScript source under the test runner. */
function workerScript(): URL {
  const js = new URL('./render-worker.js', import.meta.url);
  return existsSync(fileURLToPath(js)) ? js : new URL('./render-worker.ts', import.meta.url);
}

export interface TypstRendererOptions {
  assetsDir?: string;
  /** per render (default 15 s) */
  timeoutMs?: number;
  /** threads (default 1, max 4) */
  concurrency?: number;
}

interface Pending {
  job: RenderJob;
  resolve: (pdf: Buffer) => void;
  reject: (error: Error) => void;
}

/** One thread and the job it is running. */
interface Slot {
  worker: Worker | null;
  current: (Pending & { timer: NodeJS.Timeout }) | null;
}

/**
 * {@link PdfRenderer} on Typst (ADR 008): a small pool of `worker_threads` threads, each with its own compiler,
 * created at first use; a FIFO queue in front; a hard time limit per render — a render that exceeds it gets its thread
 * terminated (and replaced at the next job) and fails with `PdfRenderError('timeout')`. Engine errors (template or
 * data) fail with `PdfRenderError('error')`. A thread that dies fails its job the same way and is replaced.
 */
export class TypstPdfRenderer extends PdfRenderer {
  readonly engine = `typst ${TYPST_VERSION} / typst-ts ${bindingVersion()}`;
  private readonly assetsDir: string;
  private readonly timeoutMs: number;
  private readonly slots: Slot[];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: TypstRendererOptions = {}) {
    super();
    this.assetsDir = pdfAssetsDir(options.assetsDir);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 1));
    this.slots = Array.from({ length: concurrency }, () => ({ worker: null, current: null }));
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
    // never hand Typst an input that could exhaust memory: that would abort the process, not fail the render
    const unsafe = unsafeRenderInput(job);
    if (unsafe) return Promise.reject(new PdfRenderError('error', unsafe));
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  /** Nest lifecycle (the platform module provides this adapter through a factory). */
  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  /** Stops every thread (Nest shutdown / end of a script). Pending renders fail. */
  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) pending.reject(new PdfRenderError('error', 'renderer closed'));
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.current) this.finish(slot, new PdfRenderError('error', 'renderer closed'));
        const worker = slot.worker;
        slot.worker = null;
        if (worker) await worker.terminate();
      }),
    );
  }

  private spawn(slot: Slot): Worker {
    const data: RenderWorkerData = { templatesDir: path.join(this.assetsDir, 'templates'), fontsDir: path.join(this.assetsDir, 'fonts') };
    // no inherited CLI flags (e.g. --input-type, --inspect): the thread only runs the render script
    const worker = new Worker(workerScript(), { workerData: data, execArgv: [] });
    worker.on('message', (reply: RenderReply) => {
      if (!slot.current || slot.current.job.id !== reply.id) return;
      if (reply.ok) this.finish(slot, null, Buffer.from(reply.pdf.buffer, reply.pdf.byteOffset, reply.pdf.byteLength));
      else this.finish(slot, new PdfRenderError('error', reply.error));
    });
    const onDeath = (reason: string) => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      if (slot.current) this.finish(slot, new PdfRenderError('error', `render thread stopped: ${reason}`));
    };
    worker.on('error', (error) => onDeath(error.message));
    worker.on('exit', (code) => onDeath(`exit ${code}`));
    slot.worker = worker;
    return worker;
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.current || this.closed) continue;
      const next = this.queue.shift();
      if (!next) return;
      const worker = slot.worker ?? this.spawn(slot);
      const timer = setTimeout(() => {
        // a runaway render: kill the thread (the only way to stop native code) and fail the job
        const stuck = slot.worker;
        slot.worker = null;
        this.finish(slot, new PdfRenderError('timeout', `render exceeded ${this.timeoutMs} ms`));
        void stuck?.terminate();
      }, this.timeoutMs);
      slot.current = { ...next, timer };
      // worker_threads Worker (not window.postMessage): there is no target origin
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker.postMessage(next.job);
    }
  }

  private finish(slot: Slot, error: Error | null, pdf?: Buffer): void {
    const current = slot.current;
    if (!current) return;
    clearTimeout(current.timer);
    slot.current = null;
    if (error) current.reject(error);
    else current.resolve(pdf ?? Buffer.alloc(0));
    this.pump();
  }
}
