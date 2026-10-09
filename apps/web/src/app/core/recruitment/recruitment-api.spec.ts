import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { fakeFile, provideUploadsThroughTestingBackend } from '../../../testing/employee-file-fixtures';
import { applicationDetail, candidateFile } from '../../../testing/recruitment-fixtures';
import { Session } from '../auth/session';
import { MyRecruitment } from './my-recruitment';
import { RecruitmentApi } from './recruitment-api';
import type { CandidateUploadEvent } from './recruitment.models';

describe('RecruitmentApi (docs/contracts/recruitment.md › Endpoints)', () => {
  let api: RecruitmentApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideUploadsThroughTestingBackend()] });
    api = TestBed.inject(RecruitmentApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('stage-changing calls carry the stage the user was looking at', () => {
    api.move('a 1', { toStage: 'interview', expectedStage: 'received' }).subscribe();
    const move = http.expectOne('/api/recruitment/applications/a%201/move');
    expect([move.request.method, move.request.body]).toEqual(['POST', { toStage: 'interview', expectedStage: 'received' }]);
    move.flush(applicationDetail());

    api.reopenApplication('a-1', 'rejected').subscribe();
    const reopen = http.expectOne('/api/recruitment/applications/a-1/reopen');
    expect(reopen.request.body).toEqual({ expectedStage: 'rejected' });
    reopen.flush(applicationDetail());
  });

  it('opening actions: close with a reason, reopen and cancel without a body', () => {
    api.closeOpening('o-1', 'Budget reporté').subscribe();
    expect(http.expectOne('/api/recruitment/openings/o-1/close').request.body).toEqual({ reason: 'Budget reporté' });
    api.reopenOpening('o-1').subscribe();
    expect(http.expectOne({ method: 'POST', url: '/api/recruitment/openings/o-1/reopen' }).request.body).toBeNull();
    api.cancelMyOpening('o-1').subscribe();
    expect(http.expectOne({ method: 'POST', url: '/api/me/recruitment/openings/o-1/cancel' }).request.body).toBeNull();
  });

  it('candidate routes: link / unlink a person, erase, and the two file content routes as blobs', () => {
    api.linkPerson('c-1', null).subscribe();
    const unlink = http.expectOne('/api/recruitment/candidates/c-1/person');
    expect([unlink.request.method, unlink.request.body]).toEqual(['PUT', { personId: null }]);
    api.eraseCandidate('c-1').subscribe();
    expect(http.expectOne('/api/recruitment/candidates/c-1/erase').request.method).toBe('POST');
    api.fileContent('c-1', 'f-1').subscribe();
    expect(http.expectOne('/api/recruitment/candidates/c-1/files/f-1/content').request.responseType).toBe('blob');
    api.myFileContent('a-1', 'f-1').subscribe();
    expect(http.expectOne('/api/me/recruitment/applications/a-1/files/f-1/content').request.responseType).toBe('blob');
    api.deleteFile('c-1', 'f-1').subscribe();
    expect(http.expectOne('/api/recruitment/candidates/c-1/files/f-1').request.method).toBe('DELETE');
  });

  it('upload: multipart with kind, title and the file; progress events, then the stored file', () => {
    const events: CandidateUploadEvent[] = [];
    api.uploadFile('c-1', { kind: 'diploma', title: 'Master' }, fakeFile('master.pdf', 'application/pdf', 2048)).subscribe((event) => events.push(event));
    const req = http.expectOne('/api/recruitment/candidates/c-1/files');
    const form = req.request.body as FormData;
    expect([form.get('kind'), form.get('title'), (form.get('file') as File).name]).toEqual(['diploma', 'Master', 'master.pdf']);
    expect(req.request.reportProgress).toBe(true);
    req.flush(candidateFile({ id: 'f-2', kind: 'diploma' }), { status: 201, statusText: 'Created' });
    expect(events[0]).toEqual({ kind: 'progress', loaded: 0, total: 2048 });
    expect(events.at(-1)).toMatchObject({ kind: 'done', file: { id: 'f-2' } });
  });

  it('board: includeFinal only when asked', () => {
    api.board('o-1', false).subscribe();
    expect(http.expectOne((r) => r.url === '/api/recruitment/openings/o-1/board').request.params.keys()).toEqual([]);
    api.board('o-1', true).subscribe();
    expect(http.expectOne((r) => r.url === '/api/recruitment/openings/o-1/board').request.params.get('includeFinal')).toBe('true');
  });
});

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
}

describe('MyRecruitment', () => {
  it('asks the summary once signed in; the nav entry is for those with something and without recruitment.read', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    const session = TestBed.inject(Session);
    const mine = TestBed.inject(MyRecruitment);

    await settle();
    http.expectNone('/api/me/recruitment/summary'); // signed out: nothing asked
    expect(mine.showNav()).toBe(false);

    session.set(meWith([]));
    await settle();
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 1, pendingOpenings: 1 });
    await settle();
    expect(mine.relevant()).toBe(true);
    expect(mine.showNav()).toBe(true);

    session.set(meWith(['recruitment.read']));
    await settle();
    for (const req of http.match('/api/me/recruitment/summary')) req.flush({ canRequestOpening: true, openings: 1, pendingOpenings: 1 });
    await settle();
    expect(mine.relevant()).toBe(true);
    expect(mine.showNav()).toBe(false);
    http.verify();
  });

  it('« Mes entretiens » shows to anyone with an interview — HR included — with the evaluations left to enter', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    const session = TestBed.inject(Session);
    const mine = TestBed.inject(MyRecruitment);

    session.set(meWith(['recruitment.read']));
    await settle();
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0, interviews: 2, evaluationsTodo: 1 });
    await settle();
    expect(mine.showNav()).toBe(false);
    expect(mine.showInterviewsNav()).toBe(true);
    expect(mine.evaluationsTodo()).toBe(1);

    mine.reload();
    await settle();
    // An older answer without the Phase B fields reads as "no interview".
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0 });
    await settle();
    expect(mine.showInterviewsNav()).toBe(false);
    expect(mine.evaluationsTodo()).toBe(0);
    http.verify();
  });
});
