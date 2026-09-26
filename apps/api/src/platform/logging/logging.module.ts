import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { getRequestId } from '../http/request-id.js';
import { REDACT_CENSOR, REDACT_PATHS, serializeRequestForLog } from './redaction.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
          // Query values may hold personal data (search by NIN, name): log parameter names only.
          serializers: { req: serializeRequestForLog },
          // The request id is assigned by requestIdMiddleware (registered first in configureApp).
          genReqId: (req: IncomingMessage) => getRequestId(req),
          customLogLevel: (_req, res, err) =>
            err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
          autoLogging: {
            ignore: (req: IncomingMessage & { originalUrl?: string }) =>
              (req.originalUrl ?? req.url ?? '').split('?')[0] === '/api/health',
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
