/**
 * `downloadText()` — save a string as a file, from the browser, without a server round trip.
 *
 * How: wrap the text in a `Blob`, get a `blob:` URL for it (`URL.createObjectURL`), point a temporary `<a download>`
 * at it, click it, remove it, and revoke the URL so the memory is released.
 *
 * Why this is fine here (and why Angular is bypassed on purpose):
 * - It runs from the user's own click ("Download"), so browsers allow the download (no pop-up blocker involved).
 * - The `blob:` URL is SAME-ORIGIN and points at bytes this page just made from its own data (the recovery codes
 *   the API returned): nothing from another origin is fetched and no user-supplied URL is followed. That is why no
 *   sanitizer is needed: Angular sanitizes values BOUND IN TEMPLATES (`[href]`, `[src]`); this anchor is created in
 *   code, never rendered by a template, and never outlives the click.
 * - `download="…"` forces "save as" with our file name instead of navigating to the blob.
 * - The anchor is appended before `click()` because Firefox ignores clicks on detached anchors; revoking happens on
 *   the next task so the browser has started reading the blob first.
 *
 * `doc` is a parameter (the component passes `inject(DOCUMENT)`) so tests can observe the anchor.
 */
export function downloadText(doc: Document, fileName: string, text: string, type = 'text/plain;charset=utf-8'): void {
  const view = doc.defaultView ?? globalThis;
  const url = view.URL.createObjectURL(new Blob([text], { type }));
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
}
