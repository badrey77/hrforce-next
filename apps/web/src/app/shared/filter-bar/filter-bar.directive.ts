/**
 * `<form class="filters" appFilterBar>` — keeps a bare button or checkbox of a filter bar level with the inputs.
 *
 * In `.filters` the fields align on their labels (top), so a bare item (no label) starts one label line lower
 * (`styles.css`). When the bar wraps and such an item lands on a line without any field, that offset is only an empty
 * gap: this directive marks the bare items of such lines with `.no-label-line`, which removes it. It re-checks when the
 * bar is resized and when items come and go (`@if`).
 */
import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

export const NO_LABEL_LINE = 'no-label-line';

/** The items of `bar` grouped by line (same top, margin excluded), then the bare items of lines without a field. */
export function bareItemsAlone(bar: HTMLElement): HTMLElement[] {
  const view = bar.ownerDocument.defaultView;
  const lines: { top: number; items: HTMLElement[] }[] = [];
  for (const child of Array.from(bar.children)) {
    if (!(child instanceof HTMLElement)) continue;
    // a bare item's label-line margin must not separate it from the fields of its line
    const margin = Number.parseFloat(view?.getComputedStyle(child).marginBlockStart ?? '') || 0;
    const top = child.offsetTop - margin;
    const line = lines.find((l) => Math.abs(l.top - top) < 2);
    if (line) line.items.push(child);
    else lines.push({ top, items: [child] });
  }
  return lines.filter((l) => !l.items.some((item) => item.classList.contains('field'))).flatMap((l) => l.items);
}

@Directive({ selector: '[appFilterBar]' })
export class FilterBar {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const bar = this.element.nativeElement;
      const view = bar.ownerDocument.defaultView;
      const update = () => {
        const alone = new Set(bareItemsAlone(bar));
        for (const child of Array.from(bar.children)) child.classList.toggle(NO_LABEL_LINE, alone.has(child as HTMLElement));
      };
      update();
      // Toggling the class resizes the bar: done inside the observer's callback, that is a "ResizeObserver loop"
      // error (reported by the global error listeners). The next frame is soon enough.
      let frame = 0;
      const later = () => {
        if (!view?.requestAnimationFrame) return update();
        view.cancelAnimationFrame(frame);
        frame = view.requestAnimationFrame(update);
      };
      const resize = view && 'ResizeObserver' in view ? new view.ResizeObserver(later) : null;
      resize?.observe(bar);
      const mutation = view && 'MutationObserver' in view ? new view.MutationObserver(update) : null;
      mutation?.observe(bar, { childList: true });
      destroyRef.onDestroy(() => {
        view?.cancelAnimationFrame?.(frame);
        resize?.disconnect();
        mutation?.disconnect();
      });
    });
  }
}
