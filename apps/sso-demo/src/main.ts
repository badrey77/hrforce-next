/**
 * Entry point of the SSO demo: validate the environment, discover HRForce (retried every 2 s for 60 s, since
 * scripts/dev-up.* start both at once), then listen on SSO_DEMO_PORT.
 */
import { pino } from 'pino';
import { createApp } from './app.js';
import { DEV_CLIENT_SECRET_MARKER, EnvError, loadEnv } from './env.js';
import { createRelyingParty, discover, withRetry } from './oidc.js';
import { SessionStore } from './session.js';

/** e.g. ECONNREFUSED while HRForce is still starting (fetch wraps it in a TypeError). */
function causeCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const logger = pino({
    name: 'sso-demo',
    level: env.logLevel,
    // Defence in depth: the demo never logs these, but a future log call must not leak them either.
    redact: ['*.idToken', '*.id_token', '*.access_token', '*.code', '*.code_verifier', '*.clientSecret', '*.claims', 'req.headers.cookie'],
  });
  if (env.clientSecret.includes(DEV_CLIENT_SECRET_MARKER)) {
    logger.warn({}, 'using the public development client secret of the seeded sso-demo client (development only)');
  }

  const config = await withRetry(() => discover(env), {
    onRetry: (attempt, error) =>
      logger.info({ attempt, issuer: env.issuer, errorName: error instanceof Error ? error.name : typeof error, cause: causeCode(error) }, 'HRForce discovery failed; retrying in 2 s'),
  });
  logger.info({ issuer: env.issuer }, 'HRForce discovered');

  const sessions = new SessionStore();
  const sweeper = setInterval(() => sessions.sweep(), 10 * 60 * 1000);
  sweeper.unref();

  const app = createApp({ env, rp: createRelyingParty(config, env), sessions, logger });
  const server = app.listen(env.port, () => {
    logger.info({ url: env.baseUrl, port: env.port }, 'SSO demo listening');
  });
  const stop = () => {
    clearInterval(sweeper);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  const message = error instanceof EnvError ? error.message : `SSO demo failed to start: ${error instanceof Error ? error.name + ': ' + error.message : String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
