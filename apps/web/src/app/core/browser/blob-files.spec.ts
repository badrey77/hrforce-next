import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { BlobFiles } from './blob-files';
import { newUuid } from './uuid';

@Component({ selector: 'app-host', template: '', providers: [BlobFiles] })
class Host {
  readonly files = inject(BlobFiles);
}

describe('BlobFiles (component-scoped)', () => {
  let created: string[];
  let revoked: string[];

  beforeEach(() => {
    created = [];
    revoked = [];
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:http://localhost/${created.length + 1}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
  });

  afterEach(() => vi.restoreAllMocks());

  it('opens a tab synchronously, points it at the blob once the bytes arrive, and revokes on destroy', () => {
    const tab = { closed: false, opener: {}, close: vi.fn(), location: { href: '' } };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const fixture = TestBed.createComponent(Host);
    const bytes = new Subject<Blob>();
    const results: string[] = [];

    fixture.componentInstance.files.open(bytes, 'ATT-2026-00001.pdf').subscribe((r) => results.push(r));
    expect(open).toHaveBeenCalledWith('', '_blank'); // inside the click, before any byte arrived

    bytes.next(new Blob(['%PDF']));
    expect(results).toEqual(['opened']);
    expect(tab.location.href).toBe('blob:http://localhost/1');
    expect(tab.opener).toBeNull();
    expect(revoked).toEqual([]);

    fixture.destroy();
    expect(revoked).toEqual(['blob:http://localhost/1']);
  });

  it('downloads instead when the tab was blocked, and closes the tab on an error', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(Host);
    const results: string[] = [];
    fixture.componentInstance.files.open(of(new Blob(['%PDF'])), 'x.pdf').subscribe((r) => results.push(r));
    expect(results).toEqual(['saved']);
    expect(click).toHaveBeenCalled();

    const tab = { closed: false, close: vi.fn(), location: { href: '' } };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    fixture.componentInstance.files.open(throwError(() => new Error('404')), 'x.pdf').subscribe({ error: () => undefined });
    expect(tab.close).toHaveBeenCalled();
  });

  it('newUuid gives a v4 UUID, also without crypto.randomUUID', () => {
    expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const fallback = newUuid({ getRandomValues: <T extends ArrayBufferView>(a: T) => a } as unknown as Crypto);
    expect(fallback).toBe('00000000-0000-4000-8000-000000000000');
  });
});
