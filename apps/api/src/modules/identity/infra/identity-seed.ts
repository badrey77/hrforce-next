import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { isLocale, normalizeEmail, SETUP_TOKEN_TTL_HOURS, type Locale } from '../domain/account.js';
import { PasswordHasher } from './password-hasher.js';
import { newOpaqueToken, sha256 } from './secure-token.js';

/*
 * Account provisioning for the CLI (`user:invite`) and `seed:dev`. These run as the MIGRATOR (owner of schema auth),
 * the only role allowed to write the auth tables directly; the API itself never creates users.
 */

type Executor = Kysely<DB> | Transaction<DB>;

/** Development password of the seeded demo users (printed by seed:dev; refused in production). */
export const DEMO_PASSWORD = 'demo-password-2026';

export interface DemoUser {
  id: string;
  email: string;
  displayName: string;
  locale: Locale;
}

/**
 * Fixed ids (docs/contracts/identity.md › CLI and seed; apps/api/README.md). rh.admin reuses the historical dev user
 * id …0000000000aa, so the DEV_AUTH header identity and the real login are the same person.
 */
export const DEMO_USERS: readonly DemoUser[] = [
  { id: '0190a5d0-0000-7000-8000-0000000000aa', email: 'rh.admin@demo.dz', displayName: 'Amina Benali', locale: 'fr' },
  { id: '0190a5d0-0000-7000-8000-0000000000ab', email: 'rh.est@demo.dz', displayName: 'Karim Haddad', locale: 'ar' },
];

/**
 * Idempotently creates the demo users as ACTIVE members (default company) of `companyId` with {@link DEMO_PASSWORD}.
 * Existing rows (same id / e-mail, membership, credential) are left untouched.
 */
export async function seedIdentity(db: Executor, companyId: string, users: readonly DemoUser[] = DEMO_USERS): Promise<void> {
  const hasher = new PasswordHasher();
  for (const user of users) {
    await sql`
      insert into auth.user_account (id, email, display_name, locale, status)
      values (${user.id}::uuid, ${normalizeEmail(user.email)}, ${user.displayName}, ${user.locale}, 'active')
      on conflict do nothing`.execute(db);
    await sql`
      insert into auth.user_company (user_id, company_id, is_default)
      select ${user.id}::uuid, ${companyId}::uuid,
             not exists (select 1 from auth.user_company d where d.user_id = ${user.id}::uuid and d.is_default)
      on conflict do nothing`.execute(db);
    const { rows } = await sql<{ one: number }>`select 1 as one from auth.user_credential where user_id = ${user.id}::uuid`.execute(db);
    if (rows.length === 0) {
      const passwordHash = await hasher.hash(DEMO_PASSWORD);
      await sql`
        insert into auth.user_credential (user_id, password_hash) values (${user.id}::uuid, ${passwordHash})
        on conflict do nothing`.execute(db);
    }
  }
}

export interface InviteInput {
  email: string;
  displayName: string;
  companyCode: string;
  locale?: string;
}

export interface InviteResult {
  userId: string;
  email: string;
  displayName: string;
  locale: Locale;
  companyName: string;
  /** true when the account was created by this call */
  created: boolean;
  /** setup token to mail (null when the account is already active: only the membership was added) */
  setupToken: string | null;
}

/**
 * `user:invite`: creates an INVITED account (or reuses the one with that e-mail) + membership of the company, and a
 * single-use setup token valid {@link SETUP_TOKEN_TTL_HOURS} h. Re-inviting an invited account issues a new token;
 * an active account only gets the membership; a disabled account is refused. Must run inside a transaction.
 */
export async function inviteUser(db: Transaction<DB>, input: InviteInput): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) throw new Error(`invalid e-mail: ${input.email}`);
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 120) throw new Error('display name must be 1–120 characters');
  const locale = input.locale ?? 'fr';
  if (!isLocale(locale)) throw new Error(`locale must be fr, ar or en (got ${locale})`);

  const company = (
    await sql<{ id: string; name: string }>`select id, name from public.company where code = ${input.companyCode}`.execute(db)
  ).rows[0];
  if (!company) throw new Error(`unknown company code: ${input.companyCode}`);

  let created = false;
  let account = (
    await sql<{ id: string; status: string; display_name: string; locale: Locale }>`
      select id, status, display_name, locale from auth.user_account where email = ${email} for update`.execute(db)
  ).rows[0];
  if (!account) {
    account = (
      await sql<{ id: string; status: string; display_name: string; locale: Locale }>`
        insert into auth.user_account (email, display_name, locale, status)
        values (${email}, ${displayName}, ${locale}, 'invited')
        returning id, status, display_name, locale`.execute(db)
    ).rows[0];
    created = true;
  }
  if (!account) throw new Error('could not create the account');
  if (account.status === 'disabled') throw new Error(`account ${email} is disabled`);

  await sql`
    insert into auth.user_company (user_id, company_id, is_default)
    select ${account.id}::uuid, ${company.id}::uuid,
           not exists (select 1 from auth.user_company d where d.user_id = ${account.id}::uuid and d.is_default)
    on conflict do nothing`.execute(db);

  let setupToken: string | null = null;
  if (account.status === 'invited') {
    setupToken = newOpaqueToken();
    await sql`
      insert into auth.password_token (user_id, token_hash, purpose, expires_at)
      values (${account.id}::uuid, ${sha256(setupToken)}, 'setup', now() + make_interval(hours => ${SETUP_TOKEN_TTL_HOURS}))`.execute(db);
  }
  return {
    userId: account.id,
    email,
    displayName: account.display_name,
    locale: account.locale,
    companyName: company.name,
    created,
    setupToken,
  };
}
