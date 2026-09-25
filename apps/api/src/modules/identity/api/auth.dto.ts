import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';

/** POST /api/auth/login. `password` is INPUT only (allowlisted in tools/guardrails/secret-fields-allow.json). */
export class LoginRequestDto extends createZodDto(
  z.object({
    email: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1024),
  }),
) {}

/** POST /api/auth/password/forgot */
export class ForgotPasswordRequestDto extends createZodDto(
  z.object({
    email: z.string().trim().min(1).max(320),
  }),
) {}

/**
 * POST /api/auth/password/setup. `token` and `password` are INPUT only (allowlisted). The password rules are
 * applied by the service (422 codes too_short | too_long | contains_email | common), not here.
 */
export class PasswordSetupRequestDto extends createZodDto(
  z.object({
    token: z.string().min(1).max(256),
    password: z.string().max(4096),
  }),
) {}
