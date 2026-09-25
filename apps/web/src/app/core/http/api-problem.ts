import { HttpErrorResponse } from '@angular/common/http';

/** One field-level validation error (RFC 9457 extension used by the API). */
export interface ApiFieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/** RFC 9457 problem details as returned by the HRForce API. */
export interface ApiProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  readonly errors?: readonly ApiFieldError[];
}

/** Synthetic problem types for failures that did not come back as problem+json. */
export const PROBLEM_TYPE_NETWORK = 'urn:hrforce:problem:network';
export const PROBLEM_TYPE_UNKNOWN = 'about:blank';

/** Error thrown into HttpClient observables by the error interceptor. */
export class ApiProblemError extends Error {
  override readonly name = 'ApiProblemError';

  constructor(
    readonly problem: ApiProblem,
    options?: { cause?: unknown },
  ) {
    super(problem.detail ?? problem.title, options);
  }

  get status(): number {
    return this.problem.status;
  }
}

export function isApiProblemError(value: unknown): value is ApiProblemError {
  return value instanceof ApiProblemError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseFieldErrors(value: unknown): ApiFieldError[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const errors: ApiFieldError[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item['field'] === 'string') {
      const message = optionalString(item['message']) ?? '';
      errors.push({ field: item['field'], code: optionalString(item['code']) ?? 'invalid', message });
    }
  }
  return errors;
}

/**
 * Builds an ApiProblem from an HTTP error body. The body may be a parsed object,
 * a JSON string (when the response type was text) or anything else; unknown shapes
 * degrade to a minimal problem carrying the HTTP status.
 */
export function parseApiProblem(body: unknown, status: number, statusText = ''): ApiProblem {
  let data: unknown = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      data = undefined;
    }
  }

  // Status 0: the request never got an HTTP response (offline, DNS, CORS, aborted).
  if (status === 0) {
    return { type: PROBLEM_TYPE_NETWORK, title: statusText || 'Network error', status };
  }

  if (!isRecord(data) || (typeof data['type'] !== 'string' && typeof data['title'] !== 'string')) {
    return { type: PROBLEM_TYPE_UNKNOWN, title: statusText || 'HTTP error', status };
  }

  const problem: {
    -readonly [K in keyof ApiProblem]: ApiProblem[K];
  } = {
    type: optionalString(data['type']) ?? PROBLEM_TYPE_UNKNOWN,
    title: optionalString(data['title']) ?? (statusText || 'HTTP error'),
    status: typeof data['status'] === 'number' ? data['status'] : status,
  };
  const detail = optionalString(data['detail']);
  const instance = optionalString(data['instance']);
  const requestId = optionalString(data['requestId']);
  const errors = parseFieldErrors(data['errors']);
  if (detail !== undefined) problem.detail = detail;
  if (instance !== undefined) problem.instance = instance;
  if (requestId !== undefined) problem.requestId = requestId;
  if (errors !== undefined) problem.errors = errors;
  return problem;
}

/**
 * The `Retry-After` header of the response behind an `ApiProblemError`, in seconds (423/429 from login).
 * The interceptor keeps the original `HttpErrorResponse` as `cause`, so headers stay reachable.
 * Accepts both forms RFC 9110 allows: delay-seconds (`"900"`) and an HTTP date. `null` when absent or unusable.
 */
export function retryAfterSeconds(error: ApiProblemError, now: number = Date.now()): number | null {
  const cause: unknown = error.cause;
  if (!(cause instanceof HttpErrorResponse)) {
    return null;
  }
  const value = cause.headers.get('Retry-After')?.trim();
  if (!value) {
    return null;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}
