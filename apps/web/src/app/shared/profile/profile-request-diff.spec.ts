import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { profileRequest } from '../../../testing/profile-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { ProfileRequestView } from '../../core/profile/profile.models';
import { childDiff, ProfileRequestDiff } from './profile-request-diff';

@Component({
  imports: [ProfileRequestDiff],
  template: `<app-profile-request-diff [request]="request()" [filesFrom]="from()" />`,
})
class Host {
  readonly request = input.required<ProfileRequestView>();
  readonly from = input<'hr' | 'me'>('hr');
}

describe('childDiff', () => {
  it('matches children by id: added, removed, changed, same', () => {
    const before = { children: [{ id: 'a', firstName: 'A', birthDate: '2020-01-01', sex: 'M', dependent: true }, { id: 'b', firstName: 'B', birthDate: '2021-01-01', sex: null, dependent: true }] };
    const after = { children: [{ id: 'a', firstName: 'A', birthDate: '2020-01-01', sex: 'M', dependent: false }, { firstName: 'C', birthDate: '2025-01-01', sex: 'F', dependent: true }] };
    expect(childDiff(before, after).map((r) => r.state)).toEqual(['changed', 'added', 'removed']);
    expect(childDiff(before, before).every((r) => r.state === 'same')).toBe(true);
    expect(childDiff(null, null)).toEqual([]);
  });
});

async function render(request: ProfileRequestView, from: 'hr' | 'me' = 'hr'): Promise<HTMLElement> {
  await TestBed.configureTestingModule({ imports: [translocoTesting(), Host] }).compileComponents();
  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('request', request);
  fixture.componentRef.setInput('from', from);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const text = (el: HTMLElement, selector: string) => el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

describe('ProfileRequestDiff', () => {
  it('shows flat fields before → after with labels, wilaya names and enum values', async () => {
    const el = await render(
      profileRequest({
        section: 'contact',
        changedFields: ['mobilePhone', 'wilayaCode'],
        before: { mobilePhone: '+213 555 12 34 56', wilayaCode: '23' },
        payload: { mobilePhone: '+213 555 00 00 00', wilayaCode: '16' },
        files: [],
        changedSince: true,
      }),
    );
    const cells = (field: string) => [...el.querySelectorAll(`[data-diff="${field}"] > *`)].map((c) => c.textContent?.trim());
    expect(cells('mobilePhone')).toEqual(['Téléphone mobile personnel', '+213 555 12 34 56', '+213 555 00 00 00']);
    expect(cells('wilayaCode')).toEqual(['Wilaya', '23 — Annaba', '16 — Alger']);
    expect(el.querySelector('[data-state="changed-since"]')).not.toBeNull();
    expect(text(el, '[data-list="files"]')).toBe('Aucune pièce jointe.');
  });

  it('compares the children and links files through the HR or the requester routes', async () => {
    const el = await render(profileRequest());
    expect(el.querySelector('[data-child-diff="added"]')?.textContent).toContain('Lina');
    expect(el.querySelector('[data-child-diff="same"]')?.textContent).toContain('Yanis');
    const link = el.querySelector('[data-file="pf-1"] a');
    expect(link?.getAttribute('href')).toBe('/api/profile/requests/pr-1/files/pf-1');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
    expect(el.querySelector('[data-state="changed-since"]')).toBeNull();
  });

  it('uses the requester routes for one’s own files, and says when a file is gone', async () => {
    const el = await render(profileRequest({ files: [{ id: 'pf-1', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 10, purged: false }, { id: 'pf-2', filename: 'b.pdf', mime: 'application/pdf', sizeBytes: 10, purged: true }] }), 'me');
    expect(el.querySelector('[data-file="pf-1"] a')?.getAttribute('href')).toBe('/api/me/profile/requests/pr-1/files/pf-1');
    expect(text(el, '[data-file="pf-2"]')).toBe('b.pdf — supprimée');
  });

  it('shows a masked RIB hint, the note of an error report and the rejection comment', async () => {
    const bank = await render(
      profileRequest({ section: 'bank', changedFields: ['rib'], before: { rib: '•••• 1234', bankName: 'BNA' }, payload: { rib: '•••• 9999', bankName: 'BNA' } }),
    );
    expect(bank.querySelector('[data-state="rib-masked"]')).not.toBeNull();
    TestBed.resetTestingModule();
    const note = await render(
      profileRequest({ section: 'identity_note', changedFields: ['note'], before: null, payload: { note: 'Ma date de naissance est fausse' }, files: [], status: 'rejected', rejectionComment: 'Voir avec le service' }),
    );
    expect(text(note, '[data-field="note"]')).toBe('Ma date de naissance est fausse');
    expect(text(note, '[data-field="rejection"]')).toBe('Voir avec le service');
    expect(note.querySelector('[data-table="diff"]')).toBeNull();
    expect(note.querySelector('[data-list="files"]')).toBeNull();
  });
});
