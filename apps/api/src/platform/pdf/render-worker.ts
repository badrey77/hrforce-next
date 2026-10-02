/**
 * PDF render process (ADR 008 › Decision 1, child-process fallback): the Typst binding's `pdf()` is synchronous native
 * code, so it runs here, in a child process forked by typst-renderer.ts, never in the API process. A native fault, an
 * out-of-memory abort or a runaway render therefore ends this process only: the parent fails the job, kills or
 * replaces the process, and keeps serving. One compiler per process, created once with the vendored fonts passed as
 * in-memory blobs (no directory scan); templates are read from `templatesDir` (the workspace root).
 *
 * Self-contained on purpose (only node: built-ins and the binding): the same file runs compiled (dist/…/.js) and, in
 * tests, as TypeScript through Node's type stripping — so only erasable TypeScript syntax is allowed here.
 *
 * Protocol (IPC channel, `serialization: 'advanced'` so bytes travel as Uint8Array): the configuration arrives as the
 * single argv entry (JSON {@link RenderWorkerData}); the parent sends {@link RenderJob}; this process answers
 * {@link RenderReply} with the same id. It exits when the parent disconnects.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';

export interface RenderWorkerData {
  templatesDir: string;
  fontsDir: string;
}

export interface RenderJob {
  id: number;
  template: string;
  data: string;
  options: string;
  assets: { path: string; bytes: Uint8Array }[];
  standard: string | null;
}

export type RenderReply = { id: number; ok: true; pdf: Uint8Array } | { id: number; ok: false; error: string };

const TEMPLATE = /^[a-z][a-z0-9_]{0,63}$/;

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'shortDiagnostics' in error) {
    const diagnostics = (error as { shortDiagnostics: unknown }).shortDiagnostics;
    try {
      return JSON.stringify(diagnostics).slice(0, 2000);
    } catch {
      // fall through
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function send(reply: RenderReply): void {
  process.send?.(reply);
}

const config = JSON.parse(process.argv[2] ?? '{}') as RenderWorkerData;
const fontBlobs = readdirSync(config.fontsDir)
  .filter((f) => f.toLowerCase().endsWith('.ttf'))
  .toSorted()
  .map((f) => readFileSync(path.join(config.fontsDir, f)));
const compiler = NodeCompiler.create({ workspace: config.templatesDir, fontArgs: [{ fontBlobs }] });

process.on('message', (job: RenderJob) => {
  const mapped: string[] = [];
  let reply: RenderReply;
  try {
    if (!TEMPLATE.test(job.template)) throw new Error(`invalid template name ${job.template}`);
    for (const asset of job.assets) {
      const file = path.join(config.templatesDir, asset.path);
      compiler.mapShadow(file, Buffer.from(asset.bytes));
      mapped.push(file);
    }
    const pdf = compiler.pdf(
      { mainFilePath: path.join(config.templatesDir, `${job.template}.typ`), inputs: { data: job.data, render: job.options } },
      job.standard ? { pdfStandard: job.standard } : undefined,
    );
    reply = { id: job.id, ok: true, pdf: new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength) };
  } catch (error) {
    reply = { id: job.id, ok: false, error: describe(error) };
  } finally {
    for (const file of mapped) compiler.unmapShadow(file);
    // keep the compiler's memo cache bounded across many documents
    compiler.evictCache(10);
  }
  send(reply);
});

// the parent went away (shutdown, crash): nothing left to serve
process.on('disconnect', () => process.exit(0));
