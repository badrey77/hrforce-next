import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { listItem, page } from '../../../testing/employee-fixtures';
import { conflict, PERSON } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OrgUnitDetail } from '../../core/org/org.models';
import { EMPLOYEE_PICKER_DEBOUNCE_MS } from '../../shared/employee-picker/employee-picker';
import { UnitHead } from './unit-head';

const UNIT: OrgUnitDetail = {
  id: 'a-annaba',
  kind: 'agency',
  code: 'AG-ANNABA',
  name: 'Agence Annaba',
  site: null,
  path: [],
  siteInherited: false,
  createdAt: '2025-01-01T00:00:00Z',
  versions: [],
  _actions: ['update'],
  head: { employmentId: 'e-1', matricule: 'EMP-0001', person: PERSON, validFrom: '2025-01-01', validTo: null },
};

@Component({
  imports: [UnitHead],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-unit-head [unit]="unit()" [canEdit]="canEdit()" (saved)="saved.set(saved() + 1)" />`,
})
class Host {
  readonly unit = signal<OrgUnitDetail>(UNIT);
  readonly canEdit = signal(true);
  readonly saved = signal(0);
}

async function settle(fixture: ComponentFixture<Host>): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  fixture.detectChanges();
}

describe('UnitHead (head of unit form)', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await settle(fixture);
  });

  afterEach(() => http.verify());

  it('shows the current head, or "none"; no button without the unit update action', async () => {
    expect(el.querySelector('[data-field="head"]')?.textContent).toContain('BENALI Amina');
    expect(el.querySelector('[data-field="head"]')?.textContent).toContain('EMP-0001');
    fixture.componentInstance.unit.set({ ...UNIT, head: null });
    fixture.componentInstance.canEdit.set(false);
    await settle(fixture);
    expect(el.querySelector('[data-field="head"]')?.textContent?.trim()).toBe('Aucun responsable désigné.');
    expect(el.querySelector('[data-action="set-head"]')).toBeNull();
  });

  it('picks an employee and a date, PUTs /org/units/:id/head, and maps head-date to the date field', async () => {
    (el.querySelector('[data-action="set-head"]') as HTMLButtonElement).click();
    await settle(fixture);
    el.querySelector('[data-form="head"]')?.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(el.querySelector('#head-employee-error')?.textContent?.trim()).toBe('Choisissez un employé dans la liste.');

    const input = el.querySelector('#head-employee') as HTMLInputElement;
    input.value = 'had';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, EMPLOYEE_PICKER_DEBOUNCE_MS + 10));
    http.expectOne((r) => r.url === '/api/employees').flush(page([listItem({ id: 'e-9', matricule: 'EMP-0009' })]));
    await settle(fixture);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    const date = el.querySelector('#head-valid-from') as HTMLInputElement;
    date.value = '2026-10-01';
    date.dispatchEvent(new Event('input'));
    el.querySelector('[data-form="head"]')?.dispatchEvent(new Event('submit'));

    const put = http.expectOne('/api/org/units/a-annaba/head');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ employmentId: 'e-9', validFrom: '2026-10-01' });
    put.flush(...conflict('head-date'));
    await settle(fixture);
    expect(el.querySelector('#head-valid-from-error')?.textContent).toContain('Un responsable commence déjà');

    el.querySelector('[data-form="head"]')?.dispatchEvent(new Event('submit'));
    await settle(fixture);
    http.expectNone('/api/org/units/a-annaba/head'); // the server error must be cleared by editing the date first
    date.value = '2026-10-02';
    date.dispatchEvent(new Event('input'));
    el.querySelector('[data-form="head"]')?.dispatchEvent(new Event('submit'));
    http.expectOne('/api/org/units/a-annaba/head').flush({});
    await settle(fixture);
    expect(fixture.componentInstance.saved()).toBe(1);
    expect(el.querySelector('[data-form="head"]')).toBeNull();
    expect(el.querySelector('.feedback')?.textContent?.trim()).toBe('Responsable enregistré.');
  });
});
