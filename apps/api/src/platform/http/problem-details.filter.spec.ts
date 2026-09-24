import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { ProblemException, ValidationProblemException, type ProblemDetails } from './problem-details.js';

function fakeHttp(url = '/api/things/1?x=1', headers: Record<string, string> = { 'x-request-id': 'req-123' }) {
  const req = { originalUrl: url, url, headers } as unknown as Request;
  const sent: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
  const res = {
    headersSent: false,
    status(code: number) {
      sent.status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value;
      return this;
    },
    send(body: string) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, sent, body: () => JSON.parse(sent.body ?? 'null') as ProblemDetails };
}

describe('ProblemDetailsFilter', () => {
  const filter = new ProblemDetailsFilter();

  it('renders HttpExceptions as RFC 9457 problem+json', () => {
    const http = fakeHttp();
    filter.catch(new NotFoundException('Employee not found'), http.host);
    expect(http.sent.status).toBe(404);
    expect(http.sent.headers['content-type']).toBe('application/problem+json; charset=utf-8');
    expect(http.body()).toEqual({
      type: 'urn:hrforce:problem:not-found',
      title: 'Not Found',
      status: 404,
      detail: 'Employee not found',
      instance: '/api/things/1',
      requestId: 'req-123',
    });
  });

  it('omits detail when it merely repeats the title', () => {
    const http = fakeHttp();
    filter.catch(new ForbiddenException(), http.host);
    expect(http.body()).not.toHaveProperty('detail');
    expect(http.body().title).toBe('Forbidden');
  });

  it('renders validation errors as 422 with errors[]', () => {
    const http = fakeHttp();
    filter.catch(
      new ValidationProblemException([{ field: 'name', code: 'too_small', message: 'Too small' }]),
      http.host,
    );
    expect(http.sent.status).toBe(422);
    expect(http.body()).toMatchObject({
      type: 'urn:hrforce:problem:validation-error',
      title: 'Unprocessable Entity',
      status: 422,
      errors: [{ field: 'name', code: 'too_small', message: 'Too small' }],
    });
  });

  it('joins class-validator style message arrays', () => {
    const http = fakeHttp();
    filter.catch(new BadRequestException(['a is bad', 'b is bad']), http.host);
    expect(http.body().detail).toBe('a is bad; b is bad');
  });

  it('uses the slug of a ProblemException', () => {
    const http = fakeHttp();
    filter.catch(new ProblemException(409, 'org-unit-code-taken', 'Code already used'), http.host);
    expect(http.body()).toMatchObject({ type: 'urn:hrforce:problem:org-unit-code-taken', status: 409, detail: 'Code already used' });
  });

  it('maps unknown errors to 500 without leaking internals', () => {
    const http = fakeHttp();
    const error = new Error('duplicate key value violates unique constraint "secret_idx" at /srv/app.js');
    const logSpy = vi.spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    filter.catch(error, http.host);
    expect(http.sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = http.body();
    expect(body).toEqual({
      type: 'urn:hrforce:problem:internal-error',
      title: 'Internal Server Error',
      status: 500,
      instance: '/api/things/1',
      requestId: 'req-123',
    });
    expect(http.sent.body).not.toContain('secret_idx');
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it('never exposes the detail of explicit 5xx HttpExceptions', () => {
    const http = fakeHttp();
    vi.spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    filter.catch(new InternalServerErrorException('db password is hunter2'), http.host);
    expect(http.body()).not.toHaveProperty('detail');
  });

  it('maps exposed http-errors (e.g. malformed JSON) to their 4xx status', () => {
    const http = fakeHttp();
    const parseError = Object.assign(new Error('Unexpected token } in JSON'), { status: 400, expose: true });
    filter.catch(parseError, http.host);
    expect(http.body()).toMatchObject({ status: 400, title: 'Bad Request', detail: 'Unexpected token } in JSON' });
  });

  it('generates a request id when the caller sent none or an unsafe one', () => {
    const http = fakeHttp('/api/x', { 'x-request-id': 'bad id\nwith newline' });
    filter.catch(new NotFoundException(), http.host);
    expect(http.body().requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
