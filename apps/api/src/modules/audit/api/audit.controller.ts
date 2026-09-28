import { Controller, ForbiddenException, Get, NotFoundException, Query } from '@nestjs/common';
import { Authenticated } from '../../../platform/authz/decorators.js';
import { PermissionEvaluator } from '../../../platform/authz/permission-evaluator.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import type { TimelineView } from '../application/timeline-views.js';
import { AUDIT_READ, TimelineService } from '../application/timeline.service.js';
import { decodeCursor, parseSubject, SELF_VISIBLE_SUBJECT_TYPES, TIMELINE_SUBJECT_TYPES } from '../domain/timeline.js';
import { TimelineQueryDto } from './audit.dto.js';

/** docs/contracts/audit.md › Endpoint. */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly timelines: TimelineService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  /**
   * `GET /api/audit/timeline?subject=<type>:<id>&before=<cursor>&limit=50` — newest first, cursor pagination.
   * Access: `audit.read` for every subject type (403 when not held anywhere, before any validation) EXCEPT
   * `leave_request`, whose history follows the request's own visibility (docs/contracts/notifications.md › Audit gap:
   * leave.read in scope, the requester / the employee's user, or a current candidate), and `issued_document`, visible
   * like GET /documents/:id (document.read over the employee's scope unit, docs/contracts/documents.md › Audit) — hence
   * @Authenticated here.
   * 422 for an unknown subject type or a malformed cursor; 404 for an unknown, other-company or out-of-scope subject
   * (a malformed id cannot exist either).
   */
  @Get('timeline')
  @Authenticated()
  async timeline(@Query() query: TimelineQueryDto): Promise<TimelineView> {
    if (!SELF_VISIBLE_SUBJECT_TYPES.some((type) => query.subject.startsWith(`${type}:`))) {
      const { userId, companyId } = requireContext();
      if (!(await this.evaluator.hasPermission({ userId, companyId }, AUDIT_READ))) throw new ForbiddenException();
    }
    const parsed = parseSubject(query.subject);
    if (!parsed.ok) {
      if (parsed.reason === 'unknown') throw new NotFoundException('Subject not found');
      throw new ValidationProblemException([
        { field: 'subject', code: 'invalid_subject', message: `Expected <type>:<id> with type in ${TIMELINE_SUBJECT_TYPES.join(', ')}` },
      ]);
    }
    const cursor = query.before === undefined ? null : decodeCursor(query.before);
    if (query.before !== undefined && !cursor) {
      throw new ValidationProblemException([{ field: 'before', code: 'invalid_cursor', message: 'Unknown cursor' }]);
    }
    return this.timelines.timeline(parsed.subject, cursor, query.limit);
  }
}
