import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Account } from 'oidc-provider';
import { runInRequestTransaction } from '../../../platform/context/request-transaction.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { IdentitySessions } from '../../identity/index.js';
import { StaffingService, type EmployeeClaim } from '../../staffing/index.js';
import { algiersDate } from '../domain/rules.js';
import { SsoRepository } from '../infra/sso.repository.js';
import { SsoClock } from './sso-clock.js';

/** The claims of docs/contracts/sso.md › Claims (filtered by scope by the provider). */
export interface HrforceClaims {
  [key: string]: unknown;
  sub: string;
  name: string;
  preferred_username: string;
  locale: 'fr' | 'ar' | 'en';
  email: string;
  email_verified: true;
  company: { id: string; code: string; name: string };
  employee: EmployeeClaim | null;
  roles: string[];
}

/**
 * `findAccount` of the provider: the account exists for a client only when the user is an ACTIVE member of the
 * client's company (auth.me); its claims are computed in one transaction bound to that company (RLS), whatever
 * company the HRForce session uses. `roles` are the user's roles in THAT client only (`[]` when none) — the only
 * authorization claim; company, employee and unit are display data.
 */
@Injectable()
export class ClaimsBuilder {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly identity: IdentitySessions,
    private readonly staffing: StaffingService,
    private readonly repo: SsoRepository,
    private readonly clock: SsoClock,
  ) {}

  async account(companyId: unknown, clientId: string, sub: string): Promise<Account | undefined> {
    if (typeof companyId !== 'string') return undefined;
    const member = await this.identity.member(sub, companyId);
    if (!member) return undefined;
    return { accountId: sub, claims: async () => (await this.claims(companyId, clientId, sub)) ?? { sub } };
  }

  claims(companyId: string, clientId: string, sub: string): Promise<HrforceClaims | null> {
    return runInRequestTransaction(this.db, { companyId, userId: sub, requestId: randomUUID() }, async () => {
      const me = await this.identity.member(sub, companyId);
      if (!me) return null;
      const [employee, roles] = await Promise.all([
        this.staffing.employeeClaim(sub, algiersDate(this.clock.nowMs())),
        this.repo.roleCodesOf(companyId, clientId, sub),
      ]);
      return {
        sub,
        name: me.displayName,
        preferred_username: me.email,
        locale: me.locale,
        email: me.email,
        email_verified: true,
        company: { id: me.company.id, code: me.company.code, name: me.company.name },
        employee,
        roles,
      };
    });
  }
}
