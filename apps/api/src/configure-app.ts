import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { END_SESSION_SCRIPT_PATH, endSessionScript, OIDC_HTTP_HANDLER, OIDC_RUNTIME, oidcAccessLog, oidcHostCheck, type OidcRuntime } from './modules/sso/index.js';
import { ENV } from './platform/config/config.module.js';
import type { Env } from './platform/config/env.schema.js';
import { ProblemDetailsFilter } from './platform/http/problem-details.filter.js';
import { requestIdMiddleware } from './platform/http/request-id.js';
import { ZodValidationPipe } from './platform/http/zod-validation.pipe.js';

export const API_PREFIX = 'api';

/**
 * Applies every global concern. Used by main.ts AND by every e2e test, so tests exercise the real stack.
 * Must be called before app.init()/app.listen().
 * The deny-by-default PermissionGuard and the RequestContextInterceptor are NOT installed here: PlatformModule
 * registers them as APP_GUARD / APP_INTERCEPTOR so that they apply to every bootstrap of AppModule.
 */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  // First middleware: every response (including body-parser errors and 404s) carries X-Request-Id.
  app.use(requestIdMiddleware);
  app.use(cookieParser(env.COOKIE_SECRET));
  // The OpenID Connect provider (docs/contracts/sso.md, ADR 007 §2): outside the `api` prefix and BEFORE Nest's body
  // parsers (registered at init()); Nest's guards, interceptors and pipes never run for /oidc. The logout page's
  // script is served first, then the access log, the host check and the provider itself.
  app.use(END_SESSION_SCRIPT_PATH, oidcAccessLog, endSessionScript);
  app.use('/oidc', oidcAccessLog, oidcHostCheck(app.get<OidcRuntime>(OIDC_RUNTIME).issuer), app.get(OIDC_HTTP_HANDLER));

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(app.get(ProblemDetailsFilter));
  app.useGlobalPipes(app.get(ZodValidationPipe));
  app.enableShutdownHooks();
  return app;
}
