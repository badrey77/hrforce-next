import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { AdapterPayload } from 'oidc-provider';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { SSO_SCOPE_STRING, type ClientAuthMethod } from '../domain/rules.js';
import type { ClientSource } from './oidc-adapter.js';
import { OidcKeys } from './oidc-keys.js';
import { open } from './oidc-crypto.js';

/** An active client as the global lookup returns it (secret still sealed). */
export interface ActiveClient {
  id: string;
  companyId: string;
  clientId: string;
  name: string;
  nameAr: string | null;
  secretEnc: Buffer;
  clientAuthMethod: ClientAuthMethod;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}

/** Extra client metadata carrying the client's company (keeps its snake_case name on the client instance). */
export const COMPANY_METADATA = 'hrforce_company_id';
/** Extra metadata: the Arabic name (logout page). */
export const NAME_AR_METADATA = 'hrforce_name_ar';

/**
 * The provider's view of sso_client (docs/contracts/sso.md › Data): public.sso_client_by_client_id(), a SECURITY
 * DEFINER lookup by the GLOBAL client_id before any tenant is known — active clients only — on the root pool.
 */
@Injectable()
export class ClientDirectory implements ClientSource {
  private readonly logger = new Logger('ClientDirectory');

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly keys: OidcKeys,
  ) {}

  async active(clientId: string): Promise<ActiveClient | undefined> {
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 64) return undefined;
    const { rows } = await sql<ActiveClient>`
      select id, company_id as "companyId", client_id as "clientId", name, name_ar as "nameAr", secret_enc as "secretEnc",
             client_auth_method as "clientAuthMethod", redirect_uris as "redirectUris", post_logout_redirect_uris as "postLogoutRedirectUris"
        from public.sso_client_by_client_id(${clientId})`.execute(this.db);
    return rows[0];
  }

  /** Client metadata for the provider; a secret that cannot be decrypted → undefined (invalid_client) + an error log. */
  async find(clientId: string): Promise<AdapterPayload | undefined> {
    const client = await this.active(clientId);
    if (!client) return undefined;
    const secret = open(this.keys.material.aead, client.secretEnc, client.clientId);
    if (secret === null) {
      this.logger.error({ clientId: client.clientId }, 'SSO client secret cannot be decrypted with OIDC_KEY: rotate the secret of this app (Access → Applications)');
      return undefined;
    }
    return {
      client_id: client.clientId,
      client_secret: secret,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      post_logout_redirect_uris: client.postLogoutRedirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      response_modes: ['query'],
      token_endpoint_auth_method: client.clientAuthMethod,
      id_token_signed_response_alg: 'RS256',
      require_auth_time: true,
      scope: SSO_SCOPE_STRING,
      [COMPANY_METADATA]: client.companyId,
      ...(client.nameAr ? { [NAME_AR_METADATA]: client.nameAr } : {}),
    } as AdapterPayload;
  }
}
