import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestId } from './request-id.js';
import {
  PROBLEM_CONTENT_TYPE,
  ProblemException,
  problemType,
  ValidationProblemException,
  type ProblemDetails,
} from './problem-details.js';

const SLUGS: Partial<Record<number, string>> = {
  400: 'bad-request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'conflict',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  422: 'validation-error',
  429: 'too-many-requests',
  500: 'internal-error',
  503: 'service-unavailable',
};

function slugFor(status: number): string {
  return SLUGS[status] ?? (status >= 500 ? 'server-error' : 'client-error');
}

function titleFor(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? 'Server Error' : 'Client Error');
}

/** http-errors style error (e.g. body-parser's 400 "entity.parse.failed" / 413). */
interface ExposedHttpError {
  status: number;
  expose: boolean;
  message: string;
}

function isExposedHttpError(error: unknown): error is ExposedHttpError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<ExposedHttpError>;
  return (
    typeof candidate.status === 'number' &&
    candidate.status >= 400 &&
    candidate.status < 500 &&
    candidate.expose === true &&
    typeof candidate.message === 'string'
  );
}

function httpExceptionDetail(exception: HttpException, title: string): string | undefined {
  const response = exception.getResponse();
  let message: unknown = response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    message = (response as { message: unknown }).message;
  }
  if (Array.isArray(message)) message = message.filter((m) => typeof m === 'string').join('; ');
  if (typeof message !== 'string' || message.length === 0) return undefined;
  if (message.toLowerCase() === title.toLowerCase()) return undefined;
  return message;
}

/**
 * Converts every error into an RFC 9457 `application/problem+json` response.
 * 5xx responses never carry internal details (message, stack, SQL…); those go to the log only.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetailsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const problem = this.toProblem(exception, req);
    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: problem.requestId }, 'Unhandled error');
    }
    if (res.headersSent) return;
    res.status(problem.status).setHeader('Content-Type', `${PROBLEM_CONTENT_TYPE}; charset=utf-8`);
    res.send(JSON.stringify(problem));
  }

  toProblem(exception: unknown, req: Request): ProblemDetails {
    const base = {
      instance: (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '',
      requestId: getRequestId(req),
    };

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const title = titleFor(status);
      const slug = exception instanceof ProblemException ? exception.slug : slugFor(status);
      const problem: ProblemDetails = { type: problemType(slug), title, status, ...base };
      if (status < 500) {
        const detail =
          exception instanceof ProblemException && !exception.hasDetail
            ? undefined
            : httpExceptionDetail(exception, title);
        if (detail !== undefined) problem.detail = detail;
      }
      if (exception instanceof ValidationProblemException) problem.errors = exception.errors;
      if (exception instanceof ProblemException && exception.errors?.length && status < 500) {
        problem.errors = exception.errors;
      }
      return problem;
    }

    if (isExposedHttpError(exception)) {
      const status = exception.status;
      return { type: problemType(slugFor(status)), title: titleFor(status), status, detail: exception.message, ...base };
    }

    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    return { type: problemType(slugFor(status)), title: titleFor(status), status, ...base };
  }
}
