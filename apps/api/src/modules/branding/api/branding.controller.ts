import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  PayloadTooLargeException,
  Put,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { AllowWithoutMfa, Authenticated, Public, RequirePermission } from '../../../platform/authz/decorators.js';
import type { BrandingSettingsView, LogoFile } from '../application/branding-views.js';
import { BrandingService } from '../application/branding.service.js';
import { BRANDING_LOGO_MAX_BYTES } from '../domain/types.js';

const TOO_LARGE = Symbol('hrforce.brandingLogoTooLarge');
type MarkedRequest = Request & { [TOO_LARGE]?: boolean };

/**
 * The logo upload: multer in memory, one `file` field, 256 KB + 1 byte. A file over the limit is NOT answered here:
 * the request is marked and the use case turns it into 422 `too_large` AFTER its scope and owner checks (the
 * contract's order of checks), instead of a 413 or an early 422.
 */
@Injectable()
export class BrandingLogoUploadInterceptor extends FileInterceptor('file', { limits: { fileSize: BRANDING_LOGO_MAX_BYTES + 1, files: 1, fields: 5 } }) {
  override async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (!(error instanceof PayloadTooLargeException)) throw error;
      context.switchToHttp().getRequest<MarkedRequest>()[TOO_LARGE] = true;
      return next.handle();
    }
  }
}

const upload = (req: Request, file: { buffer: Buffer } | undefined) => ({ file, tooLarge: (req as MarkedRequest)[TOO_LARGE] === true });

/** The contract's image response: the stored (sniffed) type, never sniffed again by the browser, cached for a year. */
function sendLogo(res: Response, logo: LogoFile, visibility: 'public' | 'private'): StreamableFile {
  res.setHeader('Content-Type', logo.mime);
  res.setHeader('Content-Length', String(logo.bytes.length));
  res.setHeader('ETag', `"${logo.digest}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="logo.${logo.mime === 'image/png' ? 'png' : 'jpg'}"`);
  res.setHeader('Cache-Control', `${visibility}, max-age=31536000, immutable`);
  return new StreamableFile(logo.bytes);
}

/** `If-None-Match` against one strong tag (weak comparison, RFC 9110 §13.1.2). */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

/**
 * Branding (docs/contracts/branding.md › Endpoints). The two public routes give away only what the sign-in page
 * prints, write nothing and set no cookie; the write bodies are validated by the use case (after its scope checks).
 */
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /** The installation default: `no-cache` + a strong ETag over the body, so a revalidation costs a 304. */
  @Get('default')
  @Public()
  async publicDefault(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body = JSON.stringify(await this.branding.publicDefault());
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (matches(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return;
    }
    res.status(200).type('application/json').send(body);
  }

  @Get('default/logo/:digest')
  @Public()
  async defaultLogo(@Param('digest') digest: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendLogo(res, await this.branding.defaultLogo(digest), 'public');
  }

  @Get('logos/:kind/:digest')
  @Authenticated()
  @AllowWithoutMfa() // the shell shows the logos on the two-step enrolment page too
  async logo(@Param('kind') kind: string, @Param('digest') digest: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendLogo(res, await this.branding.companyLogo(kind, digest), 'private');
  }

  @Get('settings')
  @RequirePermission('settings.branding')
  settings(): Promise<BrandingSettingsView> {
    return this.branding.settings();
  }

  @Put('company')
  @RequirePermission('settings.branding')
  saveCompany(@Body() body: unknown): Promise<BrandingSettingsView> {
    return this.branding.saveCompany(body);
  }

  @Delete('company')
  @HttpCode(204)
  @RequirePermission('settings.branding')
  resetCompany(): Promise<void> {
    return this.branding.resetCompany();
  }

  @Put('company/logos/:kind')
  @RequirePermission('settings.branding')
  @UseInterceptors(BrandingLogoUploadInterceptor)
  setCompanyLogo(@Param('kind') kind: string, @Req() req: Request, @UploadedFile() file: { buffer: Buffer } | undefined): Promise<BrandingSettingsView> {
    return this.branding.setCompanyLogo(kind, upload(req, file));
  }

  @Delete('company/logos/:kind')
  @HttpCode(204)
  @RequirePermission('settings.branding')
  deleteCompanyLogo(@Param('kind') kind: string): Promise<void> {
    return this.branding.deleteCompanyLogo(kind);
  }

  @Put('installation')
  @RequirePermission('settings.branding')
  saveInstallation(@Body() body: unknown): Promise<BrandingSettingsView> {
    return this.branding.saveInstallation(body);
  }

  @Delete('installation')
  @HttpCode(204)
  @RequirePermission('settings.branding')
  resetInstallation(): Promise<void> {
    return this.branding.resetInstallation();
  }

  @Put('installation/logo')
  @RequirePermission('settings.branding')
  @UseInterceptors(BrandingLogoUploadInterceptor)
  setInstallationLogo(@Req() req: Request, @UploadedFile() file: { buffer: Buffer } | undefined): Promise<BrandingSettingsView> {
    return this.branding.setInstallationLogo(upload(req, file));
  }

  @Delete('installation/logo')
  @HttpCode(204)
  @RequirePermission('settings.branding')
  deleteInstallationLogo(): Promise<void> {
    return this.branding.deleteInstallationLogo();
  }
}
