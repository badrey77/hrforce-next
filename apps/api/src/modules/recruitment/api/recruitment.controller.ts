import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { EmployeeFileUploadInterceptor, type UploadedFile as UploadedCandidateFile } from '../../documents/index.js';
import { ApplicationsService } from '../application/applications.service.js';
import { CandidateFilesService, type FileDownload } from '../application/candidate-files.service.js';
import { OpeningsService } from '../application/openings.service.js';
import { RecruitmentSettingsService } from '../application/recruitment-settings.service.js';
import type {
  ApplicationDetailView,
  CriterionView,
  RequestableUnit,
  ApplicationPage,
  BoardView,
  CandidateFileView,
  CandidateMatchView,
  CandidateView,
  KnownPersonView,
  MyOpeningDetailView,
  MyOpeningView,
  MySummaryView,
  NoteView,
  OpeningDetailView,
  OpeningPage,
  PolicyView,
  ReasonView,
  SummaryView,
} from '../application/recruitment-views.js';
import {
  BoardQueryDto,
  CandidatesQueryDto,
  CloseOpeningDto,
  CreateApplicationDto,
  CreateCriterionDto,
  CreateReasonDto,
  isUuid,
  LinkPersonDto,
  MatchCandidatesDto,
  MoveApplicationDto,
  NoteDto,
  OpeningCriteriaDto,
  OpeningsQueryDto,
  PolicyDto,
  ReopenApplicationDto,
  RequestOpeningDto,
  UpdateApplicationDto,
  UpdateCandidateDto,
  UpdateCriterionDto,
  UpdateOpeningDto,
  UpdateReasonDto,
  UploadCandidateFileDto,
} from './recruitment.dto.js';

export function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/**
 * The bytes of a candidate file, always as an attachment under the sniffed type, with `nosniff`, a sandboxing CSP and
 * no caching — exactly the employee file's response (docs/contracts/documents.md › Upload validation).
 */
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

/** Job openings, HR side (docs/contracts/recruitment.md › Endpoints › Openings). */
@Controller('recruitment')
export class RecruitmentOpeningsController {
  constructor(
    private readonly openings: OpeningsService,
    private readonly applications: ApplicationsService,
  ) {}

  /** A unit head (no permission) or HR holding recruitment.manage over the unit — the use case decides (403). */
  @Post('openings')
  @Authenticated()
  async request(@Body() body: RequestOpeningDto, @Res({ passthrough: true }) res: Response): Promise<OpeningDetailView> {
    const view = await this.openings.request(body);
    res.setHeader('Location', `/api/recruitment/openings/${view.id}`);
    return view;
  }

  @Get('openings')
  @RequirePermission('recruitment.read')
  list(@Query() query: OpeningsQueryDto): Promise<OpeningPage> {
    return this.openings.list(query);
  }

  @Get('summary')
  @RequirePermission('recruitment.read')
  summary(): Promise<SummaryView> {
    return this.openings.summary();
  }

  @Get('openings/:id')
  @RequirePermission('recruitment.read')
  detail(@Param('id') id: string): Promise<OpeningDetailView> {
    return this.openings.detail(idParam(id, 'Opening'));
  }

  @Patch('openings/:id')
  @RequirePermission('recruitment.manage')
  update(@Param('id') id: string, @Body() body: UpdateOpeningDto): Promise<OpeningDetailView> {
    return this.openings.update(idParam(id, 'Opening'), body);
  }

  /** The criteria interviewers score (while open, until the first evaluation). */
  @Put('openings/:id/criteria')
  @RequirePermission('recruitment.manage')
  setCriteria(@Param('id') id: string, @Body() body: OpeningCriteriaDto): Promise<OpeningDetailView> {
    return this.openings.setCriteria(idParam(id, 'Opening'), body.criterionIds);
  }

  @Post('openings/:id/close')
  @HttpCode(200)
  @RequirePermission('recruitment.manage')
  close(@Param('id') id: string, @Body() body: CloseOpeningDto): Promise<OpeningDetailView> {
    return this.openings.close(idParam(id, 'Opening'), body.reason);
  }

  @Post('openings/:id/reopen')
  @HttpCode(200)
  @RequirePermission('recruitment.manage')
  reopen(@Param('id') id: string): Promise<OpeningDetailView> {
    return this.openings.reopen(idParam(id, 'Opening'));
  }

  @Get('openings/:id/board')
  @RequirePermission('recruitment.read')
  board(@Param('id') id: string, @Query() query: BoardQueryDto): Promise<BoardView> {
    return this.applications.board(idParam(id, 'Opening'), query.includeFinal);
  }

  @Post('openings/:id/applications')
  @RequirePermission('recruitment.manage')
  addApplication(@Param('id') id: string, @Body() body: CreateApplicationDto): Promise<ApplicationDetailView> {
    return this.applications.create(idParam(id, 'Opening'), body);
  }
}

/** Candidates, applications and candidate files (docs/contracts/recruitment.md › Endpoints). */
@Controller('recruitment')
export class RecruitmentCandidatesController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly files: CandidateFilesService,
  ) {}

  /** Writes nothing; the answer is about candidates: never cached. */
  @Post('candidates/match')
  @HttpCode(200)
  @RequirePermission('recruitment.manage')
  async match(@Body() body: MatchCandidatesDto, @Res({ passthrough: true }) res: Response): Promise<{ candidates: CandidateMatchView[]; person: KnownPersonView | null }> {
    res.setHeader('Cache-Control', 'no-store');
    return this.applications.match(body);
  }

  @Get('candidates')
  @RequirePermission('recruitment.read')
  list(@Query() query: CandidatesQueryDto): Promise<ApplicationPage> {
    return this.applications.list(query);
  }

  @Get('candidates/:id')
  @RequirePermission('recruitment.read')
  candidate(@Param('id') id: string): Promise<CandidateView> {
    return this.applications.candidateDetail(idParam(id, 'Candidate'));
  }

  @Patch('candidates/:id')
  @RequirePermission('recruitment.manage')
  updateCandidate(@Param('id') id: string, @Body() body: UpdateCandidateDto): Promise<CandidateView> {
    return this.applications.updateCandidate(idParam(id, 'Candidate'), body);
  }

  @Put('candidates/:id/person')
  @RequirePermission('recruitment.manage')
  linkPerson(@Param('id') id: string, @Body() body: LinkPersonDto): Promise<CandidateView> {
    return this.applications.linkPerson(idParam(id, 'Candidate'), body.personId);
  }

  @Post('candidates/:id/erase')
  @HttpCode(204)
  @RequirePermission('recruitment.erase')
  erase(@Param('id') id: string): Promise<void> {
    return this.applications.erase(idParam(id, 'Candidate'));
  }

  /** No request transaction while the body streams in: the use case opens its own once the file is read. */
  @Post('candidates/:id/files')
  @SkipTransaction()
  @RequirePermission('recruitment.manage')
  @UseInterceptors(EmployeeFileUploadInterceptor)
  upload(@Param('id') id: string, @Body() body: UploadCandidateFileDto, @UploadedFile() file: UploadedCandidateFile | undefined): Promise<CandidateFileView> {
    return this.files.upload(idParam(id, 'Candidate'), body, file);
  }

  @Get('candidates/:id/files/:fileId/content')
  @RequirePermission('recruitment.read')
  async content(@Param('id') id: string, @Param('fileId') fileId: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendFile(res, await this.files.content(idParam(id, 'Candidate'), idParam(fileId, 'File')));
  }

  @Delete('candidates/:id/files/:fileId')
  @HttpCode(204)
  @RequirePermission('recruitment.manage')
  deleteFile(@Param('id') id: string, @Param('fileId') fileId: string): Promise<void> {
    return this.files.delete(idParam(id, 'Candidate'), idParam(fileId, 'File'));
  }

  @Get('applications/:id')
  @RequirePermission('recruitment.read')
  application(@Param('id') id: string): Promise<ApplicationDetailView> {
    return this.applications.detail(idParam(id, 'Application'));
  }

  @Patch('applications/:id')
  @RequirePermission('recruitment.manage')
  updateApplication(@Param('id') id: string, @Body() body: UpdateApplicationDto): Promise<ApplicationDetailView> {
    return this.applications.update(idParam(id, 'Application'), body);
  }

  @Post('applications/:id/move')
  @HttpCode(200)
  @RequirePermission('recruitment.manage')
  move(@Param('id') id: string, @Body() body: MoveApplicationDto): Promise<ApplicationDetailView> {
    return this.applications.move(idParam(id, 'Application'), body);
  }

  @Post('applications/:id/reopen')
  @HttpCode(200)
  @RequirePermission('recruitment.manage')
  reopen(@Param('id') id: string, @Body() body: ReopenApplicationDto): Promise<ApplicationDetailView> {
    return this.applications.reopen(idParam(id, 'Application'), body.expectedStage);
  }

  @Post('applications/:id/notes')
  @RequirePermission('recruitment.manage')
  addNote(@Param('id') id: string, @Body() body: NoteDto): Promise<NoteView> {
    return this.applications.addNote(idParam(id, 'Application'), body.body);
  }

  @Delete('applications/:id/notes/:noteId')
  @HttpCode(204)
  @RequirePermission('recruitment.manage')
  deleteNote(@Param('id') id: string, @Param('noteId') noteId: string): Promise<void> {
    return this.applications.deleteNote(idParam(id, 'Application'), idParam(noteId, 'Note'));
  }
}

/** Recruitment settings (docs/contracts/recruitment.md › Endpoints › Settings); writes need the whole company. */
@Controller('recruitment')
export class RecruitmentSettingsController {
  constructor(private readonly settings: RecruitmentSettingsService) {}

  @Get('policy')
  @RequirePermission('recruitment.read')
  policy(): Promise<PolicyView> {
    return this.settings.policy();
  }

  @Put('policy')
  @RequirePermission('recruitment.configure')
  savePolicy(@Body() body: PolicyDto): Promise<PolicyView> {
    return this.settings.savePolicy(body);
  }

  @Get('criteria')
  @RequirePermission('recruitment.read')
  criteria(): Promise<{ items: CriterionView[] }> {
    return this.settings.criteria();
  }

  @Post('criteria')
  @RequirePermission('recruitment.configure')
  createCriterion(@Body() body: CreateCriterionDto): Promise<CriterionView> {
    return this.settings.createCriterion(body);
  }

  @Put('criteria/:id')
  @RequirePermission('recruitment.configure')
  updateCriterion(@Param('id') id: string, @Body() body: UpdateCriterionDto): Promise<CriterionView> {
    return this.settings.updateCriterion(idParam(id, 'Criterion'), body);
  }

  @Get('rejection-reasons')
  @RequirePermission('recruitment.read')
  reasons(): Promise<{ items: ReasonView[] }> {
    return this.settings.reasons();
  }

  @Post('rejection-reasons')
  @RequirePermission('recruitment.configure')
  createReason(@Body() body: CreateReasonDto): Promise<ReasonView> {
    return this.settings.createReason(body);
  }

  @Put('rejection-reasons/:id')
  @RequirePermission('recruitment.configure')
  updateReason(@Param('id') id: string, @Body() body: UpdateReasonDto): Promise<ReasonView> {
    return this.settings.updateReason(idParam(id, 'Reason'), body);
  }
}

/**
 * The requester's and the unit heads' side (docs/contracts/recruitment.md › Scope › Head view): no permission — the
 * use cases answer 404 to anyone who neither requested the opening nor heads its unit (or a unit above it). The file
 * download also serves the interviewers of the application (Phase B).
 */
@Controller('me/recruitment')
export class MyRecruitmentController {
  constructor(
    private readonly openings: OpeningsService,
    private readonly files: CandidateFilesService,
  ) {}

  @Get('summary')
  @Authenticated()
  summary(): Promise<MySummaryView> {
    return this.openings.mySummary();
  }

  /** The units the caller heads and their sub-units: what the request form offers a head (whatever org_unit.read). */
  @Get('units')
  @Authenticated()
  units(): Promise<{ items: RequestableUnit[] }> {
    return this.openings.myUnits();
  }

  @Get('openings')
  @Authenticated()
  list(): Promise<{ items: MyOpeningView[] }> {
    return this.openings.mine();
  }

  @Get('openings/:id')
  @Authenticated()
  detail(@Param('id') id: string): Promise<MyOpeningDetailView> {
    return this.openings.myDetail(idParam(id, 'Opening'));
  }

  @Post('openings/:id/cancel')
  @HttpCode(200)
  @Authenticated()
  cancel(@Param('id') id: string): Promise<MyOpeningDetailView> {
    return this.openings.cancelOwn(idParam(id, 'Opening'));
  }

  @Get('applications/:id/files/:fileId/content')
  @Authenticated()
  async content(@Param('id') id: string, @Param('fileId') fileId: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    return sendFile(res, await this.files.headContent(idParam(id, 'Application'), idParam(fileId, 'File')));
  }
}
