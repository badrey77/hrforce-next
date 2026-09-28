import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Patch,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { DocumentSettingsService } from '../application/document-settings.service.js';
import type {
  CompanyProfileView,
  DocumentRequestView,
  DocumentTypeView,
  IssuedDocumentDetail,
  IssuedDocumentPage,
  IssuedDocumentView,
  MyDocumentsView,
  PdfFile,
  SignatoryView,
} from '../application/document-views.js';
import { DocumentsService } from '../application/documents.service.js';
import { MyDocumentsService } from '../application/my-documents.service.js';
import { LOGO_MAX_BYTES } from '../domain/rules.js';
import {
  CreateSignatoryDto,
  DispositionQueryDto,
  DocumentRequestDto,
  IssueDocumentDto,
  isUuid,
  ProfileDto,
  RegisterQueryDto,
  SignatoriesQueryDto,
  UpdateDocumentTypeDto,
  UpdateSignatoryDto,
  VoidDocumentDto,
} from './documents.dto.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/** The contract's PDF response headers (docs/contracts/documents.md › PDF responses). */
function sendPdf(res: Response, file: { bytes: Buffer; filename: string; disposition: 'attachment' | 'inline'; etag?: string; status?: string }): StreamableFile {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${file.disposition}; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(file.bytes.length));
  if (file.etag) res.setHeader('ETag', `"${file.etag}"`);
  if (file.status) res.setHeader('X-Document-Status', file.status);
  return new StreamableFile(file.bytes);
}

function sendStored(res: Response, file: PdfFile, disposition: 'attachment' | 'inline'): StreamableFile {
  return sendPdf(res, { bytes: file.bytes, filename: `${file.number}.pdf`, disposition, etag: file.sha256, status: file.status });
}

/**
 * The logo upload: multer in memory, one `file` field; a file over the limit is a 422 `too_large` (not a 413), as the
 * contract's other validation errors. The exact 256 KB check (and the type sniffing) is the service's.
 */
@Injectable()
export class LogoUploadInterceptor extends FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1, fields: 5 } }) {
  override async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException) {
        throw new ValidationProblemException([{ field: 'file', code: 'too_large', message: 'At most 256 KB.' }]);
      }
      throw error;
    }
  }
}

/** HR: reference data, issuing, the register (docs/contracts/documents.md › Endpoints /documents*). */
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly settings: DocumentSettingsService,
  ) {}

  @Get('types')
  @Authenticated()
  types(): Promise<{ items: DocumentTypeView[] }> {
    return this.documents.types();
  }

  @Put('types/:id')
  @RequirePermission('document.configure')
  updateType(@Param('id') id: string, @Body() body: UpdateDocumentTypeDto): Promise<DocumentTypeView> {
    return this.settings.updateType(idParam(id, 'Document type'), body);
  }

  @Get('signatories')
  @RequirePermission('document.issue')
  signatories(@Query() query: SignatoriesQueryDto): Promise<{ items: SignatoryView[] }> {
    return this.documents.signatoriesFor(query.employmentId);
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('document.issue')
  async preview(@Body() body: IssueDocumentDto, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const pdf = await this.documents.preview(body);
    return sendPdf(res, { bytes: pdf, filename: `specimen-${body.typeCode}.pdf`, disposition: 'inline' });
  }

  /** 201 + Location for a new document; 200 with the same document for a replayed clientRequestId. */
  @Post()
  @RequirePermission('document.issue')
  async issue(@Body() body: IssueDocumentDto, @Res({ passthrough: true }) res: Response): Promise<IssuedDocumentView> {
    const { created, view } = await this.documents.issue(body);
    res.status(created ? 201 : 200);
    res.setHeader('Location', `/api/documents/${view.id}`);
    return view;
  }

  @Get()
  @RequirePermission('document.read')
  register(@Query() query: RegisterQueryDto): Promise<IssuedDocumentPage> {
    return this.documents.register(query);
  }

  @Get(':id')
  @RequirePermission('document.read')
  get(@Param('id') id: string): Promise<IssuedDocumentDetail> {
    return this.documents.get(idParam(id, 'Document'));
  }

  @Get(':id/pdf')
  @RequirePermission('document.read')
  async pdf(@Param('id') id: string, @Query() query: DispositionQueryDto, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendStored(res, await this.documents.pdf(idParam(id, 'Document'), query.disposition), query.disposition);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission('document.void')
  void(@Param('id') id: string, @Body() body: VoidDocumentDto): Promise<IssuedDocumentView> {
    return this.documents.void(idParam(id, 'Document'), body.reason);
  }
}

/** Letterhead and signatories (docs/contracts/documents.md › Endpoints /documents/settings*). */
@Controller('documents/settings')
export class DocumentSettingsController {
  constructor(private readonly settings: DocumentSettingsService) {}

  @Get('profile')
  @RequirePermission('document.configure')
  profile(): Promise<CompanyProfileView> {
    return this.settings.profile();
  }

  @Put('profile')
  @RequirePermission('document.configure')
  saveProfile(@Body() body: ProfileDto): Promise<CompanyProfileView> {
    return this.settings.saveProfile(body);
  }

  @Get('profile/logo')
  @RequirePermission('document.configure')
  async logo(@Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const logo = await this.settings.logo();
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(logo.bytes.length));
    return new StreamableFile(logo.bytes);
  }

  @Put('profile/logo')
  @RequirePermission('document.configure')
  @UseInterceptors(LogoUploadInterceptor)
  setLogo(@UploadedFile() file: { buffer: Buffer } | undefined): Promise<CompanyProfileView> {
    return this.settings.setLogo(file);
  }

  @Delete('profile/logo')
  @HttpCode(204)
  @RequirePermission('document.configure')
  deleteLogo(): Promise<void> {
    return this.settings.deleteLogo();
  }

  @Get('signatories')
  @RequirePermission('document.configure')
  signatories(): Promise<{ items: SignatoryView[] }> {
    return this.settings.signatories();
  }

  @Post('signatories')
  @RequirePermission('document.configure')
  createSignatory(@Body() body: CreateSignatoryDto): Promise<SignatoryView> {
    return this.settings.createSignatory(body);
  }

  @Patch('signatories/:id')
  @RequirePermission('document.configure')
  updateSignatory(@Param('id') id: string, @Body() body: UpdateSignatoryDto): Promise<SignatoryView> {
    return this.settings.updateSignatory(idParam(id, 'Signatory'), body);
  }
}

/** Self-service (docs/contracts/documents.md › /me/documents*). Needs a linked employment (409 document-not-linked). */
@Controller('me/documents')
export class MyDocumentsController {
  constructor(private readonly mine: MyDocumentsService) {}

  @Get()
  @RequirePermission('document.request_self')
  list(): Promise<MyDocumentsView> {
    return this.mine.mine();
  }

  @Post('requests')
  @RequirePermission('document.request_self')
  request(@Body() body: DocumentRequestDto): Promise<DocumentRequestView> {
    return this.mine.request({ typeCode: body.typeCode, language: body.language, purpose: body.purpose ?? null });
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermission('document.request_self')
  cancel(@Param('id') id: string): Promise<DocumentRequestView> {
    return this.mine.cancel(idParam(id, 'Document request'));
  }

  @Get(':id/pdf')
  @RequirePermission('document.request_self')
  async pdf(@Param('id') id: string, @Query() query: DispositionQueryDto, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendStored(res, await this.mine.pdf(idParam(id, 'Document'), query.disposition), query.disposition);
  }
}
