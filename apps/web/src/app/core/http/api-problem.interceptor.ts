import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { ApiProblemError, parseApiProblem } from './api-problem';

/**
 * Converts every HttpErrorResponse into an ApiProblemError carrying a typed
 * ApiProblem (RFC 9457). Callers inspect `err.problem` instead of raw responses.
 */
export const apiProblemInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }
      const problem = parseApiProblem(error.error, error.status, error.statusText);
      return throwError(() => new ApiProblemError(problem, { cause: error }));
    }),
  );
