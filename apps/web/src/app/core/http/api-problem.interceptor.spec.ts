import { HttpClient, HttpErrorResponse, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  ApiProblemError,
  isApiProblemError,
  parseApiProblem,
  PROBLEM_TYPE_NETWORK,
  PROBLEM_TYPE_UNKNOWN,
  retryAfterSeconds,
} from './api-problem';
import { apiProblemInterceptor } from './api-problem.interceptor';

describe('apiProblemInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  async function failWith(body: string | object, status: number, statusText: string): Promise<ApiProblemError> {
    const result = firstValueFrom(http.post('/api/things', {}));
    controller.expectOne('/api/things').flush(body, {
      status,
      statusText,
      headers: { 'Content-Type': 'application/problem+json' },
    });
    try {
      await result;
    } catch (error: unknown) {
      if (isApiProblemError(error)) {
        return error;
      }
      throw new Error('expected an ApiProblemError', { cause: error });
    }
    throw new Error('expected the request to fail');
  }

  it('turns a problem+json body into a typed ApiProblem', async () => {
    const error = await failWith(
      {
        type: 'urn:hrforce:problem:validation',
        title: 'Validation failed',
        status: 422,
        detail: 'Some fields are invalid',
        instance: '/api/things',
        requestId: 'req-123',
        errors: [{ field: 'name', code: 'required', message: 'Name is required' }],
      },
      422,
      'Unprocessable Content',
    );

    expect(error).toBeInstanceOf(ApiProblemError);
    expect(error.status).toBe(422);
    expect(error.message).toBe('Some fields are invalid');
    expect(error.problem).toEqual({
      type: 'urn:hrforce:problem:validation',
      title: 'Validation failed',
      status: 422,
      detail: 'Some fields are invalid',
      instance: '/api/things',
      requestId: 'req-123',
      errors: [{ field: 'name', code: 'required', message: 'Name is required' }],
    });
  });

  it('degrades a non-problem body to a minimal problem with the HTTP status', async () => {
    const error = await failWith('<html>Bad gateway</html>', 502, 'Bad Gateway');

    expect(error.problem).toEqual({ type: PROBLEM_TYPE_UNKNOWN, title: 'Bad Gateway', status: 502 });
  });

  it('maps a network failure (status 0) to the network problem type', async () => {
    const result = firstValueFrom(http.get('/api/things'));
    controller.expectOne('/api/things').error(new ProgressEvent('error'), { status: 0, statusText: '' });

    await expect(result).rejects.toSatisfy(
      (e: unknown) => isApiProblemError(e) && e.problem.type === PROBLEM_TYPE_NETWORK && e.status === 0,
    );
  });

  it('lets successful responses through untouched', async () => {
    const result = firstValueFrom(http.get<{ ok: boolean }>('/api/things'));
    controller.expectOne('/api/things').flush({ ok: true });

    await expect(result).resolves.toEqual({ ok: true });
  });
});

describe('parseApiProblem', () => {
  it('parses a JSON string body', () => {
    expect(parseApiProblem('{"type":"t","title":"T","status":404}', 404)).toEqual({
      type: 't',
      title: 'T',
      status: 404,
    });
  });

  it('drops malformed field errors and fills missing code/message', () => {
    const problem = parseApiProblem(
      { type: 't', title: 'T', status: 422, errors: [{ field: 'a' }, { code: 'no-field' }, 'junk'] },
      422,
    );

    expect(problem.errors).toEqual([{ field: 'a', code: 'invalid', message: '' }]);
  });

  it('falls back to the HTTP status when the body has none', () => {
    expect(parseApiProblem({ title: 'Oops' }, 500).status).toBe(500);
  });
});

function withHeader(value?: string): ApiProblemError {
  return new ApiProblemError(
    { type: 't', title: 'Locked', status: 423 },
    {
      cause: new HttpErrorResponse({
        status: 423,
        headers: value === undefined ? new HttpHeaders() : new HttpHeaders({ 'Retry-After': value }),
      }),
    },
  );
}

describe('retryAfterSeconds', () => {
  it('reads delay-seconds', () => {
    expect(retryAfterSeconds(withHeader('900'))).toBe(900);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-09-25T10:00:00Z');
    expect(retryAfterSeconds(withHeader('Fri, 25 Sep 2026 10:05:00 GMT'), now)).toBe(300);
  });

  it('is null when missing, unparsable, or without an HTTP response behind it', () => {
    expect(retryAfterSeconds(withHeader())).toBeNull();
    expect(retryAfterSeconds(withHeader('soon'))).toBeNull();
    expect(retryAfterSeconds(new ApiProblemError({ type: 't', title: 'x', status: 423 }))).toBeNull();
  });
});
