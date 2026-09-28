/**
 * `downloadText()` / `saveBlob()` — save bytes as a file, from the browser.
 *
 * How: get a `blob:` URL for a `Blob` (`URL.createObjectURL`), point a temporary `<a download>` at it, click it, remove
 * it, and revoke the URL so the memory is released. `downloadText()` wraps a string in a `Blob` first (recovery codes);
 * `saveBlob()` takes bytes the API sent (a PDF fetched with `responseType: 'blob'` — core/browser/blob-files.ts).
 *
 * Why this is fine here (and why Angular is bypassed on purpose):
 * - It runs from the user's own click ("Download"), so browsers allow the download (no pop-up blocker involved).
 * - The `blob:` URL is SAME-ORIGIN and points at bytes this page holds (made from its own data, or received from our
 *   own API): nothing from another origin is fetched and no user-supplied URL is followed. That is why no sanitizer
 *   is needed: Angular sanitizes values BOUND IN TEMPLATES (`[href]`, `[src]`); this anchor is created in code, never
 *   rendered by a template, and never outlives the click.
 * - `download="…"` forces "save as" with our file name instead of navigating to the blob.
 * - The anchor is appended before `click()` because Firefox ignores clicks on detached anchors; revoking happens on
 *   the next task so the browser has started reading the blob first.
 *
 * `doc` is a parameter (the component passes `inject(DOCUMENT)`) so tests can observe the anchor.
 */
export function downloadText(doc: Document, fileName: string, text: string, type = 'text/plain;charset=utf-8'): void {
  saveBlob(doc, fileName, new Blob([text], { type }));
}

export function saveBlob(doc: Document, fileName: string, blob: Blob): void {
  const view = doc.defaultView ?? globalThis;
  const url = view.URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
}

/**
 * A `Blob` as a `data:` URL (`data:image/png;base64,…`), for an `<img [src]>`.
 *
 * Why not an object URL here: the production Content-Security-Policy (deploy/Caddyfile) allows images from `'self'`
 * and `data:` only — a `blob:` image would be blocked. A data URL is also safe for Angular's URL sanitizer, which lets
 * `data:image/…` through `[src]` (chapter 17). Fine for a logo (≤ 256 KB); a large file would rather use `blob:`.
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(typeof reader.result === 'string' ? reader.result : ''), { once: true });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')), { once: true });
    reader.readAsDataURL(blob);
  });
}
