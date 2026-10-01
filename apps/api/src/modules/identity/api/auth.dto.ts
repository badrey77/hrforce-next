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

/**
 * POST /api/auth/mfa/verify: exactly one of `code` (6-digit TOTP) and `recoveryCode` (`XXXXX-XXXXX`; case, spaces and
 * hyphens are ignored). INPUT only; never echoed or logged (log redaction).
 */
export class MfaVerifyRequestDto extends createZodDto(
  z
    .object({
      code: z.string().trim().max(16).optional(),
      recoveryCode: z.string().max(64).optional(),
    })
    .superRefine((body, ctx) => {
      if ((body.code === undefined) === (body.recoveryCode === undefined)) {
        ctx.addIssue({ code: 'custom', path: ['code'], message: 'Provide either code or recoveryCode' });
      }
    }),
) {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/auth/logout: no body (the web's own sign-out), or `{expectedUserId}` (docs/contracts/sso.md › Logout flow:
 * the RP-initiated logout page). Anything else → 422.
 */
export class LogoutRequestDto extends createZodDto(
  // no body at all → {} (the web's own sign-out sends none)
  z.preprocess((body) => body ?? {}, z.object({ expectedUserId: z.string().regex(UUID, { message: 'Must be a UUID' }).optional() }).strict()),
) {}
