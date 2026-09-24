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
import { KYSELY, type Database } from '../db/database.js';
import { getRequestId } from '../http/request-id.js';
import { runWithContext } from './request-context.js';
import { identityOf, RequestIdentityResolver } from './request-identity.js';
import { runInRequestTransaction } from './request-transaction.js';
import { SKIP_TRANSACTION_KEY } from './skip-transaction.decorator.js';

/**
 * Establishes the RequestContext and wraps the handler in ONE database transaction
 * (commit on success, rollback on error). `next.handle()` must be invoked inside the ALS scope because
 * Nest binds the handler's async context when `handle()` is called.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly identityResolver: RequestIdentityResolver,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const skipTx = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_TRANSACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const run = () => lastValueFrom(next.handle(), { defaultValue: undefined });
    return from(this.handle(req, skipTx === true, run));
  }

  private async handle(req: Request, skipTx: boolean, run: () => Promise<unknown>): Promise<unknown> {
    const identity = await identityOf(this.identityResolver, req);
    const scope = { requestId: getRequestId(req), userId: identity.userId, companyId: identity.companyId };
    if (skipTx) return runWithContext({ ...scope, tx: null }, run);
    return runInRequestTransaction(this.db, scope, run);
  }
}
