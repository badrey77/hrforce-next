import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, type Signal, signal } from '@angular/core';

/** The designer needs a wide screen; narrower ones get the versions list and the PDF previews only. */
export const WIDE_QUERY = '(min-width: 900px)';

/** Whether the screen is wide enough for the designer, following window resizes (true without `matchMedia`). */
export function wideScreen(): Signal<boolean> {
  const media = inject(DOCUMENT).defaultView?.matchMedia?.(WIDE_QUERY);
  const wide = signal(media?.matches ?? true);
  if (media) {
    const listener = (event: MediaQueryListEvent) => wide.set(event.matches);
    media.addEventListener?.('change', listener);
    inject(DestroyRef).onDestroy(() => media.removeEventListener?.('change', listener));
  }
  return wide.asReadonly();
}
