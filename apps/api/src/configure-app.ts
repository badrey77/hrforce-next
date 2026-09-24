import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { PermissionGuard } from './platform/authz/permission.guard.js';
import { ENV } from './platform/config/config.module.js';
import type { Env } from './platform/config/env.schema.js';
import { RequestContextInterceptor } from './platform/context/request-context.interceptor.js';
import { ProblemDetailsFilter } from './platform/http/problem-details.filter.js';
import { requestIdMiddleware } from './platform/http/request-id.js';
import { ZodValidationPipe } from './platform/http/zod-validation.pipe.js';

export const API_PREFIX = 'api';

/**
 * Applies every global concern. Used by main.ts AND by every e2e test, so tests exercise the real stack.
 * Must be called before app.init()/app.listen().
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  // First middleware: every response (including body-parser errors and 404s) carries X-Request-Id.
  app.use(requestIdMiddleware);
  app.use(cookieParser(env.COOKIE_SECRET));

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(app.get(ProblemDetailsFilter));
  app.useGlobalPipes(app.get(ZodValidationPipe));
  app.useGlobalGuards(app.get(PermissionGuard));
  app.useGlobalInterceptors(app.get(RequestContextInterceptor));
  app.enableShutdownHooks();
  return app;
}
