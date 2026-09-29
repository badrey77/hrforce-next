/**
 * `[appRevealAlert]` — brings a form's error banner into view and moves focus to it, each time a new message appears.
 *
 *   @if (formError(); as error) {
 *     <p class="form-error" role="alert" [appRevealAlert]="error">…</p>
 *   }
 *
 * Why: long forms (create employee, rehire, issue a document, upload a file…) show a server error at the TOP, but the
 * submit button is at the BOTTOM. On a 390 px phone the banner appeared off-screen: the user saw nothing happen.
 * `role="alert"` already makes screen readers announce the text; this directive fixes it for the eyes, and puts
 * keyboard focus where the explanation is (the next Tab goes on into the form from there).
 *
 * Angular concepts:
 * - **An attribute directive with an input named like its selector.** `[appRevealAlert]="error"` both attaches the
 *   directive and passes it a value, the way `[ngClass]="…"` does. The value is only a TRIGGER: every new error
 *   object (a new submit, a new server answer) re-runs the reveal, even when the `@if` block stays on screen from
 *   one failure to the next (a block whose condition stays truthy is updated, not re-created).
 * - **`host: { tabindex: '-1' }`** — static attributes set on the element the directive sits on. `tabindex="-1"`
 *   lets code call `focus()` on a `<p>`/`<div>` without adding it to the Tab order.
 * - **`afterRenderEffect()`** (chapter 16): an effect that runs AFTER Angular has written the DOM. A plain
 *   `effect()` could run before the banner's text is rendered; scrolling and focusing need the element laid out.
 *   It re-runs when the signals it reads change — here the `appRevealAlert` input.
 * - **`inject(ElementRef)`** — the host element, the one thing an attribute directive usually needs.
 * - Field-level errors are not affected: the banner is focused once per new message; the fields keep their own
 *   `aria-invalid` + `aria-describedby` messages, and the user tabs from the banner into the form.
 * - `scrollIntoView({ block: 'center' })` then `focus({ preventScroll: true })`: the banner lands mid-screen (not
 *   glued to the top edge), and focus does not scroll a second time. jsdom (unit tests) has no `scrollIntoView`,
 *   hence the optional call.
 */
import { afterRenderEffect, Directive, ElementRef, inject, input } from '@angular/core';

@Directive({
  selector: '[appRevealAlert]',
  host: { tabindex: '-1' },
})
export class RevealAlert {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The message shown by the banner: a new value (by reference) reveals it again. `null`/`undefined` = nothing to do. */
  readonly appRevealAlert = input<unknown>();

  constructor() {
    afterRenderEffect(() => {
      const trigger = this.appRevealAlert();
      if (trigger === null || trigger === undefined) return;
      const element = this.element.nativeElement;
      element.scrollIntoView?.({ block: 'center' });
      element.focus({ preventScroll: true });
    });
  }
}
