/**
 * jsdom has no `IntersectionObserver` (it does no layout, so nothing is ever "in the viewport"). Angular's
 * `@defer (on viewport)` trigger needs one. This fake records what is observed and lets a test say when it
 * "scrolled into view": `enterViewport()` reports every observed element as intersecting.
 * Install it in `beforeEach` of specs that play a `@defer (on viewport)` block through (DeferBlockBehavior.Playthrough).
 */
import type { HttpRequest } from '@angular/common/http';
import type { HttpTestingController, TestRequest } from '@angular/common/http/testing';

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

/**
 * Plays a `@defer (on viewport)` block through until the request it should send is out, and returns that request.
 * Waiting a FIXED number of ticks is flaky: the block's dependencies arrive through a dynamic `import()`, which
 * takes longer when the whole suite runs in parallel workers, and the viewport observer may only start observing
 * after the first `enterViewport()`. So this re-fires the viewport and polls against a time budget instead.
 */
export async function untilDeferredRequest(
  http: HttpTestingController,
  match: (req: HttpRequest<unknown>) => boolean,
  settle: () => Promise<void>,
  timeoutMs = 5000,
): Promise<TestRequest> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    enterViewport();
    await settle();
    const [req, ...more] = http.match(match);
    if (more.length) throw new Error(`expected one deferred request, got ${more.length + 1}`);
    if (req) return req;
    if (Date.now() > deadline) throw new Error('the deferred block sent no matching request in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
