/**
 * jsdom has `<dialog>` but not its methods (`showModal()`, `close()`). Real browsers do. This installs the minimum
 * the app relies on: `showModal()` sets `open`; `close()` removes it and fires `close` (as browsers do, so a
 * `(close)` handler runs). Call it in `beforeEach` of specs that open a dialog.
 */
function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '');
}

function close(this: HTMLDialogElement): void {
  if (!this.hasAttribute('open')) return;
  this.removeAttribute('open');
  this.dispatchEvent(new Event('close'));
}

export function installDialogPolyfill(): void {
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
}
