import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { readImageHeader } from '../../../platform/pdf/image-header.js';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * The installation row for this company ONLY WHEN NONE EXISTS (docs/contracts/branding.md › Owning company): the
 * first company created by bootstrap / seed:dev owns the installation default. Runs as the migrator (the app role
 * cannot insert into installation_branding).
 */
export async function seedBrandingDefaults(db: Executor, companyId: string): Promise<void> {
  await sql`
    insert into installation_branding (company_id)
    select ${companyId}::uuid where not exists (select 1 from installation_branding)
    on conflict do nothing`.execute(db);
}

/** The demo texts (docs/contracts/branding.md › Seed). */
export const DEMO_BRANDING = {
  footer: {
    fr: 'Groupe Démo — assistance : support@demo.dz',
    ar: 'مجموعة ديمو — الدعم: support@demo.dz',
    en: 'Groupe Démo — support: support@demo.dz',
  },
  signInMessage: {
    fr: 'Environnement de démonstration : données fictives.',
    ar: 'بيئة تجريبية: بيانات غير حقيقية.',
    en: 'Demonstration environment: fictitious data.',
  },
  welcomeMessage: {
    fr: 'Retrouvez ici vos tâches, vos congés et votre pointage.',
    ar: 'تجدون هنا المهام والعطل وتسجيل الحضور.',
    en: 'Your tasks, leave and attendance in one place.',
  },
} as const;

/**
 * seed:dev: the demo company owns the installation default (when no other company does) with a sample footer and
 * sign-in message — title unset, colour blue, no app logo — and its own row with a sample welcome message and
 * `companyLogo` (the generated demo PNG of the letterhead, handed in by the script: this module imports no other).
 * Idempotent: an installation row that already has texts and an existing company row are left alone.
 */
export async function seedDemoBranding(db: Executor, companyId: string, companyLogo: Buffer): Promise<void> {
  await seedBrandingDefaults(db, companyId);
  const d = DEMO_BRANDING;
  await sql`
    update installation_branding
       set footer_fr = ${d.footer.fr}, footer_ar = ${d.footer.ar}, footer_en = ${d.footer.en},
           sign_in_message_fr = ${d.signInMessage.fr}, sign_in_message_ar = ${d.signInMessage.ar}, sign_in_message_en = ${d.signInMessage.en},
           updated_at = now()
     where company_id = ${companyId}::uuid and footer_fr is null and sign_in_message_fr is null`.execute(db);
  const header = readImageHeader(companyLogo);
  if (!header.ok) throw new Error('demo branding: the company logo is not a readable PNG or JPEG');
  await sql`
    insert into company_branding (company_id, welcome_message_fr, welcome_message_ar, welcome_message_en,
                                  company_logo, company_logo_mime, company_logo_sha256, company_logo_width, company_logo_height)
    values (${companyId}::uuid, ${d.welcomeMessage.fr}, ${d.welcomeMessage.ar}, ${d.welcomeMessage.en},
            ${companyLogo}, ${header.type}, ${createHash('sha256').update(companyLogo).digest()}, ${header.width}, ${header.height})
    on conflict (company_id) do nothing`.execute(db);
}

export interface OwnerMove {
  /** the previous owning company's code; null when there was no installation row */
  previous: string | null;
  current: string;
  changed: boolean;
}

/**
 * Operator action (CLI `branding:owner`, migrator role): creates the installation row for this company, or moves the
 * existing row to it — its content is kept. Unknown code → error.
 */
export async function moveBrandingOwner(db: Executor, companyCode: string): Promise<OwnerMove> {
  const { rows: companies } = await sql<{ id: string; code: string }>`select id, code from company where code = ${companyCode}`.execute(db);
  const company = companies[0];
  if (!company) throw new Error(`no company with code ${companyCode}`);
  const { rows: owners } = await sql<{ code: string }>`
    select c.code from installation_branding b join company c on c.id = b.company_id for update of b`.execute(db);
  const previous = owners[0]?.code ?? null;
  if (previous === null) {
    await sql`insert into installation_branding (company_id) values (${company.id}::uuid)`.execute(db);
  } else if (previous !== company.code) {
    await sql`update installation_branding set company_id = ${company.id}::uuid`.execute(db);
  }
  return { previous, current: company.code, changed: previous !== company.code };
}
