import { Global, Module } from '@nestjs/common';
import { DenyAllPermissionEvaluator, PermissionEvaluator } from './authz/permission-evaluator.js';
import { PermissionGuard } from './authz/permission.guard.js';
import { ConfigModule } from './config/config.module.js';
import { RequestContextInterceptor } from './context/request-context.interceptor.js';
import { AnonymousIdentityResolver, RequestIdentityResolver } from './context/request-identity.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { ProblemDetailsFilter } from './http/problem-details.filter.js';
import { ZodValidationPipe } from './http/zod-validation.pipe.js';
import { LoggingModule } from './logging/logging.module.js';

/**
 * Cross-cutting infrastructure. The global filter/pipe/guard/interceptor are provided here and
 * installed by configureApp(). Feature modules replace the seams by overriding
 * RequestIdentityResolver (Identity module) and PermissionEvaluator (Authorization module).
 */
@Global()
@Module({
  imports: [ConfigModule, DbModule, LoggingModule],
  controllers: [HealthController],
  providers: [
    { provide: RequestIdentityResolver, useClass: AnonymousIdentityResolver },
    { provide: PermissionEvaluator, useClass: DenyAllPermissionEvaluator },
    PermissionGuard,
    RequestContextInterceptor,
    ProblemDetailsFilter,
    ZodValidationPipe,
  ],
  exports: [ConfigModule, DbModule, RequestIdentityResolver, PermissionEvaluator],
})
export class PlatformModule {}
