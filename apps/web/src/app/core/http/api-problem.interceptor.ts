import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { catchError, from, of, switchMap, throwError } from 'rxjs';
import { ApiProblemError, parseApiProblem } from './api-problem';

/**
 * Converts every HttpErrorResponse into an ApiProblemError carrying a typed
 * ApiProblem (RFC 9457). Callers inspect `err.problem` instead of raw responses.
 *
 * Binary requests (`responseType: 'blob'`, e.g. a PDF — core/documents/documents-api.ts): HttpClient hands the ERROR
 * body over in the requested type too, so a 409 problem+json arrives as a `Blob`. Reading a Blob is asynchronous
 * (`blob.text()` returns a Promise), so for that case the error is re-thrown only after `from(promise)` has resolved;
 * `switchMap` turns "the text, once read" into the error Observable. A body that cannot be read degrades to a minimal
 * problem with the HTTP status, like any other unparseable body. JSON requests are unchanged (synchronous path).
 */
export const apiProblemInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }
      const body: unknown = error.error;
      if (body instanceof Blob) {
        return from(body.text()).pipe(
          catchError(() => of(undefined)),
          switchMap((text) =>
            throwError(() => new ApiProblemError(parseApiProblem(text, error.status, error.statusText), { cause: error })),
          ),
        );
      }
      const problem = parseApiProblem(body, error.status, error.statusText);
      return throwError(() => new ApiProblemError(problem, { cause: error }));
    }),
  );
