import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import { HireService, OffersService } from '../application/hire.service.js';
import { InterviewsService } from '../application/interviews.service.js';
import type { ApplicationDetailView, ComparisonView, HirePrefillView, HireResult, InterviewerOption, InterviewView, MyInterviewView } from '../application/recruitment-views.js';
import { idParam } from './recruitment.controller.js';
import {
  CancelInterviewDto,
  EndOfferDto,
  EvaluationDto,
  HireDto,
  InterviewersQueryDto,
  MakeOfferDto,
  MyInterviewsQueryDto,
  ScheduleInterviewDto,
  UndoHireDto,
  UpdateInterviewDto,
  UpdateOfferDto,
} from './recruitment.dto.js';

/** Interviews and the comparison, HR side (docs/contracts/recruitment.md › Endpoints (Phase B)). */
@Controller('recruitment')
export class RecruitmentInterviewsController {
  constructor(private readonly interviews: InterviewsService) {}

  @Get('interviewers')
  @RequirePermission('recruitment.manage')
  picker(@Query() query: InterviewersQueryDto): Promise<{ items: InterviewerOption[] }> {
    return this.interviews.picker(query.q);
  }

  @Post('applications/:id/interviews')
  @RequirePermission('recruitment.manage')
  schedule(@Param('id') id: string, @Body() body: ScheduleInterviewDto): Promise<InterviewView> {
    return this.interviews.schedule(idParam(id, 'Application'), body);
  }

  @Patch('interviews/:id')
  @RequirePermission('recruitment.manage')
  update(@Param('id') id: string, @Body() body: UpdateInterviewDto): Promise<InterviewView> {
    return this.interviews.update(idParam(id, 'Interview'), body);
  }

  @Post('interviews/:id/cancel')
  @HttpCode(200)
  @RequirePermission('recruitment.manage')
  cancel(@Param('id') id: string, @Body() body: CancelInterviewDto): Promise<InterviewView> {
    return this.interviews.cancel(idParam(id, 'Interview'), body.reason);
  }

  @Get('openings/:id/comparison')
  @RequirePermission('recruitment.read')
  comparison(@Param('id') id: string): Promise<ComparisonView> {
    return this.interviews.comparison(idParam(id, 'Opening'));
  }
}

/** Offers, the hire and its undo (docs/contracts/recruitment.md › Offers, › Hire): `recruitment.hire` over the unit. */
@Controller('recruitment')
export class RecruitmentHireController {
  constructor(
    private readonly offers: OffersService,
    private readonly hires: HireService,
  ) {}

  @Post('applications/:id/offer')
  @RequirePermission('recruitment.hire')
  makeOffer(@Param('id') id: string, @Body() body: MakeOfferDto): Promise<ApplicationDetailView> {
    return this.offers.make(idParam(id, 'Application'), body);
  }

  @Put('applications/:id/offer')
  @RequirePermission('recruitment.hire')
  updateOffer(@Param('id') id: string, @Body() body: UpdateOfferDto): Promise<ApplicationDetailView> {
    const { expectedStage: _ignored, ...patch } = body;
    return this.offers.update(idParam(id, 'Application'), patch);
  }

  @Post('applications/:id/offer/decline')
  @HttpCode(200)
  @RequirePermission('recruitment.hire')
  declineOffer(@Param('id') id: string, @Body() body: EndOfferDto): Promise<ApplicationDetailView> {
    return this.offers.end(idParam(id, 'Application'), 'decline', body);
  }

  @Post('applications/:id/offer/cancel')
  @HttpCode(200)
  @RequirePermission('recruitment.hire')
  cancelOffer(@Param('id') id: string, @Body() body: EndOfferDto): Promise<ApplicationDetailView> {
    return this.offers.end(idParam(id, 'Application'), 'cancel', body);
  }

  @Get('applications/:id/hire-prefill')
  @RequirePermission('recruitment.hire')
  prefill(@Param('id') id: string): Promise<HirePrefillView> {
    return this.hires.prefill(idParam(id, 'Application'));
  }

  /** The body of POST /employees + `expectedStage` + `copyFileIds`: one transaction, or nothing at all. */
  @Post('applications/:id/hire')
  @RequirePermission('recruitment.hire')
  async hire(@Param('id') id: string, @Body() body: HireDto, @Res({ passthrough: true }) res: Response): Promise<HireResult> {
    const result = await this.hires.hire(idParam(id, 'Application'), body);
    res.setHeader('Location', `/api/employees/${result.employee.id}`);
    return result;
  }

  @Post('applications/:id/undo-hire')
  @HttpCode(200)
  @RequirePermission('recruitment.hire')
  undoHire(@Param('id') id: string, @Body() body: UndoHireDto): Promise<ApplicationDetailView> {
    return this.hires.undo(idParam(id, 'Application'), body.reason);
  }
}

/**
 * « Mes entretiens » and the heads' comparison: no permission — the use cases answer 404 to anyone who is not an
 * interviewer of the interview (while it is scheduled and the application in progress), respectively not a head of
 * the opening's unit.
 */
@Controller('me/recruitment')
export class MyInterviewsController {
  constructor(private readonly interviews: InterviewsService) {}

  @Get('interviews')
  @Authenticated()
  list(@Query() query: MyInterviewsQueryDto): Promise<{ items: MyInterviewView[] }> {
    return this.interviews.mine(query.filter);
  }

  @Get('interviews/:id')
  @Authenticated()
  detail(@Param('id') id: string): Promise<MyInterviewView> {
    return this.interviews.myDetail(idParam(id, 'Interview'));
  }

  @Put('interviews/:id/evaluation')
  @Authenticated()
  evaluate(@Param('id') id: string, @Body() body: EvaluationDto): Promise<MyInterviewView> {
    return this.interviews.evaluate(idParam(id, 'Interview'), body);
  }

  @Get('openings/:id/comparison')
  @Authenticated()
  comparison(@Param('id') id: string): Promise<ComparisonView> {
    return this.interviews.myComparison(idParam(id, 'Opening'));
  }
}
