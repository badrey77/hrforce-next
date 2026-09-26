/**
 * Testing `@defer` blocks. TestBed has two modes (`deferBlockBehavior` in `configureTestingModule`):
 * - `DeferBlockBehavior.Playthrough` (the default): blocks behave as in a browser — triggers fire, the chunk is
 *   loaded, `@loading` then the content appear. Good for "does the page work end to end". Triggers need what the
 *   browser gives: `on viewport` needs an `IntersectionObserver` (faked here, jsdom has none).
 * - `DeferBlockBehavior.Manual`: triggers are ignored; the block stays on `@placeholder` until the test asks for a
 *   state with `(await fixture.getDeferBlocks())[i].render(DeferBlockState.Loading | Complete | Error)`. Good for
 *   testing each sub-block (placeholder, loading, error) deterministically, without timing.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { PAGE_2 } from '../../../testing/audit-fixtures';
import { ME_FIXTURE, ME_LECTURE } from '../../../testing/auth-fixtures';
import { enterViewport, installIntersectionObserver } from '../../../testing/intersection-observer';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { HistoryTabs } from './history-tabs';

@Component({
  imports: [HistoryTabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-history-tabs [subject]="subject()">
      <p data-test="details">Détails de la page</p>
      <input id="draft" />
    </app-history-tabs>
  `,
})
class Host {
  readonly subject = signal<string | null>('role:r-1');
}

const isTimeline = (r: { url: string }) => r.url === '/api/audit/timeline';

/** An open request keeps the app "unstable", so `whenStable()` would wait for it: tick and yield instead. */
async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('<app-history-tabs>', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const tab = (name: string) => el().querySelector(`[data-tab="${name}"]`) as HTMLButtonElement | null;
  const detailsPanel = () => el().querySelector('[data-panel="details"]') as HTMLElement;

  async function setup(behavior: DeferBlockBehavior, me = ME_FIXTURE): Promise<void> {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
      deferBlockBehavior: behavior,
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(me);
    fixture = TestBed.createComponent(Host);
    await settle();
  }

  afterEach(() => http.verify());

  it('without audit.read: the content alone, no tabs, no request', async () => {
    await setup(DeferBlockBehavior.Playthrough, ME_LECTURE);
    expect(el().querySelector('[role="tablist"]')).toBeNull();
    expect(detailsPanel().hidden).toBe(false);
    expect(el().querySelector('[data-test="details"]')?.textContent).toBe('Détails de la page');
    http.expectNone(isTimeline);
  });

  it('without a subject (e.g. a role being created): no tabs either', async () => {
    await setup(DeferBlockBehavior.Playthrough);
    fixture.componentInstance.subject.set(null);
    await settle();
    expect(el().querySelector('[role="tablist"]')).toBeNull();
  });

  it('Manual: placeholder until told otherwise, then loading, then the timeline (which fetches)', async () => {
    await setup(DeferBlockBehavior.Manual);
    expect(tab('details')?.getAttribute('aria-selected')).toBe('true');
    expect(el().querySelector('[data-panel="history"]')).toBeNull(); // not even the placeholder before the click

    tab('history')?.click();
    await settle();
    expect(tab('history')?.getAttribute('aria-selected')).toBe('true');
    expect(detailsPanel().hidden).toBe(true);
    expect(el().querySelector('[data-defer="placeholder"]')).not.toBeNull();
    http.expectNone(isTimeline); // Manual mode: the viewport trigger is ignored

    const [block] = await fixture.getDeferBlocks();
    await block?.render(DeferBlockState.Loading);
    expect(el().querySelector('[data-defer="loading"]')).not.toBeNull();

    await block?.render(DeferBlockState.Complete);
    await settle();
    expect(el().querySelector('app-timeline')).not.toBeNull();
    const req = http.expectOne(isTimeline);
    expect(req.request.params.get('subject')).toBe('role:r-1');
    req.flush(PAGE_2);
  });

  it('Manual: the @error sub-block (the chunk failed to download)', async () => {
    await setup(DeferBlockBehavior.Manual);
    tab('history')?.click();
    await settle();
    const [block] = await fixture.getDeferBlocks();
    await block?.render(DeferBlockState.Error);
    expect(el().querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      'Impossible d’afficher l’historique. Rechargez la page.',
    );
  });

  it('Playthrough: opening History + entering the viewport loads the chunk and the timeline', async () => {
    installIntersectionObserver();
    await setup(DeferBlockBehavior.Playthrough);
    tab('history')?.click();
    await settle();
    expect(el().querySelector('[data-defer="placeholder"]')).not.toBeNull();
    http.expectNone(isTimeline);

    enterViewport(); // the placeholder "scrolled into view": the `on viewport` trigger fires
    // The dependency chunk is a dynamic import(): give it a few turns of the event loop.
    for (let i = 0; i < 20 && !el().querySelector('app-timeline'); i++) await settle();
    expect(el().querySelector('app-timeline')).not.toBeNull();
    await settle(); // the timeline's resource sends its request on the next tick
    http.expectOne(isTimeline).flush(PAGE_2);
    await settle();
    expect(el().querySelectorAll('app-timeline .entry').length).toBe(1);
  });

  it('projected content is hidden, not destroyed: an unsaved input survives a trip to History', async () => {
    await setup(DeferBlockBehavior.Manual);
    const draft = el().querySelector('#draft') as HTMLInputElement;
    draft.value = 'brouillon';
    tab('history')?.click();
    await settle();
    tab('details')?.click();
    await settle();
    expect(el().querySelector('#draft')).toBe(draft);
    expect((el().querySelector('#draft') as HTMLInputElement).value).toBe('brouillon');
    expect(el().querySelector('[data-panel="history"]')).toBeNull();
  });

  it('a new subject brings the Details tab back', async () => {
    await setup(DeferBlockBehavior.Manual);
    tab('history')?.click();
    await settle();
    fixture.componentInstance.subject.set('role:r-2');
    await settle();
    expect(tab('details')?.getAttribute('aria-selected')).toBe('true');
  });
});
