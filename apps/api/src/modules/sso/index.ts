/** Public surface of the SSO module (the only file other modules may import). */
export { SsoModule } from './sso.module.js';
export { SsoClock } from './application/sso-clock.js';
export {
  addFormActionSource,
  endSessionScript,
  OIDC_CSP,
  OIDC_HTTP_HANDLER,
  OIDC_RUNTIME,
  oidcAccessLog,
  oidcHostCheck,
  type HttpHandler,
  type OidcRuntime,
} from './infra/oidc-provider.factory.js';
export { END_SESSION_SCRIPT_PATH } from './infra/oidc-pages.js';
export { DEMO_SSO_CLIENT, seedDemoSso, seedSsoClient, type SeedSsoClient } from './infra/sso-seed.js';
export { deriveOidcKeys, open as oidcOpen, seal as oidcSeal } from './infra/oidc-crypto.js';
export { hashId as oidcHashId } from './infra/oidc-adapter.js';
export { ensureCurrentKey, keyStatus, listKeys, loadSigningKeys, OidcKeysCommandError, promoteKey, pruneKeys, resetKeys, runOidcKeysCommand, stageKey } from './infra/signing-keys.js';
export { THROTTLE_LIMIT, THROTTLE_WINDOW_SECONDS } from './infra/client-auth-throttle.js';
export { runOidcCleanup, type OidcCleanupResult } from './infra/oidc-cleanup.js';
