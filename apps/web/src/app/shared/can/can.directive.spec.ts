import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { Session } from '../../core/auth/session';
import { CanDirective } from './can.directive';

@Component({
  imports: [CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button *appCan="'access.grant'" id="grant" (click)="clicks.set(clicks() + 1)">Grant</button>
    <p *appCan="code(); else denied" id="guarded">allowed</p>
    <ng-template #denied><p id="denied">read only</p></ng-template>
  `,
})
class Host {
  readonly code = signal('access.manage_roles');
  readonly clicks = signal(0);
}

const $ = (el: HTMLElement, id: string) => el.querySelector(`#${id}`);

describe('*appCan', () => {
  let fixture: ComponentFixture<Host>;
  let session: Session;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    session = TestBed.inject(Session);
  });

  async function render(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }


  it('hides the element when signed out / without the permission, and shows the else template', async () => {
    const el = await render();

    expect($(el, 'grant')).toBeNull();
    expect($(el, 'guarded')).toBeNull();
    expect($(el, 'denied')?.textContent).toBe('read only');
  });

  it('shows the element when the permission is held anywhere; the else template is not rendered', async () => {
    session.set(meWith(['access.grant', 'access.manage_roles']));
    const el = await render();

    expect($(el, 'grant')?.textContent).toBe('Grant');
    expect($(el, 'guarded')?.textContent).toBe('allowed');
    expect($(el, 'denied')).toBeNull();
  });

  it('reacts to a permission change without re-creating an unchanged view', async () => {
    session.set(meWith(['access.grant']));
    const el = await render();
    const button = $(el, 'grant');
    expect(button).not.toBeNull();
    expect($(el, 'denied')).not.toBeNull();

    session.set(meWith(['access.grant', 'access.manage_roles']));
    await fixture.whenStable();
    expect($(el, 'guarded')).not.toBeNull();
    expect($(el, 'denied')).toBeNull();
    expect($(el, 'grant')).toBe(button); // same DOM node: the view was kept

    session.clear();
    await fixture.whenStable();
    expect($(el, 'grant')).toBeNull();
    expect($(el, 'guarded')).toBeNull();
    expect($(el, 'denied')).not.toBeNull();
  });

  it('reacts to its input changing, and the stamped view keeps its bindings live', async () => {
    session.set(meWith(['access.grant']));
    const el = await render();
    fixture.componentInstance.code.set('access.grant');
    await fixture.whenStable();
    expect($(el, 'guarded')).not.toBeNull();

    (el.querySelector('#grant') as HTMLButtonElement).click();
    expect(fixture.componentInstance.clicks()).toBe(1);
  });
});
