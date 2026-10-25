import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Res, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { ProfileRequestsService, type UploadedRequestFile } from '../application/profile-requests.service.js';
import { ProfileSettingsService } from '../application/profile-settings.service.js';
import type { FileDownload, MyProfileView, ProfileRequestDetail, ProfileRequestPage, ProfileRequestView, ProfileSettings } from '../application/profile-views.js';
import { HrRequestsQueryDto, isUuid, MyRequestsQueryDto, ProfileSettingsDto, SubmitRequestDto } from './profile.dto.js';
import { ProfileUploadInterceptor } from './profile-upload.interceptor.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/** The bytes as an attachment under the sniffed type, nosniff, a sandboxing CSP and no caching (as employee files). */
function sendFile(res: Response, file: FileDownload): StreamableFile {
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', file.disposition);
  res.setHeader('Content-Length', String(file.bytes.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', `"${file.sha256}"`);
  return new StreamableFile(file.bytes);
}

/** « Mon profil » (docs/contracts/profile-changes.md › Self-service requests). */
@Controller('me/profile')
export class MyProfileController {
  constructor(private readonly requests: ProfileRequestsService) {}

  @Get()
  @RequirePermission('profile.request_self')
  profile(): Promise<MyProfileView> {
    return this.requests.myProfile();
  }

  @Get('requests')
  @RequirePermission('profile.request_self')
  list(@Query() query: MyRequestsQueryDto): Promise<{ items: ProfileRequestView[] }> {
    return this.requests.myRequests(query.status);
  }

  /** No request transaction while the body streams in: the use case opens its own once the files are read. */
  @Post('requests')
  @SkipTransaction()
  @RequirePermission('profile.request_self')
  @UseInterceptors(ProfileUploadInterceptor)
  submit(@Body() body: SubmitRequestDto, @UploadedFiles() files: UploadedRequestFile[] | undefined): Promise<ProfileRequestView> {
    return this.requests.submit(body.data, files ?? []);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @RequirePermission('profile.request_self')
  cancel(@Param('id') id: string): Promise<ProfileRequestView> {
    return this.requests.cancel(idParam(id, 'Request'));
  }

  @Get('requests/:id/files/:fileId')
  @RequirePermission('profile.request_self')
  async file(@Param('id') id: string, @Param('fileId') fileId: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendFile(res, await this.requests.myFile(idParam(id, 'Request'), idParam(fileId, 'File')));
  }
}

/** HR: the change requests in scope. */
@Controller('profile')
export class ProfileRequestsController {
  constructor(
    private readonly requests: ProfileRequestsService,
    private readonly settings: ProfileSettingsService,
  ) {}

  @Get('settings')
  @RequirePermission('profile.configure')
  getSettings(): Promise<ProfileSettings> {
    return this.settings.get();
  }

  @Put('settings')
  @RequirePermission('profile.configure')
  setSettings(@Body() body: ProfileSettingsDto): Promise<ProfileSettings> {
    return this.settings.set(body);
  }

  @Get('requests')
  @RequirePermission('employee.personal.read')
  list(@Query() query: HrRequestsQueryDto): Promise<ProfileRequestPage> {
    return this.requests.list(query);
  }

  /** A candidate of the open task, or employee.personal.read (bank: employee.bank.read) over the employee: checked by the use case (404 otherwise). */
  @Get('requests/:id')
  @Authenticated()
  detail(@Param('id') id: string): Promise<ProfileRequestDetail> {
    return this.requests.detail(idParam(id, 'Request'));
  }

  @Get('requests/:id/files/:fileId')
  @Authenticated()
  async file(@Param('id') id: string, @Param('fileId') fileId: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendFile(res, await this.requests.hrFile(idParam(id, 'Request'), idParam(fileId, 'File')));
  }
}
