import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { EmployeeFileCategoriesService } from '../application/employee-file-categories.service.js';
import type { EmployeeFileCategoryView, EmployeeFileListView, EmployeeFileView } from '../application/employee-file-views.js';
import { EmployeeFilesService, type UploadedFile as UploadedEmployeeFile } from '../application/employee-files.service.js';
import { isUuid } from './documents.dto.js';
import { CreateCategoryDto, DeleteFileDto, ListFilesQueryDto, UpdateCategoryDto, UploadFileDto } from './employee-files.dto.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/**
 * The employee-file upload: multer in memory, exactly one `file` part and at most 10 text fields. The reader stops
 * as soon as the file passes EMPLOYEE_FILE_MAX_BYTES (the rest of the body is drained, never buffered), which is a 422
 * `too_large` like the contract's other validation errors (never a 413 or a 500); a second file or a broken multipart
 * body is a 422 on `file` too. The limit comes from the environment, so the multer instance is built per interceptor.
 */
@Injectable()
export class EmployeeFileUploadInterceptor implements NestInterceptor {
  private readonly inner: NestInterceptor;
  private readonly maxBytes: number;

  constructor(@Inject(ENV) env: Env) {
    this.maxBytes = env.EMPLOYEE_FILE_MAX_BYTES;
    // defParamCharset utf8: browsers send `filename="…"` as raw UTF-8 bytes (WHATWG multipart/form-data encoding);
    // multer's default (latin1) turned « عقد.pdf » into mojibake and let U+202E through as "â€®" (verification 2026-09-29)
    const Multer = FileInterceptor('file', {
      limits: { fileSize: this.maxBytes, files: 1, fields: 10, parts: 11 },
      defParamCharset: 'utf8',
    });
    this.inner = new Multer();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return (await this.inner.intercept(context, next)) as Observable<unknown>;
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw new ValidationProblemException([{ field: 'file', code: 'too_large', message: `At most ${this.maxBytes} bytes.` }]);
      }
      if (error instanceof BadRequestException) {
        const oneFile = /Too many files|Unexpected file field/i.test(error.message);
        throw new ValidationProblemException([
          oneFile
            ? { field: 'file', code: 'one_file_only', message: 'Send exactly one file, in the field `file`.' }
            : { field: 'file', code: 'invalid_multipart', message: 'The multipart body could not be read.' },
        ]);
      }
      throw error;
    }
  }
}

/** Employee file categories (docs/contracts/documents.md › Phase B › Endpoints). */
@Controller('employee-files/categories')
export class EmployeeFileCategoriesController {
  constructor(private readonly categories: EmployeeFileCategoriesService) {}

  @Get()
  @Authenticated()
  list(): Promise<{ items: EmployeeFileCategoryView[] }> {
    return this.categories.list();
  }

  @Post()
  @RequirePermission('document.configure')
  create(@Body() body: CreateCategoryDto): Promise<EmployeeFileCategoryView> {
    return this.categories.create(body);
  }

  @Put(':id')
  @RequirePermission('document.configure')
  update(@Param('id') id: string, @Body() body: UpdateCategoryDto): Promise<EmployeeFileCategoryView> {
    return this.categories.update(idParam(id, 'Category'), body);
  }
}

/** The employee file: attachments of an employee (`:id` = employment id, as /employees/:id). */
@Controller('employees/:id/files')
export class EmployeeFilesController {
  constructor(private readonly files: EmployeeFilesService) {}

  @Get()
  @RequirePermission('employee_file.read')
  list(@Param('id') id: string, @Query() query: ListFilesQueryDto): Promise<EmployeeFileListView> {
    return this.files.list(idParam(id, 'Employee'), query);
  }

  /** No request transaction while the body streams in: the use case opens its own once the file is read. */
  @Post()
  @SkipTransaction()
  @RequirePermission('employee_file.upload')
  @UseInterceptors(EmployeeFileUploadInterceptor)
  upload(@Param('id') id: string, @Body() body: UploadFileDto, @UploadedFile() file: UploadedEmployeeFile | undefined): Promise<EmployeeFileView> {
    return this.files.upload(idParam(id, 'Employee'), body, file);
  }

  /**
   * The bytes, always as an attachment under the sniffed type, with `nosniff`, a sandboxing CSP and no caching
   * (docs/contracts/documents.md › Upload validation, antivirus stance).
   */
  @Get(':fileId/content')
  @RequirePermission('employee_file.read')
  async content(@Param('id') id: string, @Param('fileId') fileId: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.files.content(idParam(id, 'Employee'), idParam(fileId, 'File'));
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', file.disposition);
    res.setHeader('Content-Length', String(file.bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', `"${file.sha256}"`);
    return new StreamableFile(file.bytes);
  }

  @Post(':fileId/delete')
  @HttpCode(204)
  @RequirePermission('employee_file.delete')
  delete(@Param('id') id: string, @Param('fileId') fileId: string, @Body() body: DeleteFileDto): Promise<void> {
    return this.files.delete(idParam(id, 'Employee'), idParam(fileId, 'File'), body.reason);
  }
}
