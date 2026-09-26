import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { detail, listItem, page } from '../../../testing/employee-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { EMPLOYEE_PICKER_DEBOUNCE_MS, EmployeePicker } from './employee-picker';

@Component({
  imports: [ReactiveFormsModule, EmployeePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-employee-picker [formControl]="control" inputId="emp" />`,
})
class Host {
  readonly control = new FormControl<string | null>(null, Validators.required);
}

const isSearch = (r: { url: string }) => r.url === '/api/employees';
const OTHER = listItem({ id: 'e-2', matricule: 'EMP-0002', person: { id: 'p-2', lastName: 'HADDAD', firstName: 'Karim', lastNameAr: null, firstNameAr: null } });

describe('EmployeePicker (ControlValueAccessor)', () => {
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
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
    vi.useRealTimers();
  });

  const input = () => el.querySelector('#emp') as HTMLInputElement;
  function type(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  function key(name: string): void {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
    fixture.detectChanges();
  }

  it('debounces the search, cancels a stale one, and sends active employees by q', () => {
    type('ben');
    vi.advanceTimersByTime(EMPLOYEE_PICKER_DEBOUNCE_MS);
    const stale = http.expectOne(isSearch);
    type('bena');
    vi.advanceTimersByTime(EMPLOYEE_PICKER_DEBOUNCE_MS - 1);
    http.expectNone(isSearch);
    vi.advanceTimersByTime(1);
    const fresh = http.expectOne(isSearch);
    expect(stale.cancelled).toBe(true);
    expect(fresh.request.params.get('q')).toBe('bena');
    expect(fresh.request.params.get('status')).toBe('active');
    expect(fresh.request.params.get('pageSize')).toBe('10');
    fresh.flush(page([listItem(), OTHER]));
    fixture.detectChanges();
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(el.querySelector('.status')?.textContent).toContain('2 employé(s) trouvé(s)');
  });

  it('writes the employment id on Enter; typing again clears it; the form stays invalid until a pick', () => {
    const control = fixture.componentInstance.control;
    type('h');
    vi.advanceTimersByTime(EMPLOYEE_PICKER_DEBOUNCE_MS);
    http.expectOne(isSearch).flush(page([listItem(), OTHER]));
    fixture.detectChanges();
    key('ArrowDown');
    key('Enter');
    expect(control.value).toBe('e-2');
    expect(control.valid).toBe(true);
    expect(input().value).toBe('HADDAD Karim (EMP-0002)');

    type('HADDAD K');
    expect(control.value).toBeNull();
    expect(control.valid).toBe(false);
    vi.advanceTimersByTime(EMPLOYEE_PICKER_DEBOUNCE_MS);
    http.expectOne(isSearch).flush(page([]));
  });

  it('labels a value set by the form (GET /employees/:id), in the UI language', () => {
    fixture.componentInstance.control.setValue('e-1');
    http.expectOne('/api/employees/e-1').flush(detail());
    fixture.detectChanges();
    expect(input().value).toBe('BENALI Amina (EMP-0001)');
    TestBed.inject(LanguageService).use('ar', { remember: false });
    TestBed.tick();
    fixture.detectChanges();
    expect(input().value).toBe('بن علي أمينة (EMP-0001)');
  });

  it('follows disabled state and reports touched on focus out', () => {
    const control = fixture.componentInstance.control;
    control.disable();
    fixture.detectChanges();
    expect(input().disabled).toBe(true);
    control.enable();
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(control.touched).toBe(true);
  });
});
