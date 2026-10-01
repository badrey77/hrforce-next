import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV } from '../../../platform/config/config.module.js';
import { DEV_OIDC_KEY, type Env } from '../../../platform/config/env.schema.js';
import { deriveOidcKeys, type OidcKeyMaterial } from './oidc-crypto.js';

/**
 * The subkeys of OIDC_KEY (docs/contracts/sso.md › Keys, secrets, environment); development/test fall back to the
 * public DEV_OIDC_KEY (insecure, warned at boot; production refuses to boot without its own key — platform/config).
 */
@Injectable()
export class OidcKeys implements OnApplicationBootstrap {
  readonly material: OidcKeyMaterial;
  private readonly devKey: boolean;
  private readonly logger = new Logger('OidcKeys');

  constructor(@Inject(ENV) env: Env) {
    this.devKey = env.OIDC_KEY === undefined;
    this.material = deriveOidcKeys(Buffer.from(env.OIDC_KEY ?? DEV_OIDC_KEY, 'base64'));
  }

  onApplicationBootstrap(): void {
    if (this.devKey) this.logger.warn('OIDC_KEY is not set: SSO client secrets and signing keys use the PUBLIC development key (insecure; development/test only).');
  }
}
