import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { USER_SAMIR } from '../../../testing/access-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { listItem, page } from '../../../testing/employee-fixtures';
import { conflict, PERSON } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { AccessUser } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { EMPLOYEE_PICKER_DEBOUNCE_MS } from '../../shared/employee-picker/employee-picker';
import { LinkedEmployee } from './linked-employee';

@Component({
  imports: [LinkedEmployee],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-linked-employee [user]="user()" (changed)="changed.set(changed() + 1)" />`,
})
class Host {
  readonly user = signal<AccessUser>({ ...USER_SAMIR, employment: null });
  readonly changed = signal(0);
}

async function settle(fixture: ComponentFixture<Host>): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  fixture.detectChanges();
}

describe('LinkedEmployee (Access › user)', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  async function create(permissions: string[]): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [Host, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(Session).set(meWith(permissions));
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await settle(fixture);
  }

  afterEach(() => http.verify());

  async function pick(id: string): Promise<void> {
    const input = el.querySelector('#link-employee') as HTMLInputElement;
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, EMPLOYEE_PICKER_DEBOUNCE_MS + 10));
    http.expectOne((r) => r.url === '/api/employees').flush(page([listItem({ id })]));
    await settle(fixture);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  }

  it('read-only viewers see the link state but no form', async () => {
    await create(['access.read']);
    expect(el.querySelector('[data-field="linked"]')?.textContent?.trim()).toBe("Ce compte n'est lié à aucun employé.");
    expect(el.querySelector('[data-form="link"]')).toBeNull();
  });

  it('without employee.read the picker is replaced by a hint', async () => {
    await create(['access.grant']);
    expect(el.querySelector('[data-form="link"]')).toBeNull();
    expect(el.querySelector('[data-state="no-employee-read"]')).not.toBeNull();
  });

  it('links an employee (PUT {employmentId}); employment-linked lands on the picker', async () => {
    await create(['access.grant', 'employee.read']);
    await pick('e-1');
    el.querySelector('[data-form="link"]')?.dispatchEvent(new Event('submit'));
    const put = http.expectOne('/api/access/users/u-samir/employment');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ employmentId: 'e-1' });
    put.flush(...conflict('employment-linked', [{ field: 'employmentId', code: 'employment_linked', message: 'already linked' }]));
    await settle(fixture);
    expect(el.querySelector('#link-employee-error')?.textContent?.trim()).toBe('Cet employé est déjà lié à un autre compte.');

    await pick('e-2');
    el.querySelector('[data-form="link"]')?.dispatchEvent(new Event('submit'));
    http.expectOne('/api/access/users/u-samir/employment').flush({ userId: 'u-samir', employment: null });
    await settle(fixture);
    expect(fixture.componentInstance.changed()).toBe(1);
    expect(el.querySelector('.feedback')?.textContent?.trim()).toBe("Compte lié à l'employé.");
  });

  it('unlinks after an inline confirmation (PUT {employmentId: null})', async () => {
    await create(['access.grant', 'employee.read']);
    fixture.componentInstance.user.set({ ...USER_SAMIR, employment: { id: 'e-1', matricule: 'EMP-0001', person: PERSON } });
    await settle(fixture);
    expect(el.querySelector('[data-field="linked"]')?.textContent).toContain('BENALI Amina');
    (el.querySelector('[data-action="unlink"]') as HTMLButtonElement).click();
    await settle(fixture);
    (el.querySelector('[data-action="confirm-unlink"]') as HTMLButtonElement).click();
    const put = http.expectOne('/api/access/users/u-samir/employment');
    expect(put.request.body).toEqual({ employmentId: null });
    put.flush({ userId: 'u-samir', employment: null });
    await settle(fixture);
    expect(fixture.componentInstance.changed()).toBe(1);
  });
});
