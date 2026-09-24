import { applyDecorators, SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'hrforce:permission';
export const PUBLIC_KEY = 'hrforce:public';

/** Permission codes are lowercase `resource.action` (snake_case segments), e.g. `employee.read`. */
export const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** The route requires the given permission. Every handler needs this or @Public() (deny by default). */
export function RequirePermission(code: string): MethodDecorator & ClassDecorator {
  if (!PERMISSION_CODE_PATTERN.test(code)) {
    throw new Error(`Invalid permission code "${code}" (expected lowercase resource.action)`);
  }
  return applyDecorators(SetMetadata(PERMISSION_KEY, code));
}

/** The route is reachable without authentication or permission. */
export function Public(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(PUBLIC_KEY, true));
}
