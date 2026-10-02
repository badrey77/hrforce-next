import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { AttendancePolicySettings } from './attendance-policy-settings';

describe('AttendancePolicySettings', () => {
  let fixture: ComponentFixture<AttendancePolicySettings>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['attendance.configure']));
    fixture = TestBed.createComponent(AttendancePolicySettings);
    TestBed.tick();
    http.expectOne('/api/attendance/policy').flush({ retentionMonths: 60, minPunchGapSeconds: 120, correctionMaxAgeDays: 30, correctionWorkflowCode: 'attendance.manager_then_hr' });
    TestBed.tick();
    await Promise.resolve(); // the resource publishes its value after a microtask
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    fixture.destroy();
    http.verify();
  });

  function enter(id: string, value: string): void {
    const input = el().querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    TestBed.tick();
  }

  it('an out-of-range or fractional value names the allowed range, in each field', () => {
    enter('att-retention', '999');
    expect(el().querySelector('#att-retention-error')?.textContent).toContain('Un nombre entier entre 12 et 120.');
    enter('att-retention', '24.5');
    expect(el().querySelector('#att-retention-error')?.textContent).toContain('entre 12 et 120');
    enter('att-retention', '24');
    expect(el().querySelector('#att-retention-error')).toBeNull();
    enter('att-gap', '601');
    expect(el().querySelector('#att-gap-error')?.textContent).toContain('entre 0 et 600');
    enter('att-retention', '');
    expect(el().querySelector('#att-retention-error')?.textContent).toContain('Ce champ est obligatoire.');
  });

  it('in Arabic too', () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    enter('att-retention', '5');
    expect(el().querySelector('#att-retention-error')?.textContent).toContain('يرجى إدخال عدد صحيح بين 12 و120.');
  });
});
