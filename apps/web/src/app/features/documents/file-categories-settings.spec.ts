import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { CAT_DIPLOMA, FILE_CATEGORIES } from '../../../testing/employee-file-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { FileCategoriesSettings } from './file-categories-settings';

const URL = '/api/employee-files/categories';

describe('FileCategoriesSettings', () => {
  let fixture: ComponentFixture<FileCategoriesSettings>;
  let el: HTMLElement;
  let http: HttpTestingController;

  async function settle(): Promise<void> {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    fixture.detectChanges();
  }

  const text = (selector: string) => el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const click = (selector: string) => (el.querySelector(selector) as HTMLElement).click();
  function fill(id: string, value: string): void {
    const input = el.querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  const submit = () => el.querySelector('[data-form="category"]')?.dispatchEvent(new Event('submit'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FileCategoriesSettings, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(FileCategoriesSettings);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await settle();
    http.expectOne(URL).flush({ items: [{ ...CAT_DIPLOMA, retentionYearsAfterEnd: 50 }, ...FILE_CATEGORIES.slice(1)] });
    await settle();
  });

  afterEach(() => http.verify());

  it('lists the categories with access class and retention', () => {
    expect(el.querySelectorAll('[data-table="file-categories"] tbody tr')).toHaveLength(5);
    expect(text('[data-category="diploma"] [data-field="retention"]')).toBe('50 an(s) après la fin');
    expect(text('[data-category="medical"]')).toContain('Médical (habilitation dédiée)');
    expect(text('[data-category="other"] [data-field="retention"]')).toBe('Sans limite');
  });

  it('creates a standard category; a taken code is shown on the code field', async () => {
    click('[data-action="new-category"]');
    await settle();
    fill('category-code', 'Bad Code');
    submit();
    await settle();
    expect(text('[data-error="code"]')).toContain('Lettres minuscules');
    http.expectNone(URL);

    fill('category-code', 'training');
    fill('category-label-fr', 'Formations');
    fill('category-label-ar', 'التكوين');
    fill('category-label-en', 'Training');
    fill('category-retention', '5');
    submit();
    const req = http.expectOne((r) => r.url === URL && r.method === 'POST');
    expect(req.request.body).toEqual({ code: 'training', labels: { fr: 'Formations', ar: 'التكوين', en: 'Training' }, retentionYearsAfterEnd: 5 });
    req.flush({ type: 'urn:hrforce:problem:category-code-taken', title: 'x', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(text('[data-error="code"]')).toBe('Ce code est déjà utilisé par une autre catégorie.');
  });

  it('edits labels, retention (empty = keep) and active; the code stays read-only', async () => {
    click('[data-category="diploma"] [data-action="edit-category"]');
    await settle();
    expect((el.querySelector('#category-code') as HTMLInputElement).disabled).toBe(true);
    fill('category-retention', '');
    const active = el.querySelector('#category-active') as HTMLInputElement;
    active.click();
    submit();
    const req = http.expectOne((r) => r.url === `${URL}/c-diploma` && r.method === 'PUT');
    expect(req.request.body).toEqual({ labels: CAT_DIPLOMA.labels, retentionYearsAfterEnd: null, active: false });
    req.flush({ ...CAT_DIPLOMA, active: false });
    await settle();
    expect(text('.feedback')).toBe('Catégorie enregistrée.');
    http.expectOne(URL).flush({ items: FILE_CATEGORIES });
  });
});
