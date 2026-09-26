import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT } from '../domain/timeline.js';

export class TimelineQueryDto extends createZodDto(
  z.object({
    subject: z.string({ message: 'Required: <type>:<id>' }).trim().min(1, { message: 'Required: <type>:<id>' }).max(80),
    before: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, { message: `Between 1 and ${TIMELINE_MAX_LIMIT}` })
      .max(TIMELINE_MAX_LIMIT, { message: `Between 1 and ${TIMELINE_MAX_LIMIT}` })
      .default(TIMELINE_DEFAULT_LIMIT),
  }),
) {}
