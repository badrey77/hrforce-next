import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RevealAlert } from './reveal-alert.directive';

@Component({
  imports: [RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input id="field" />
    @if (error(); as e) {
      <p class="form-error" role="alert" [appRevealAlert]="e">{{ e.text }}</p>
    }
    <button id="submit" type="button">Submit</button>
  `,
})
class HostForm {
  readonly error = signal<{ text: string } | null>(null);
}

function setup() {
  const fixture = TestBed.createComponent(HostForm);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, submit: el.querySelector<HTMLButtonElement>('#submit') as HTMLButtonElement };
}

describe('RevealAlert', () => {
  let scrolled: HTMLElement[];

  beforeEach(() => {
    scrolled = [];
    // jsdom has no layout, hence no scrollIntoView: record the calls instead.
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
  });

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('scrolls the banner into view and focuses it when it appears, without adding it to the Tab order', async () => {
    const { fixture, el, submit } = setup();
    submit.focus();
    expect(scrolled).toEqual([]);

    fixture.componentInstance.error.set({ text: 'Le serveur a refusé.' });
    await fixture.whenStable();

    const banner = el.querySelector('[role="alert"]');
    expect(banner?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(banner);
    expect(scrolled).toEqual([banner]);
  });

  it('reveals again for a NEW message while the banner stays on screen (same text included)', async () => {
    const { fixture, el, submit } = setup();
    fixture.componentInstance.error.set({ text: 'Erreur' });
    await fixture.whenStable();
    submit.focus();

    fixture.componentInstance.error.set({ text: 'Erreur' });
    await fixture.whenStable();

    expect(document.activeElement).toBe(el.querySelector('[role="alert"]'));
    expect(scrolled).toHaveLength(2);
  });

  it('does nothing while there is no message', async () => {
    const { fixture, submit } = setup();
    submit.focus();
    fixture.componentInstance.error.set(null);
    await fixture.whenStable();

    expect(document.activeElement).toBe(submit);
    expect(scrolled).toEqual([]);
  });
});
