import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, describe, expect, it } from 'vitest';
import { PdfRenderError } from './pdf-renderer.js';
import { pdfAssetsDir, TypstPdfRenderer } from './typst-renderer.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function text(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  return (await extractText(doc, { mergePages: true })).text;
}

const tiny = { v: 1, lang: 'fr', number: 'T-2026-1' };

describe('TypstPdfRenderer (child processes)', () => {
  // a scratch assets dir: the real fonts + probe templates (a trivial one, a broken one, a slow one)
  const dir = mkdtempSync(path.join(tmpdir(), 'hrforce-pdf-'));
  cpSync(path.join(pdfAssetsDir(), 'fonts'), path.join(dir, 'fonts'), { recursive: true });
  cpSync(path.join(pdfAssetsDir(), 'templates'), path.join(dir, 'templates'), { recursive: true });
  writeFileSync(
    path.join(dir, 'templates', 'probe.typ'),
    '#let d = json(bytes(sys.inputs.data))\n#set document(date: datetime(year: 2026, month: 1, day: 2))\n#set text(font: "Source Sans 3")\nNuméro #d.number — #d.at("note", default: "")\n',
  );
  writeFileSync(path.join(dir, 'templates', 'broken.typ'), '#let x = (\n');
  // CPU-bound with bounded memory (~15 s alone): far longer than the limit below. (When renders ran in a thread, the
  // former `range(400000000)` grew to an 8 GiB allocation that aborted the whole test process; a render process now
  // takes such a fault alone.)
  writeFileSync(path.join(dir, 'templates', 'slow.typ'), '#let n = 0\n#for i in range(6000) { for j in range(6000) { n = n + 1 } }\n#n\n');
  // memory-hungry: an array of 40 million values grows the process well past the small ceiling of `hungry` below
  writeFileSync(path.join(dir, 'templates', 'greedy.typ'), '#let a = range(40000000)\n#a.len()\n');
  // 5 s: the limit also covers the cold start of a process (spawn, loading the binding and the fonts), which can take
  // well over a second while the whole suite runs in parallel; the slow template still runs far longer than that
  const renderer = new TypstPdfRenderer({ assetsDir: dir, timeoutMs: 5000 });
  const hungry = new TypstPdfRenderer({ assetsDir: dir, timeoutMs: 20_000, maxMemoryBytes: 300 * 1024 * 1024 });
  afterAll(async () => {
    await renderer.close();
    await hungry.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders PDF/A-2b with the data, deterministically, and never evaluates data as markup', async () => {
    const data = { ...tiny, note: '#panic("pwned") *bold* $x^2$ #read("/etc/passwd")' };
    const a = await renderer.render({ template: 'probe', data });
    const b = await renderer.render({ template: 'probe', data });
    expect(a.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
    expect(a.toString('latin1')).toMatch(/pdfaid:part(>|=")2/);
    const content = await text(a);
    expect(content).toContain('T-2026-1');
    expect(content).toContain('#panic("pwned")');
    expect(renderer.engine).toMatch(/^typst 0\.14\.2 \/ typst-ts 0\.7\.0$/);
  }, 20_000);

  it('fails with PdfRenderError(error) on a template error, and keeps working', async () => {
    await expect(renderer.render({ template: 'broken', data: tiny })).rejects.toMatchObject({ name: 'PdfRenderError', reason: 'error' });
    await expect(renderer.render({ template: 'missing_template', data: tiny })).rejects.toBeInstanceOf(PdfRenderError);
    await expect(renderer.render({ template: '../escape', data: tiny })).rejects.toBeInstanceOf(PdfRenderError);
    expect((await renderer.render({ template: 'probe', data: tiny })).length).toBeGreaterThan(1000);
  });

  it('kills a render that exceeds the time limit (timeout): the process is gone, a new one serves the next render', async () => {
    const slow = renderer.render({ template: 'slow', data: tiny });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [pid] = renderer.processIds();
    await expect(slow).rejects.toMatchObject({ reason: 'timeout' });
    expect(pid).toBeDefined();
    await expect.poll(() => alive(pid ?? 0), { timeout: 2000 }).toBe(false);
    expect((await text(await renderer.render({ template: 'probe', data: tiny })))).toContain('T-2026-1');
    expect(renderer.processIds()).not.toContain(pid);
  }, 20_000);

  it('a render process that dies mid-render (a native crash) fails that render only; the next one works', async () => {
    const slow = renderer.render({ template: 'slow', data: tiny });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [pid] = renderer.processIds();
    process.kill(pid ?? 0, 'SIGKILL');
    await expect(slow).rejects.toMatchObject({ name: 'PdfRenderError', reason: 'error', message: expect.stringMatching(/render process stopped/) });
    expect((await text(await renderer.render({ template: 'probe', data: tiny })))).toContain('T-2026-1');
  }, 20_000);

  it.runIf(existsSync('/proc/self/status'))('kills a render that grows past the memory ceiling (memory), and keeps working', async () => {
    await expect(hungry.render({ template: 'greedy', data: tiny })).rejects.toMatchObject({ reason: 'memory' });
    expect((await hungry.render({ template: 'probe', data: tiny })).length).toBeGreaterThan(1000);
  }, 30_000);

  it.runIf(existsSync('/proc/self/environ'))('the render process gets no environment (no secret of the API)', async () => {
    await renderer.render({ template: 'probe', data: tiny });
    const [pid] = renderer.processIds();
    // only what Node adds itself for the IPC channel
    const names = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((v) => v.split('=')[0]);
    expect(names.every((n) => n?.startsWith('NODE_CHANNEL_'))).toBe(true);
  });

  it('queues concurrent renders', async () => {
    const pdfs = await Promise.all(Array.from({ length: 8 }, (_, i) => renderer.render({ template: 'probe', data: { ...tiny, number: `Q-${i}` } })));
    const texts = await Promise.all(pdfs.map(text));
    texts.forEach((t, i) => expect(t).toContain(`Q-${i}`));
  });
});
