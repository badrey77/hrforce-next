import { applyDecorators, SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'hrforce:permission';
export const PUBLIC_KEY = 'hrforce:public';
export const AUTHENTICATED_KEY = 'hrforce:authenticated';
export const ALLOW_WITHOUT_MFA_KEY = 'hrforce:allowWithoutMfa';

/**
 * Permission codes are lowercase `resource.action`, or `resource.field.action` for field-level permissions (snake_case
 * segments), e.g. `employee.read`, `employee.salary.update` — the same shape as the `permission` catalogue's check.
 */
export const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

/**
 * The route requires the given permission. Every handler needs exactly one of this, @Authenticated() or @Public()
 * (deny by default).
 */
export function RequirePermission(code: string): MethodDecorator & ClassDecorator {
  if (!PERMISSION_CODE_PATTERN.test(code)) {
    throw new Error(`Invalid permission code "${code}" (expected lowercase resource.action or resource.field.action)`);
  }
  return applyDecorators(SetMetadata(PERMISSION_KEY, code));
}

/** The route is reachable without authentication or permission. */
export function Public(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(PUBLIC_KEY, true));
}

/** The route needs an authenticated caller (401 otherwise) but no particular permission (e.g. GET /api/me). */
export function Authenticated(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(AUTHENTICATED_KEY, true));
}

/**
 * The route stays reachable by a signed-in user whom the company requires to use two-step sign-in but who has not
 * enrolled yet (docs/contracts/mfa.md › Enforcement: GET /me, /me/mfa*, the unread count). Every other non-public
 * route answers 403 `mfa-enrollment-required` to such a user. Only meaningful with @Authenticated(); every use is
 * listed with a reason in tools/guardrails/mfa-exempt.json (route-scan).
 */
export function AllowWithoutMfa(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(ALLOW_WITHOUT_MFA_KEY, true));
}
