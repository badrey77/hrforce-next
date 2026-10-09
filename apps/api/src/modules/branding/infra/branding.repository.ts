import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import { DEFAULT_BRAND_COLOR, isBrandColor, type BrandColor, type CompanyLevel, type InstallationLevel, type Lang3, type LogoKind, type LogoMeta, type LogoMime } from '../domain/types.js';

type Row = Record<string, unknown>;

export interface StoredCompany extends CompanyLevel {
  updatedAt: Date;
}
export interface StoredInstallation extends InstallationLevel {
  updatedAt: Date;
}
export interface NewLogo {
  bytes: Buffer;
  mime: LogoMime;
  sha256: Buffer;
  width: number;
  height: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const lang3 = (row: Row, prefix: string): Lang3 => ({ fr: str(row[`${prefix}_fr`]), ar: str(row[`${prefix}_ar`]), en: str(row[`${prefix}_en`]) });

function logoMeta(row: Row, prefix: string): LogoMeta | null {
  const digest = row[`${prefix}_digest`];
  const mime = row[`${prefix}_mime`];
  if (typeof digest !== 'string' || (mime !== 'image/png' && mime !== 'image/jpeg')) return null;
  const size = row[`${prefix}_size`];
  return {
    digest,
    mime,
    width: Number(row[`${prefix}_width`]),
    height: Number(row[`${prefix}_height`]),
    ...(size === undefined || size === null ? {} : { sizeBytes: Number(size) }),
  };
}

const color = (v: unknown): BrandColor | null => (isBrandColor(v) ? v : null);

/** The logo columns WITHOUT the bytes; `withSize` adds octet_length (the admin view only). */
function logoColumns(prefix: 'app_logo' | 'company_logo', withSize: boolean): RawBuilder<unknown> {
  const p = sql.ref(prefix);
  const col = (suffix: string) => sql.ref(`${prefix}_${suffix}`);
  return sql`${col('mime')}, encode(${col('sha256')}, 'hex') as ${col('digest')}, ${col('width')}, ${col('height')}${withSize ? sql`, octet_length(${p}) as ${col('size')}` : sql``}`;
}

const COMPANY_TEXTS = sql`app_title_fr, app_title_ar, app_title_en, welcome_title_fr, welcome_title_ar, welcome_title_en,
  welcome_message_fr, welcome_message_ar, welcome_message_en, footer_fr, footer_ar, footer_en`;
const INSTALLATION_TEXTS = sql`app_title_fr, app_title_ar, app_title_en, sign_in_message_fr, sign_in_message_ar, sign_in_message_en,
  footer_fr, footer_ar, footer_en`;

function installationLevel(row: Row): InstallationLevel {
  return {
    appTitle: lang3(row, 'app_title'),
    signInMessage: lang3(row, 'sign_in_message'),
    footer: lang3(row, 'footer'),
    color: color(row['color']) ?? DEFAULT_BRAND_COLOR,
    appLogo: logoMeta(row, 'app_logo'),
  };
}

export interface CompanyTexts {
  appTitle: Lang3;
  welcomeTitle: Lang3;
  welcomeMessage: Lang3;
  footer: Lang3;
  color: BrandColor | null;
}
export interface InstallationTexts {
  appTitle: Lang3;
  signInMessage: Lang3;
  footer: Lang3;
  color: BrandColor;
}

/**
 * Branding rows (docs/contracts/branding.md › Data) — through the CURRENT transaction, always filtered by company
 * too (RLS is the backstop). Every write is conditional: a statement that would change nothing touches no row, so the
 * audit trigger writes nothing and `updated_at` / `updated_by` only move with a real change.
 * The installation level is read through the SECURITY DEFINER functions except for the owner's admin view.
 */
@Injectable()
export class BrandingRepository {
  // ── installation level, before a tenant is known ────────────────────────────────────────────────────────────────

  /** public.branding_installation_default(): no company id, no bytes, no user. */
  async installationDefault(): Promise<InstallationLevel | null> {
    const { rows } = await sql<Row>`
      select ${INSTALLATION_TEXTS}, color, app_logo_mime, encode(app_logo_sha256, 'hex') as app_logo_digest, app_logo_width, app_logo_height
        from public.branding_installation_default()`.execute(currentTx());
    return rows[0] ? installationLevel(rows[0]) : null;
  }

  /** public.branding_installation_logo(digest): the bytes only for the exact stored digest. */
  async installationLogo(sha256: Buffer): Promise<{ bytes: Buffer; mime: LogoMime } | undefined> {
    const { rows } = await sql<{ bytes: Buffer; mime: LogoMime }>`select bytes, mime from public.branding_installation_logo(${sha256})`.execute(currentTx());
    return rows[0];
  }

  // ── installation level, as the owning company (RLS: the row is visible to its owner only) ─────────────────────

  async isOwner(companyId: string): Promise<boolean> {
    const { rows } = await sql`select 1 from installation_branding where company_id = ${companyId}::uuid`.execute(currentTx());
    return rows.length > 0;
  }

  async installation(companyId: string): Promise<StoredInstallation | null> {
    const { rows } = await sql<Row>`
      select ${INSTALLATION_TEXTS}, color, ${logoColumns('app_logo', true)}, updated_at
        from installation_branding where company_id = ${companyId}::uuid`.execute(currentTx());
    const row = rows[0];
    return row ? { ...installationLevel(row), updatedAt: row['updated_at'] as Date } : null;
  }

  async saveInstallation(companyId: string, userId: string, v: InstallationTexts): Promise<void> {
    await sql`
      update installation_branding
         set app_title_fr = ${v.appTitle.fr}, app_title_ar = ${v.appTitle.ar}, app_title_en = ${v.appTitle.en},
             sign_in_message_fr = ${v.signInMessage.fr}, sign_in_message_ar = ${v.signInMessage.ar}, sign_in_message_en = ${v.signInMessage.en},
             footer_fr = ${v.footer.fr}, footer_ar = ${v.footer.ar}, footer_en = ${v.footer.en},
             color = ${v.color}, updated_at = now(), updated_by = ${userId}::uuid
       where company_id = ${companyId}::uuid
         and (app_title_fr, app_title_ar, app_title_en, sign_in_message_fr, sign_in_message_ar, sign_in_message_en, footer_fr, footer_ar, footer_en, color)
             is distinct from
             (${v.appTitle.fr}::text, ${v.appTitle.ar}::text, ${v.appTitle.en}::text, ${v.signInMessage.fr}::text, ${v.signInMessage.ar}::text,
              ${v.signInMessage.en}::text, ${v.footer.fr}::text, ${v.footer.ar}::text, ${v.footer.en}::text, ${v.color}::text)`.execute(currentTx());
  }

  /** Texts and logo → null, colour → blue; the row and its owner stay. */
  async resetInstallation(companyId: string, userId: string): Promise<void> {
    await sql`
      update installation_branding
         set app_title_fr = null, app_title_ar = null, app_title_en = null,
             sign_in_message_fr = null, sign_in_message_ar = null, sign_in_message_en = null,
             footer_fr = null, footer_ar = null, footer_en = null, color = ${DEFAULT_BRAND_COLOR},
             app_logo = null, app_logo_mime = null, app_logo_sha256 = null, app_logo_width = null, app_logo_height = null,
             updated_at = now(), updated_by = ${userId}::uuid
       where company_id = ${companyId}::uuid
         and (num_nonnulls(app_title_fr, app_title_ar, app_title_en, sign_in_message_fr, sign_in_message_ar, sign_in_message_en,
                           footer_fr, footer_ar, footer_en, app_logo_sha256) > 0
              or color <> ${DEFAULT_BRAND_COLOR})`.execute(currentTx());
  }

  async setInstallationLogo(companyId: string, userId: string, logo: NewLogo | null): Promise<void> {
    await sql`
      update installation_branding
         set app_logo = ${logo?.bytes ?? null}, app_logo_mime = ${logo?.mime ?? null}, app_logo_sha256 = ${logo?.sha256 ?? null},
             app_logo_width = ${logo?.width ?? null}, app_logo_height = ${logo?.height ?? null},
             updated_at = now(), updated_by = ${userId}::uuid
       where company_id = ${companyId}::uuid and app_logo_sha256 is distinct from ${logo?.sha256 ?? null}::bytea`.execute(currentTx());
  }

  // ── company level ───────────────────────────────────────────────────────────────────────────────────────────────

  /** The company row; `withSize` false never touches the image columns (GET /api/me). */
  async company(companyId: string, { withSize = false } = {}): Promise<StoredCompany | null> {
    const { rows } = await sql<Row>`
      select ${COMPANY_TEXTS}, color, ${logoColumns('app_logo', withSize)}, ${logoColumns('company_logo', withSize)}, updated_at
        from company_branding where company_id = ${companyId}::uuid`.execute(currentTx());
    const row = rows[0];
    if (!row) return null;
    return {
      appTitle: lang3(row, 'app_title'),
      welcomeTitle: lang3(row, 'welcome_title'),
      welcomeMessage: lang3(row, 'welcome_message'),
      footer: lang3(row, 'footer'),
      color: color(row['color']),
      appLogo: logoMeta(row, 'app_logo'),
      companyLogo: logoMeta(row, 'company_logo'),
      updatedAt: row['updated_at'] as Date,
    };
  }

  /** Full replacement of the texts and the colour (upsert). Nothing to store and no row yet → no row is created. */
  async saveCompany(companyId: string, userId: string, v: CompanyTexts): Promise<void> {
    const values = [
      v.appTitle.fr, v.appTitle.ar, v.appTitle.en, v.welcomeTitle.fr, v.welcomeTitle.ar, v.welcomeTitle.en,
      v.welcomeMessage.fr, v.welcomeMessage.ar, v.welcomeMessage.en, v.footer.fr, v.footer.ar, v.footer.en, v.color,
    ];
    const list = sql.join(values.map((value) => sql`${value}::text`));
    const columns = sql`${COMPANY_TEXTS}, color`;
    const sets = sql`app_title_fr = n.app_title_fr, app_title_ar = n.app_title_ar, app_title_en = n.app_title_en,
             welcome_title_fr = n.welcome_title_fr, welcome_title_ar = n.welcome_title_ar, welcome_title_en = n.welcome_title_en,
             welcome_message_fr = n.welcome_message_fr, welcome_message_ar = n.welcome_message_ar, welcome_message_en = n.welcome_message_en,
             footer_fr = n.footer_fr, footer_ar = n.footer_ar, footer_en = n.footer_en, color = n.color`;
    const updated = await sql`
      with n (${columns}) as (values (${list}))
      update company_branding b
         set ${sets}, updated_at = now(), updated_by = ${userId}::uuid
        from n
       where b.company_id = ${companyId}::uuid
         and (b.app_title_fr, b.app_title_ar, b.app_title_en, b.welcome_title_fr, b.welcome_title_ar, b.welcome_title_en,
              b.welcome_message_fr, b.welcome_message_ar, b.welcome_message_en, b.footer_fr, b.footer_ar, b.footer_en, b.color)
             is distinct from
             (n.app_title_fr, n.app_title_ar, n.app_title_en, n.welcome_title_fr, n.welcome_title_ar, n.welcome_title_en,
              n.welcome_message_fr, n.welcome_message_ar, n.welcome_message_en, n.footer_fr, n.footer_ar, n.footer_en, n.color)`.execute(currentTx());
    if ((updated.numAffectedRows ?? 0n) > 0n || values.every((value) => value === null)) return;
    await sql`
      insert into company_branding (company_id, ${columns}, updated_by)
      values (${companyId}::uuid, ${list}, ${userId}::uuid)
      on conflict (company_id) do nothing`.execute(currentTx());
  }

  /** Every text, the colour and both logos → null (the row stays: the app role has no DELETE). */
  async resetCompany(companyId: string, userId: string): Promise<void> {
    await sql`
      update company_branding
         set app_title_fr = null, app_title_ar = null, app_title_en = null,
             welcome_title_fr = null, welcome_title_ar = null, welcome_title_en = null,
             welcome_message_fr = null, welcome_message_ar = null, welcome_message_en = null,
             footer_fr = null, footer_ar = null, footer_en = null, color = null,
             app_logo = null, app_logo_mime = null, app_logo_sha256 = null, app_logo_width = null, app_logo_height = null,
             company_logo = null, company_logo_mime = null, company_logo_sha256 = null, company_logo_width = null, company_logo_height = null,
             updated_at = now(), updated_by = ${userId}::uuid
       where company_id = ${companyId}::uuid
         and num_nonnulls(app_title_fr, app_title_ar, app_title_en, welcome_title_fr, welcome_title_ar, welcome_title_en,
                          welcome_message_fr, welcome_message_ar, welcome_message_en, footer_fr, footer_ar, footer_en, color,
                          app_logo_sha256, company_logo_sha256) > 0`.execute(currentTx());
  }

  /** Sets (or with null removes) one logo; creates the row when there is none yet. Same image → nothing changes. */
  async setCompanyLogo(companyId: string, userId: string, kind: LogoKind, logo: NewLogo | null): Promise<void> {
    const prefix = kind === 'app' ? 'app_logo' : 'company_logo';
    const col = (suffix?: string) => sql.ref(suffix ? `${prefix}_${suffix}` : prefix);
    const updated = await sql`
      update company_branding
         set ${col()} = ${logo?.bytes ?? null}, ${col('mime')} = ${logo?.mime ?? null}, ${col('sha256')} = ${logo?.sha256 ?? null},
             ${col('width')} = ${logo?.width ?? null}, ${col('height')} = ${logo?.height ?? null},
             updated_at = now(), updated_by = ${userId}::uuid
       where company_id = ${companyId}::uuid and ${col('sha256')} is distinct from ${logo?.sha256 ?? null}::bytea`.execute(currentTx());
    if ((updated.numAffectedRows ?? 0n) > 0n || !logo) return;
    await sql`
      insert into company_branding (company_id, ${col()}, ${col('mime')}, ${col('sha256')}, ${col('width')}, ${col('height')}, updated_by)
      values (${companyId}::uuid, ${logo.bytes}, ${logo.mime}, ${logo.sha256}, ${logo.width}, ${logo.height}, ${userId}::uuid)
      on conflict (company_id) do nothing`.execute(currentTx());
  }

  /** One logo of the company with its bytes, only for the exact stored digest. */
  async companyLogo(companyId: string, kind: LogoKind, sha256: Buffer): Promise<{ bytes: Buffer; mime: LogoMime } | undefined> {
    const prefix = kind === 'app' ? 'app_logo' : 'company_logo';
    const { rows } = await sql<{ bytes: Buffer; mime: LogoMime }>`
      select ${sql.ref(prefix)} as bytes, ${sql.ref(`${prefix}_mime`)} as mime
        from company_branding
       where company_id = ${companyId}::uuid and ${sql.ref(`${prefix}_sha256`)} = ${sha256}`.execute(currentTx());
    return rows[0];
  }
}
