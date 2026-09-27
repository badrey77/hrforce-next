import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';

/** POST /api/me/mfa/enroll/confirm, /recovery-codes, /disable: the current 6-digit TOTP code (INPUT only). */
export class MfaCodeRequestDto extends createZodDto(z.object({ code: z.string().trim().min(1).max(16) })) {}
