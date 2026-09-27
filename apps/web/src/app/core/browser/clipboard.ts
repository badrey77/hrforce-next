/**
 * `copyText()` — put text on the clipboard. Plain TypeScript over the browser's async Clipboard API.
 *
 * `navigator.clipboard.writeText()` needs a secure context (HTTPS or localhost) and, in most browsers, a user gesture
 * (it is called from a click handler here). It can still refuse (permissions, an old browser, jsdom), so this resolves
 * `false` instead of throwing and the caller says "select and copy by hand" — the text is always also on screen.
 */
export async function copyText(text: string, nav: Pick<Navigator, 'clipboard'> | undefined = globalThis.navigator): Promise<boolean> {
  try {
    if (!nav?.clipboard?.writeText) return false;
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
