import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DevAuthWarning, identityResolverFactory } from './authz/dev-auth.js';
import { PermissionCheck } from './authz/permission-check.js';
import { PermissionGuard } from './authz/permission.guard.js';
import { ConfigModule, ENV } from './config/config.module.js';
import { RequestContextInterceptor } from './context/request-context.interceptor.js';
import { RequestIdentityResolver } from './context/request-identity.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { JobQueue, PgJobQueue } from './jobs/job-queue.js';
import { ProblemDetailsFilter } from './http/problem-details.filter.js';
import { ZodValidationPipe } from './http/zod-validation.pipe.js';
import { LoggingModule } from './logging/logging.module.js';
import type { Env } from './config/env.schema.js';
import { PdfRenderer } from './pdf/pdf-renderer.js';
import { TypstPdfRenderer } from './pdf/typst-renderer.js';
import { XsrfGuard } from './security/xsrf.guard.js';

/**
 * Cross-cutting infrastructure.
 *  - The guard and the request-context interceptor are registered as APP_GUARD / APP_INTERCEPTOR, so ANY
 *    bootstrap of AppModule is deny-by-default and transactional, with or without configureApp().
 *  - The problem+json filter and the zod pipe are provided here and installed by configureApp().
 * Identity: CookieIdentityResolver (access-token cookie) + the DEV_AUTH header identity in development/test.
 * Permissions: PermissionEvaluator and ScopeService (platform/authz seams) are provided by the GLOBAL Authorization
 * module (grant-backed; DEV_PERMISSIONS=allow_all in dev/test). PermissionCheck resolves them from there, so every
 * application must import AuthorizationModule (AppModule does). XsrfGuard (APP_GUARD) checks every unsafe method.
 * JobQueue (platform/jobs): transactional enqueue of worker jobs (graphile_worker.add_job in the request transaction).
 * PdfRenderer (platform/pdf, ADR 008): Typst in worker threads, created at the first render (PDF_RENDER_* env).
 */
@Global()
@Module({
  imports: [ConfigModule, DbModule, LoggingModule],
  controllers: [HealthController],
  providers: [
    { provide: RequestIdentityResolver, inject: [ENV], useFactory: identityResolverFactory },
    DevAuthWarning,
    PermissionCheck,
    // Order matters: global guards run in registration order (XSRF first, then access policy).
    { provide: APP_GUARD, useClass: XsrfGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    ProblemDetailsFilter,
    ZodValidationPipe,
    { provide: JobQueue, useClass: PgJobQueue },
    {
      provide: PdfRenderer,
      inject: [ENV],
      useFactory: (env: Env) =>
        new TypstPdfRenderer({ timeoutMs: env.PDF_RENDER_TIMEOUT_MS, concurrency: env.PDF_RENDER_CONCURRENCY, ...(env.PDF_ASSETS_DIR ? { assetsDir: env.PDF_ASSETS_DIR } : {}) }),
    },
  ],
  exports: [ConfigModule, DbModule, RequestIdentityResolver, JobQueue, PdfRenderer],
})
export class PlatformModule {}
