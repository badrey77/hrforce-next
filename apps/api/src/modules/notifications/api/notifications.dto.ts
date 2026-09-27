import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';

export const NOTIFICATIONS_DEFAULT_LIMIT = 20;
export const NOTIFICATIONS_MAX_LIMIT = 100;

export class NotificationsQueryDto extends createZodDto(
  z.object({
    unreadOnly: z
      .enum(['true', 'false', '1', '0'], { message: 'true or false' })
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    before: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, { message: `Between 1 and ${NOTIFICATIONS_MAX_LIMIT}` })
      .max(NOTIFICATIONS_MAX_LIMIT, { message: `Between 1 and ${NOTIFICATIONS_MAX_LIMIT}` })
      .default(NOTIFICATIONS_DEFAULT_LIMIT),
  }),
) {}

/** PUT /me/notification-preferences body: `[{type, email}]` (types not listed keep their value). */
export class PreferencesDto extends createZodDto(
  z.array(z.object({ type: z.string().trim().min(1).max(64), email: z.boolean() }).strict()).max(20),
) {}
