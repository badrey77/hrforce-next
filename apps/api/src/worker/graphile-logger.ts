import { Logger as GraphileLogger } from 'graphile-worker';
import type { Logger } from 'pino';

/** Graphile Worker's logger → pino (structured JSON like the API); `warning` → warn. */
export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => (level, message, meta) => {
    const payload = { graphile: scope, ...meta };
    if (level === 'error') logger.error(payload, message);
    else if (level === 'warning') logger.warn(payload, message);
    else if (level === 'info') logger.info(payload, message);
    else logger.debug(payload, message);
  });
}
