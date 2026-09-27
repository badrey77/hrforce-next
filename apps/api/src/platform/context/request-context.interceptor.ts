import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { PermissionCheck } from '../authz/permission-check.js';
import { KYSELY, type Database } from '../db/database.js';
import { getRequestId } from '../http/request-id.js';
import { runWithContext } from './request-context.js';
import { identityOf, RequestIdentityResolver } from './request-identity.js';
import { runInRequestTransaction } from './request-transaction.js';
import { SKIP_TRANSACTION_KEY } from './skip-transaction.decorator.js';

/**
 * Global (APP_INTERCEPTOR). Establishes the RequestContext and wraps the handler in ONE database transaction
 * (commit on success, rollback on error). Inside that transaction — tenant settings already applied — it first
 * asks {@link PermissionCheck} for the route's @RequirePermission decision, then runs the handler.
 * `next.handle()` must be invoked inside the ALS scope because Nest binds the handler's async context when
 * `handle()` is called.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly identityResolver: RequestIdentityResolver,
    private readonly reflector: Reflector,
    private readonly permissionCheck: PermissionCheck,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const skipTx = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_TRANSACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return from(this.handle(context, req, skipTx === true, next));
  }

  private async handle(context: ExecutionContext, req: Request, skipTx: boolean, next: CallHandler): Promise<unknown> {
    const identity = await identityOf(this.identityResolver, req);
    const run = async (): Promise<unknown> => {
      await this.permissionCheck.assertAllowed(context, identity);
      return lastValueFrom(next.handle(), { defaultValue: undefined });
    };
    const scope = { requestId: getRequestId(req), userId: identity.userId, companyId: identity.companyId };
    if (skipTx) {
      // No request transaction (e.g. the SSE stream): the access decision — permission and two-step sign-in
      // enforcement, which read the database — still runs under the caller's tenant, in its own short transaction.
      if (!this.permissionCheck.isPublic(context)) {
        await runInRequestTransaction(this.db, scope, () => this.permissionCheck.assertAllowed(context, identity));
      }
      return runWithContext({ ...scope, tx: null }, () => lastValueFrom(next.handle(), { defaultValue: undefined }));
    }
    return runInRequestTransaction(this.db, scope, run);
  }
}
