/**
 * jsdom has no `IntersectionObserver` (it does no layout, so nothing is ever "in the viewport"). Angular's
 * `@defer (on viewport)` trigger needs one. This fake records what is observed and lets a test say when it
 * "scrolled into view": `enterViewport()` reports every observed element as intersecting.
 * Install it in `beforeEach` of specs that play a `@defer (on viewport)` block through (DeferBlockBehavior.Playthrough).
 */
class FakeIntersectionObserver {
  static readonly instances = new Set<FakeIntersectionObserver>();
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [0];
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    FakeIntersectionObserver.instances.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(): void {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
    if (entries.length) this.callback(entries, this as unknown as IntersectionObserver);
  }
}

export function installIntersectionObserver(): void {
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  });
}

/** Every element currently observed "enters the viewport". */
export function enterViewport(): void {
  for (const observer of FakeIntersectionObserver.instances) observer.fire();
}
