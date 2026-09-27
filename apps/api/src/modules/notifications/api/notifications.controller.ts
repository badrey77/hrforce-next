import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AllowWithoutMfa, Authenticated } from '../../../platform/authz/decorators.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { identityOf, RequestIdentityResolver } from '../../../platform/context/request-identity.js';
import { SkipTransaction } from '../../../platform/context/skip-transaction.decorator.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { getRequestId } from '../../../platform/http/request-id.js';
import { NotificationStreams } from '../application/notification-stream.js';
import type { NotificationPage, PreferenceView } from '../application/notification-views.js';
import { NotificationsService } from '../application/notifications.service.js';
import { decodeCursor } from '../domain/notification-rules.js';
import { NotificationsQueryDto, PreferencesDto } from './notifications.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller's notifications (docs/contracts/notifications.md › Endpoints). Every route is @Authenticated: a user
 * only ever sees and marks their OWN rows (service filter + RLS restrictive policy) — someone else's id is a 404.
 * Marking read is not audited (notification is audit-exempt: derived, high-volume data); preferences are.
 */
@Controller('me')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly streams: NotificationStreams,
    private readonly identities: RequestIdentityResolver,
  ) {}

  @Get('notifications')
  @Authenticated()
  list(@Query() query: NotificationsQueryDto): Promise<NotificationPage> {
    const cursor = query.before === undefined ? null : decodeCursor(query.before);
    if (query.before !== undefined && !cursor) throw new ValidationProblemException([{ field: 'before', code: 'invalid_cursor', message: 'Unknown cursor' }]);
    return this.notifications.list({ unreadOnly: query.unreadOnly, cursor, limit: query.limit });
  }

  @Get('notifications/unread-count')
  @Authenticated()
  @AllowWithoutMfa() // the shell's bell polls it before the user has enrolled (docs/contracts/mfa.md › Enforcement)
  unreadCount(): Promise<{ count: number }> {
    return this.notifications.unreadCount();
  }

  /**
   * Server-Sent Events (`text/event-stream`): `unread` {count}, `notification` <NotificationView>, `: ping` every 25 s;
   * closes when the access token expires. No request transaction: the stream re-reads rows in short transactions.
   */
  @Get('notifications/stream')
  @Authenticated()
  @SkipTransaction()
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { companyId, userId } = requireContext();
    if (!companyId || !userId) throw new NotFoundException();
    const identity = await identityOf(this.identities, req);
    await this.streams.start(req, res, { requestId: getRequestId(req), companyId, userId, expiresAt: identity.expiresAt ?? null });
  }

  @Post('notifications/read-all')
  @HttpCode(204)
  @Authenticated()
  readAll(): Promise<void> {
    return this.notifications.markAllRead();
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  @Authenticated()
  read(@Param('id') id: string): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException('Notification not found');
    return this.notifications.markRead(id.toLowerCase());
  }

  @Get('notification-preferences')
  @Authenticated()
  preferences(): Promise<PreferenceView[]> {
    return this.notifications.preferences();
  }

  @Put('notification-preferences')
  @Authenticated()
  setPreferences(@Body() body: PreferencesDto): Promise<PreferenceView[]> {
    return this.notifications.setPreferences(body);
  }
}
