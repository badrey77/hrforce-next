import { HttpException, HttpStatus } from '@nestjs/common';

/** One field-level validation error. `field` is a dotted path the web maps to a form control. */
export interface FieldError {
  field: string;
  code: string;
  message: string;
}

/** RFC 9457 problem details as produced by the API (CONVENTIONS.md › Routes). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  requestId: string;
  errors?: FieldError[];
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_PREFIX = 'urn:hrforce:problem:';

/** `type` URI for a slug, e.g. problemType('validation-error') → 'urn:hrforce:problem:validation-error'. */
export function problemType(slug: string): string {
  return `${PROBLEM_TYPE_PREFIX}${slug}`;
}

/** 422 with field errors. Throw this (or let the validation pipe throw it) for invalid input. */
export class ValidationProblemException extends HttpException {
  constructor(
    readonly errors: FieldError[],
    detail = 'The request contains invalid fields.',
  ) {
    super(detail, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

/**
 * An HTTP error with a stable problem `type` slug, an optional client-safe detail and optional field errors.
 * Feature modules throw this for domain errors, e.g.
 *   new ProblemException(409, 'org-unit-code-taken', 'Code already used', [{ field: 'code', code: 'taken', message: '…' }]).
 */
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly slug: string,
    detail?: string,
    readonly errors?: FieldError[],
    options: ProblemOptions = {},
  ) {
    super(detail ?? slug, status);
    this.hasDetail = detail !== undefined;
    this.headers = options.headers ?? {};
  }
  readonly hasDetail: boolean;
  /** Extra response headers (e.g. `Retry-After`), set by the problem filter. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface ProblemOptions {
  headers?: Record<string, string>;
}
