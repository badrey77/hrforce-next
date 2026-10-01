import { Module } from '@nestjs/common';
import { ENV } from '../../platform/config/config.module.js';
import type { Env } from '../../platform/config/env.schema.js';
import { KYSELY, type Database } from '../../platform/db/database.js';
import { IdentityModule } from '../identity/index.js';
import { StaffingModule } from '../staffing/index.js';
import { SsoAdminController } from './api/sso-admin.controller.js';
import { SsoInteractionsController } from './api/sso-interactions.controller.js';
import { ClaimsBuilder } from './application/claims.js';
import { SsoAdminService } from './application/sso-admin.service.js';
import { SsoClock } from './application/sso-clock.js';
import { SsoInteractionsService } from './application/sso-interactions.service.js';
import { ClientAuthThrottle } from './infra/client-auth-throttle.js';
import { ClientDirectory } from './infra/client-directory.js';
import { OidcKeys } from './infra/oidc-keys.js';
import { buildOidcRuntime, OIDC_HTTP_HANDLER, OIDC_RUNTIME, type OidcRuntime } from './infra/oidc-provider.factory.js';
import { SsoRepository } from './infra/sso.repository.js';

/**
 * SSO (docs/contracts/sso.md, ADR 007): HRForce as an OpenID Connect provider (`oidc-provider`, mounted at /oidc by
 * configureApp(), state in Postgres), the sign-in handoff through HRForce's own sign-in page, connected apps with
 * show-once secrets, app roles managed in HRForce and carried in the ID token for that app only.
 */
@Module({
  imports: [IdentityModule, StaffingModule],
  controllers: [SsoInteractionsController, SsoAdminController],
  providers: [
    OidcKeys,
    SsoClock,
    SsoRepository,
    ClientDirectory,
    ClientAuthThrottle,
    ClaimsBuilder,
    SsoAdminService,
    SsoInteractionsService,
    {
      provide: OIDC_RUNTIME,
      inject: [ENV, KYSELY, OidcKeys, ClientDirectory, ClaimsBuilder, ClientAuthThrottle],
      useFactory: (env: Env, db: Database, keys: OidcKeys, clients: ClientDirectory, claims: ClaimsBuilder, throttle: ClientAuthThrottle) =>
        buildOidcRuntime({ env, db, keys, clients, claims, throttle }),
    },
    { provide: OIDC_HTTP_HANDLER, inject: [OIDC_RUNTIME], useFactory: (runtime: OidcRuntime) => runtime.handler },
  ],
  exports: [OIDC_RUNTIME, OIDC_HTTP_HANDLER],
})
export class SsoModule {}
