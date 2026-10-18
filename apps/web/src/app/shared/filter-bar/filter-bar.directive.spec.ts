import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { bareItemsAlone, FilterBar, NO_LABEL_LINE } from './filter-bar.directive';

/** Fakes the layout jsdom does not do: each child's top and margin. */
function place(element: Element | undefined, top: number, margin = 0): void {
  if (!element) throw new Error('missing item');
  Object.defineProperty(element, 'offsetTop', { configurable: true, value: top });
  (element as HTMLElement).style.marginBlockStart = `${margin}px`;
}

function bar(): HTMLElement {
  const form = document.createElement('form');
  form.innerHTML = '<div class="field">a</div><div class="field">b</div><button class="btn">clear</button>';
  return form;
}

describe('bareItemsAlone', () => {
  it('keeps a bare item that shares its line with fields (its top is the line top plus its label-line margin)', () => {
    const form = bar();
    const [a, b, clear] = Array.from(form.children);
    place(a, 10);
    place(b, 10);
    place(clear, 34, 24);
    expect(bareItemsAlone(form)).toEqual([]);
  });

  it('marks a bare item wrapped onto a line without a field', () => {
    const form = bar();
    const [a, b, clear] = Array.from(form.children);
    place(a, 10);
    place(b, 10);
    place(clear, 104, 24);
    expect(bareItemsAlone(form)).toEqual([clear]);
  });

  it('a field on the wrapped line keeps the bare item level with the inputs', () => {
    const form = bar();
    const [a, b, clear] = Array.from(form.children);
    place(a, 10);
    place(b, 80);
    place(clear, 104, 24);
    expect(bareItemsAlone(form)).toEqual([]);
  });
});

@Component({
  imports: [FilterBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<form class="filters" appFilterBar><div class="field">a</div><button class="btn">clear</button></form>`,
})
class Host {}

describe('FilterBar', () => {
  it('toggles the class after the first render', async () => {
    const fixture = TestBed.createComponent(Host);
    const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
    const [field, clear] = Array.from(form.children);
    place(field, 10);
    place(clear, 104, 24);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(clear?.classList.contains(NO_LABEL_LINE)).toBe(true);
    expect(field?.classList.contains(NO_LABEL_LINE)).toBe(false);
  });
});

describe('FilterBar on resize', () => {
  it('re-checks in the next frame, not inside the ResizeObserver callback (no "ResizeObserver loop" error)', async () => {
    let observed: (() => void) | undefined;
    class FakeResizeObserver {
      constructor(callback: () => void) {
        observed = callback;
      }
      observe(): void {}
      disconnect(): void {}
    }
    const original = (window as { ResizeObserver?: unknown }).ResizeObserver;
    (window as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    try {
      const fixture = TestBed.createComponent(Host);
      const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
      const [field, clear] = Array.from(form.children);
      place(field, 10);
      place(clear, 34, 24);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(clear?.classList.contains(NO_LABEL_LINE)).toBe(false);
      place(clear, 104, 24); // the bar got narrower: the button wrapped
      observed?.();
      expect(clear?.classList.contains(NO_LABEL_LINE)).toBe(false);
      frames.at(-1)?.(0);
      expect(clear?.classList.contains(NO_LABEL_LINE)).toBe(true);
    } finally {
      raf.mockRestore();
      (window as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });
});
