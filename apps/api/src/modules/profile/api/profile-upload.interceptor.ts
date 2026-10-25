import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { MAX_FILES_PER_REQUEST } from '../domain/profile.js';

/**
 * The request upload (POST /me/profile/requests): multer in memory, 0–3 parts named `files` and the `data` text
 * field (JSON). Each file is bounded by EMPLOYEE_FILE_MAX_BYTES like the employee
 * file (a bigger one is a 422 `files` `too_large`, never a 413); a fourth file → 422 `files` `too_many`; a broken body
 * → 422 `files` `invalid_multipart`.
 */
@Injectable()
export class ProfileUploadInterceptor implements NestInterceptor {
  private readonly inner: NestInterceptor;
  private readonly maxBytes: number;

  constructor(@Inject(ENV) env: Env) {
    this.maxBytes = env.EMPLOYEE_FILE_MAX_BYTES;
    // defParamCharset utf8: browsers send the file names as raw UTF-8 (see EmployeeFileUploadInterceptor)
    const Multer = FilesInterceptor('files', MAX_FILES_PER_REQUEST, {
      limits: { fileSize: this.maxBytes, files: MAX_FILES_PER_REQUEST, fields: 5, parts: MAX_FILES_PER_REQUEST + 5, fieldSize: 200_000 },
      defParamCharset: 'utf8',
    });
    this.inner = new Multer();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return (await this.inner.intercept(context, next)) as Observable<unknown>;
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw new ValidationProblemException([{ field: 'files', code: 'too_large', message: `Each file: at most ${this.maxBytes} bytes.` }]);
      }
      if (error instanceof BadRequestException) {
        const tooMany = /Too many files|Unexpected file field|Too many parts/i.test(error.message);
        throw new ValidationProblemException([
          tooMany
            ? { field: 'files', code: 'too_many', message: `At most ${MAX_FILES_PER_REQUEST} files, in the field \`files\`.` }
            : { field: 'files', code: 'invalid_multipart', message: 'The multipart body could not be read.' },
        ]);
      }
      throw error;
    }
  }
}
