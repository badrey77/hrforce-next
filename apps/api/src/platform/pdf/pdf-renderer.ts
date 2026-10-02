/**
 * Seam for PDF generation (ADR 008 › Decision 1): `render({template, data, assets, standard}) → PDF bytes`.
 * The port hides the engine (Typst through `@myriaddreamin/typst-ts-node-compiler` today, see typst-renderer.ts):
 * moving to the Typst CLI in a child process, or to Chromium, changes one adapter.
 *
 * Templates are files of the assets directory (`<PDF_ASSETS_DIR>/templates/<template>.typ`); they receive `data` as
 * ONE JSON string (`sys.inputs.data`) and `options` as another (`sys.inputs.render`) — strings are never evaluated as
 * markup. Binary assets (the company logo) are virtual files at `assets[].path` (absolute, from the templates root).
 */

export interface RenderAsset {
  /** virtual path from the templates root, e.g. `/__assets/logo-<sha>.png` */
  path: string;
  bytes: Uint8Array;
}

export interface RenderInput {
  /** template file name without `.typ`, e.g. `attestation_travail` */
  template: string;
  /** the template's data (`sys.inputs.data`) */
  data: unknown;
  /** rendering options that are not part of the record (`sys.inputs.render`), e.g. `{specimen: true, logo: '/…'}` */
  options?: Record<string, unknown>;
  assets?: readonly RenderAsset[];
  /** PDF standard; ADR 008: PDF/A-2b for issued documents */
  standard?: 'a-2b' | null;
}

/**
 * Why a render failed: the engine reported an error (bad template / data) or its process died, the time limit was
 * hit, or the render process grew past its memory ceiling.
 */
export type PdfRenderFailure = 'error' | 'timeout' | 'memory';

export class PdfRenderError extends Error {
  constructor(
    readonly reason: PdfRenderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PdfRenderError';
  }
}

export abstract class PdfRenderer {
  /** Engine and binding versions, stored with every document (e.g. `typst 0.14.2 / typst-ts 0.7.0`). */
  abstract readonly engine: string;

  /** Renders one document. Rejects with {@link PdfRenderError} (engine error or timeout). */
  abstract render(input: RenderInput): Promise<Buffer>;
}
