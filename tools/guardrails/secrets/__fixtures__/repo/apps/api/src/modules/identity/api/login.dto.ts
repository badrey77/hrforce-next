import { z } from 'zod';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';

/** Input DTO: the password is allowlisted (secret-fields-allow.json). */
export class LoginRequestDto extends createZodDto(z.object({ username: z.string(), password: z.string() })) {}
