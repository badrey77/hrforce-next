import { Injectable, NotFoundException } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import type { NotificationSubjectType } from '../../../platform/notifications/notifier.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { audienceOf, EMAIL_DEFAULTS, encodeCursor, isNotificationType, linkOf, NOTIFICATION_TYPES, publicData, type NotificationCursor } from '../domain/notification-rules.js';
import { NotificationRepository, type NotificationRow } from '../infra/notification.repository.js';
import type { NotificationPage, NotificationView, PreferenceView } from './notification-views.js';

function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

const SUBJECT_TYPES: readonly NotificationSubjectType[] = ['workflow_task', 'leave_request', 'document_request', 'issued_document'];

function subjectTypeOf(value: string): NotificationSubjectType {
  return (SUBJECT_TYPES as readonly string[]).includes(value) ? (value as NotificationSubjectType) : 'leave_request';
}

export function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt,
    readAt: row.readAt,
    subject: { type: subjectTypeOf(row.subjectType), id: row.subjectId },
    data: publicData(row.data),
    audience: audienceOf(row.data),
    link: linkOf({ type: row.type, subjectType: row.subjectType, subjectId: row.subjectId, data: row.data }),
  };
}

/**
 * The caller's own notifications and e-mail preferences (docs/contracts/notifications.md › Endpoints). Every query is
 * bound to the caller (company + user) and RLS's restrictive own-user policy enforces it again: someone else's id is
 * a 404, like an unknown one.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly repo: NotificationRepository) {}

  async list(options: { unreadOnly: boolean; cursor: NotificationCursor | null; limit: number }): Promise<NotificationPage> {
    const { companyId, userId } = caller();
    const rows = await this.repo.list(companyId, userId, { ...options, limit: options.limit + 1 });
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return { items: page.map(toView), nextCursor: rows.length > options.limit && last ? encodeCursor({ at: last.createdAtMicros, id: last.id }) : null };
  }

  async unreadCount(): Promise<{ count: number }> {
    const { companyId, userId } = caller();
    return { count: await this.repo.unreadCount(companyId, userId) };
  }

  /** 204 whether it was unread or already read; 404 when it is not the caller's. */
  async markRead(id: string): Promise<void> {
    const { companyId, userId } = caller();
    const changed = await this.repo.markRead(companyId, userId, id);
    if (changed === undefined) throw new NotFoundException('Notification not found');
    if (changed) await this.repo.signalCountChanged(companyId, userId);
  }

  async markAllRead(): Promise<void> {
    const { companyId, userId } = caller();
    if ((await this.repo.markAllRead(companyId, userId)) > 0) await this.repo.signalCountChanged(companyId, userId);
  }

  async preferences(): Promise<PreferenceView[]> {
    const { companyId, userId } = caller();
    const stored = await this.repo.preferences(companyId, userId);
    return NOTIFICATION_TYPES.map((type) => ({ type, email: stored.get(type) ?? EMAIL_DEFAULTS[type], default: EMAIL_DEFAULTS[type] }));
  }

  async setPreferences(items: readonly { type: string; email: boolean }[]): Promise<PreferenceView[]> {
    const { companyId, userId } = caller();
    const errors = items.flatMap((item, i) =>
      isNotificationType(item.type) ? [] : [{ field: `${i}.type`, code: 'unknown_type', message: `Unknown notification type (one of ${NOTIFICATION_TYPES.join(', ')})` }],
    );
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.type)) errors.push({ field: `${i}.type`, code: 'duplicate', message: 'Each type at most once' });
      seen.add(item.type);
    });
    if (errors.length) throw new ValidationProblemException(errors);
    for (const item of items) await this.repo.setPreference(companyId, userId, item.type, item.email);
    return this.preferences();
  }
}
