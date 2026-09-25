import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OrgUnitSummary } from '../../core/org/org.models';
import { ORG_UNIT_PICKER_DEBOUNCE_MS, OrgUnitPicker } from './org-unit-picker';

const CENTRE: OrgUnitSummary = {
  id: 'r-centre',
  kind: 'region',
  code: 'CENTRE',
  name: 'Région Centre',
  path: [{ id: 'c-1', name: 'Groupe Démo' }],
};
const EST: OrgUnitSummary = { id: 'r-est', kind: 'region', code: 'EST', name: 'Région Est', path: CENTRE.path };

@Component({
  imports: [ReactiveFormsModule, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-org-unit-picker [formControl]="control" inputId="parent" [kinds]="['region']" asOf="2025-01-31" />`,
})
class Host {
  readonly control = new FormControl<string | null>(null);
}

const isSearch = (req: { url: string }) => req.url === '/api/org/units';

describe('OrgUnitPicker', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [Host, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  function input(): HTMLInputElement {
    const found = el.querySelector('#parent');
    if (!(found instanceof HTMLInputElement)) throw new Error('missing picker input');
    return found;
  }

  function type(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function key(name: string): void {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
    fixture.detectChanges();
  }

  function respond(req: TestRequest, items: OrgUnitSummary[]): void {
    req.flush({ items });
    fixture.detectChanges();
  }

  it('debounces typing into one request with q, the single kind and asOf', () => {
    type('c');
    type('ce');
    vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS - 1);
    http.expectNone(isSearch);

    vi.advanceTimersByTime(1);
    const req = http.expectOne(isSearch);
    expect(req.request.urlWithParams).toBe('/api/org/units?q=ce&kind=region&asOf=2025-01-31');
    respond(req, [CENTRE]);

    expect(el.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(el.querySelector('[role="option"]')?.textContent).toContain('Groupe Démo');
    expect(input().getAttribute('aria-expanded')).toBe('true');
  });

  it('cancels a stale search when the user keeps typing (switchMap)', () => {
    type('c');
    vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS);
    const stale = http.expectOne(isSearch);

    type('ce');
    vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS);
    const fresh = http.expectOne(isSearch);

    expect(stale.cancelled).toBe(true);
    expect(fresh.request.params.get('q')).toBe('ce');
    respond(fresh, [CENTRE]);
  });

  it('moves the active option with arrows and writes the id to the form on Enter', () => {
    type('r');
    vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS);
    respond(http.expectOne(isSearch), [CENTRE, EST]);

    expect(input().getAttribute('aria-activedescendant')).toBe('parent-option-0');
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('parent-option-1');
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('parent-option-0');
    key('ArrowUp');
    key('Enter');

    expect(fixture.componentInstance.control.value).toBe('r-est');
    expect(input().value).toBe('Région Est (EST)');
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape without changing the value, and typing clears a previous choice', () => {
    type('r');
    vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS);
    respond(http.expectOne(isSearch), [CENTRE]);
    key('Enter');
    expect(fixture.componentInstance.control.value).toBe('r-centre');

    type('Régi');
    expect(fixture.componentInstance.control.value).toBeNull();
    key('Escape');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
    vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS);
    http.expectOne(isSearch).flush({ items: [] });
  });

  it('shows the label of a value set by the form', () => {
    fixture.componentInstance.control.setValue('r-centre');
    http.expectOne('/api/org/units/r-centre').flush({ ...CENTRE, createdAt: '', versions: [], _actions: [] });
    fixture.detectChanges();

    expect(input().value).toBe('Région Centre (CENTRE)');
  });

  it('follows the form control disabled state', () => {
    fixture.componentInstance.control.disable();
    fixture.detectChanges();
    expect(input().disabled).toBe(true);

    fixture.componentInstance.control.enable();
    fixture.detectChanges();
    expect(input().disabled).toBe(false);
  });

  it('marks the control touched when focus leaves the picker', () => {
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(fixture.componentInstance.control.touched).toBe(true);
  });
});
