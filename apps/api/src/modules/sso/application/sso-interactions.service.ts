import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Provider } from 'oidc-provider';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { identityOf, RequestIdentityResolver } from '../../../platform/context/request-identity.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { IdentitySessions } from '../../identity/index.js';
import { freshLoginRequired, INTERACTION_UID_PATTERN, parseMaxAge } from '../domain/rules.js';
import { ClientDirectory, type ActiveClient } from '../infra/client-directory.js';
import { OIDC_RUNTIME, type OidcRuntime } from '../infra/oidc-provider.factory.js';
import { SsoClock } from './sso-clock.js';
import type { SsoInteractionView, SsoRedirectView } from './sso-views.js';

type InteractionDetails = Awaited<ReturnType<Provider['interactionDetails']>>;

const notFound = () => new ProblemException(404, 'sso-interaction-not-found', 'This sign-in request has expired or is unknown. Start again from the app.');
const clientUnavailable = () => new ProblemException(409, 'sso-client-unavailable', 'This app is disabled or unknown.');
const sessionExpired = () => new ProblemException(401, 'session-expired', 'Your session has expired. Please sign in again.');

/** The interaction uid of a path, or 404 `sso-interaction-not-found` when malformed. */
export function interactionUid(uid: string): string {
  if (!INTERACTION_UID_PATTERN.test(uid)) throw notFound();
  return uid;
}

/**
 * The sign-in handoff (docs/contracts/sso.md › Sign-in flow, ADR 007 §3): the provider's interaction is bound to the
 * browser by the `hrf_op_interaction` cookie (Path=/api/sso/interactions/<uid>); the Angular page /sso/<uid> reads
 * its details, sends the user through HRForce's own sign-in when needed, then completes it with the HRForce session.
 * Checks of `complete`, in this order: interaction → client active → live HRForce session (whole refresh family) and
 * active account → member of the CLIENT's company → fresh-login needs → result → audit `sso.sign_in`.
 */
@Injectable()
export class SsoInteractionsService {
  private readonly logger = new Logger('SsoInteractions');

  constructor(
    @Inject(OIDC_RUNTIME) private readonly runtime: OidcRuntime,
    private readonly clients: ClientDirectory,
    private readonly identities: IdentitySessions,
    private readonly identityResolver: RequestIdentityResolver,
    private readonly audit: AuditEvents,
    private readonly clock: SsoClock,
  ) {}

  private provider(): Provider {
    if (!this.runtime.provider) throw new ProblemException(503, 'sso-unavailable', 'Single sign-on is temporarily unavailable.');
    return this.runtime.provider;
  }

  /** The interaction of THIS browser (its interaction cookie) for `uid`; anything else is 404. */
  private async interaction(req: Request, res: Response, uid: string): Promise<InteractionDetails> {
    const provider = this.provider();
    let details: InteractionDetails;
    try {
      details = await provider.interactionDetails(req, res);
    } catch {
      throw notFound();
    }
    if (details.uid !== uid) throw notFound();
    return details;
  }

  private async activeClient(details: InteractionDetails): Promise<ActiveClient> {
    const clientId = details.params['client_id'];
    const client = typeof clientId === 'string' ? await this.clients.active(clientId) : undefined;
    if (!client) throw clientUnavailable();
    return client;
  }

  private fresh(details: InteractionDetails, authTime: Date): boolean {
    const prompt = details.params['prompt'];
    return freshLoginRequired({
      prompt: typeof prompt === 'string' ? prompt : undefined,
      maxAge: parseMaxAge(details.params['max_age']),
      authTime,
      interactionCreatedAt: typeof details.iat === 'number' ? details.iat : 0,
      now: new Date(this.clock.nowMs()),
    });
  }

  async details(req: Request, res: Response, uid: string): Promise<SsoInteractionView> {
    const details = await this.interaction(req, res, uid);
    const client = await this.activeClient(details);
    const identity = await identityOf(this.identityResolver, req);
    let freshLogin = false;
    if (identity.userId && identity.sessionId) {
      const session = await this.identities.ssoSession(identity.sessionId, identity.userId);
      if (session?.live && session.accountStatus === 'active') freshLogin = this.fresh(details, session.authTime);
    }
    return { uid: details.uid, client: { clientId: client.clientId, name: client.name, nameAr: client.nameAr }, freshLoginRequired: freshLogin };
  }

  async complete(req: Request, res: Response, uid: string): Promise<SsoRedirectView> {
    const details = await this.interaction(req, res, uid);
    const client = await this.activeClient(details);
    const identity = await identityOf(this.identityResolver, req);
    // SSO needs a real HRForce session (DEV_AUTH header identities have none)
    if (!identity.userId || !identity.sessionId) throw sessionExpired();
    const session = await this.identities.ssoSession(identity.sessionId, identity.userId);
    if (!session?.live) throw sessionExpired();
    if (session.accountStatus !== 'active') throw new ProblemException(403, 'account-disabled', 'This account is disabled.');
    const member = await this.identities.member(identity.userId, client.companyId);
    if (!member) throw new ProblemException(403, 'sso-not-member', 'This account has no access to this app.');
    if (this.fresh(details, session.authTime)) throw new ProblemException(409, 'sso-fresh-login-required', 'The app asks for a new sign-in.');

    const redirectTo = await this.provider().interactionResult(
      req,
      res,
      { login: { accountId: identity.userId, ts: Math.floor(session.authTime.getTime() / 1000), amr: session.amr, remember: false } },
      { mergeWithLastSubmission: false },
    );
    if (!redirectTo.startsWith(`${this.runtime.issuer}/auth/`)) {
      this.logger.error({ uid }, 'interaction return URL outside the issuer');
      throw notFound();
    }
    const ua = req.headers['user-agent'];
    await this.audit.recordFor(
      { companyId: client.companyId, actorUserId: identity.userId },
      {
        type: 'sso.sign_in',
        subject: { type: 'user', id: identity.userId },
        data: { clientId: client.clientId, clientName: client.name, amr: session.amr, ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null },
      },
    );
    return { redirectTo };
  }

  async abort(req: Request, res: Response, uid: string): Promise<SsoRedirectView> {
    await this.interaction(req, res, uid);
    const redirectTo = await this.provider().interactionResult(
      req,
      res,
      { error: 'access_denied', error_description: 'The user cancelled the sign-in.' },
      { mergeWithLastSubmission: false },
    );
    return { redirectTo };
  }
}
