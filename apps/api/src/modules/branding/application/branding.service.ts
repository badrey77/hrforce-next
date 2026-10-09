import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { toFieldErrors } from '../../../platform/http/zod-validation.pipe.js';
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, readImageHeader, withinImageLimits } from '../../../platform/pdf/image-header.js';
import { inheritedLevel, logoRef, resolveBranding, type LogoSource } from '../domain/inheritance.js';
import { validateBrandColor, validateBrandingTexts } from '../domain/text.js';
import {
  BRAND_COLORS,
  BRANDING_LIMITS,
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_PERMISSION,
  DEFAULT_BRAND_COLOR,
  DIGEST_PATTERN,
  EMPTY_LANG3,
  isLogoKind,
  type EffectiveBranding,
  type LogoKind,
  type LogoMeta,
} from '../domain/types.js';
import { BrandingRepository, type NewLogo } from '../infra/branding.repository.js';
import type { BrandingSettingsView, LogoFile, LogoView, PublicBranding } from './branding-views.js';

/** The raw text of one language: bounded before cleaning so a huge body is refused cheaply (the real limits come after). */
const rawText = z.string().max(4000).nullable();
const lang3 = z.strictObject({ fr: rawText, ar: rawText, en: rawText });
const companyBody = z.strictObject({ appTitle: lang3, welcomeTitle: lang3, welcomeMessage: lang3, footer: lang3, color: z.string().max(40).nullable() });
const installationBody = z.strictObject({ appTitle: lang3, signInMessage: lang3, footer: lang3, color: z.string().max(40) });

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ValidationProblemException(toFieldErrors(result.error.issues));
  return result.data;
}

/** What the upload interceptor hands over: the file, or the fact that it went over the size limit. */
export interface UploadedLogo {
  file: { buffer: Buffer } | undefined;
  tooLarge: boolean;
}

const fileError = (code: string, message: string): ValidationProblemException => new ValidationProblemException([{ field: 'file', code, message }]);

function logoView(source: LogoSource, logo: LogoMeta | null): LogoView | null {
  const ref = logoRef(source, logo);
  return ref && logo ? { ...ref, mime: logo.mime, sizeBytes: logo.sizeBytes ?? 0 } : null;
}

/**
 * Branding settings (docs/contracts/branding.md › API): the installation default shown before sign-in, each
 * company's own values, and the inheritance between them.
 *
 * Writes — order of the checks: the permission held anywhere (the route guard, 403) → held over the WHOLE company
 * (403 forbidden-scope) → for the installation routes, the caller's company owns the installation row (404: a
 * non-owner learns nothing about who does) → validation (422). Bodies are therefore parsed HERE, not by the global
 * pipe, which would answer 422 before the scope check. Every change is audited by the row triggers; a write that
 * changes nothing touches no row.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly repo: BrandingRepository,
    private readonly scopes: ScopeService,
  ) {}

  private caller(): { companyId: string; userId: string } {
    const { companyId, userId } = requireContext();
    if (!companyId || !userId) throw new NotFoundException();
    return { companyId, userId };
  }

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(BRANDING_PERMISSION))) {
      throw new ProblemException(403, 'forbidden-scope', 'Branding applies to the whole company: settings.branding over the root unit is needed.');
    }
  }

  /** Company-wide, then owner (404 otherwise). */
  private async assertOwner(companyId: string): Promise<void> {
    await this.assertCompanyWide();
    if (!(await this.repo.isOwner(companyId))) throw new NotFoundException();
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The installation default, raw: the same answer for every caller, nothing about any company. */
  async publicDefault(): Promise<PublicBranding> {
    const level = await this.repo.installationDefault();
    return {
      appTitle: level?.appTitle ?? { ...EMPTY_LANG3 },
      signInMessage: level?.signInMessage ?? { ...EMPTY_LANG3 },
      footer: level?.footer ?? { ...EMPTY_LANG3 },
      color: level?.color ?? DEFAULT_BRAND_COLOR,
      appLogo: logoRef('default', level?.appLogo),
    };
  }

  async defaultLogo(digest: string): Promise<LogoFile> {
    if (!DIGEST_PATTERN.test(digest)) throw new NotFoundException();
    const logo = await this.repo.installationLogo(Buffer.from(digest, 'hex'));
    if (!logo) throw new NotFoundException();
    return { ...logo, digest };
  }

  /** A logo of the CALLER's company, for its current digest only (another company's digest: 404). */
  async companyLogo(kind: string, digest: string): Promise<LogoFile> {
    const { companyId } = requireContext();
    if (!companyId || !isLogoKind(kind) || !DIGEST_PATTERN.test(digest)) throw new NotFoundException();
    const logo = await this.repo.companyLogo(companyId, kind, Buffer.from(digest, 'hex'));
    if (!logo) throw new NotFoundException();
    return { ...logo, digest };
  }

  /** GET /api/me → `branding`: the caller's company after inheritance. Never reads image bytes. */
  async effective(): Promise<EffectiveBranding> {
    const { companyId } = requireContext();
    const [company, installation] = await Promise.all([companyId ? this.repo.company(companyId) : null, this.repo.installationDefault()]);
    return resolveBranding(company, installation);
  }

  async settings(): Promise<BrandingSettingsView> {
    const { companyId } = this.caller();
    const company = await this.repo.company(companyId, { withSize: true });
    const installation = await this.repo.installation(companyId);
    const inherited = inheritedLevel(await this.repo.installationDefault());
    return {
      company: {
        appTitle: company?.appTitle ?? { ...EMPTY_LANG3 },
        welcomeTitle: company?.welcomeTitle ?? { ...EMPTY_LANG3 },
        welcomeMessage: company?.welcomeMessage ?? { ...EMPTY_LANG3 },
        footer: company?.footer ?? { ...EMPTY_LANG3 },
        color: company?.color ?? null,
        appLogo: logoView('app', company?.appLogo ?? null),
        companyLogo: logoView('company', company?.companyLogo ?? null),
        updatedAt: company ? company.updatedAt.toISOString() : null,
      },
      installation: installation
        ? {
            appTitle: installation.appTitle,
            signInMessage: installation.signInMessage,
            footer: installation.footer,
            color: installation.color,
            appLogo: logoView('default', installation.appLogo),
            updatedAt: installation.updatedAt.toISOString(),
          }
        : null,
      inherited,
      palette: [...BRAND_COLORS],
      limits: BRANDING_LIMITS,
    };
  }

  // ── company writes ──────────────────────────────────────────────────────────────────────────────────────────────

  async saveCompany(body: unknown): Promise<BrandingSettingsView> {
    const { companyId, userId } = this.caller();
    await this.assertCompanyWide();
    const input = parse(companyBody, body);
    const { values, errors } = validateBrandingTexts({ appTitle: input.appTitle, welcomeTitle: input.welcomeTitle, welcomeMessage: input.welcomeMessage, footer: input.footer });
    const color = validateBrandColor(input.color, true);
    const all: FieldError[] = [...errors, ...(color.error ? [color.error] : [])];
    if (all.length) throw new ValidationProblemException(all);
    await this.repo.saveCompany(companyId, userId, { ...values, color: color.color });
    return this.settings();
  }

  async resetCompany(): Promise<void> {
    const { companyId, userId } = this.caller();
    await this.assertCompanyWide();
    await this.repo.resetCompany(companyId, userId);
  }

  async setCompanyLogo(kind: string, upload: UploadedLogo): Promise<BrandingSettingsView> {
    const { companyId, userId } = this.caller();
    await this.assertCompanyWide();
    await this.repo.setCompanyLogo(companyId, userId, this.kind(kind), this.readLogo(upload));
    return this.settings();
  }

  async deleteCompanyLogo(kind: string): Promise<void> {
    const { companyId, userId } = this.caller();
    await this.assertCompanyWide();
    await this.repo.setCompanyLogo(companyId, userId, this.kind(kind), null);
  }

  // ── installation writes (the owning company only) ───────────────────────────────────────────────────────────────

  async saveInstallation(body: unknown): Promise<BrandingSettingsView> {
    const { companyId, userId } = this.caller();
    await this.assertOwner(companyId);
    const input = parse(installationBody, body);
    const { values, errors } = validateBrandingTexts({ appTitle: input.appTitle, signInMessage: input.signInMessage, footer: input.footer });
    const color = validateBrandColor(input.color, false);
    const all: FieldError[] = [...errors, ...(color.error ? [color.error] : [])];
    if (all.length) throw new ValidationProblemException(all);
    await this.repo.saveInstallation(companyId, userId, { ...values, color: color.color ?? DEFAULT_BRAND_COLOR });
    return this.settings();
  }

  async resetInstallation(): Promise<void> {
    const { companyId, userId } = this.caller();
    await this.assertOwner(companyId);
    await this.repo.resetInstallation(companyId, userId);
  }

  async setInstallationLogo(upload: UploadedLogo): Promise<BrandingSettingsView> {
    const { companyId, userId } = this.caller();
    await this.assertOwner(companyId);
    await this.repo.setInstallationLogo(companyId, userId, this.readLogo(upload));
    return this.settings();
  }

  async deleteInstallationLogo(): Promise<void> {
    const { companyId, userId } = this.caller();
    await this.assertOwner(companyId);
    await this.repo.setInstallationLogo(companyId, userId, null);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private kind(kind: string): LogoKind {
    if (!isLogoKind(kind)) throw new NotFoundException();
    return kind;
  }

  /**
   * PNG or JPEG only, by the first bytes; the pixel size from the header, never decoded (platform/pdf/image-header.ts).
   * The declared Content-Type and the file name are ignored. SVG, HTML, GIF, WebP, ICO and a truncated image are all
   * `unsupported_type`. Stored as uploaded (no re-encoding).
   */
  private readLogo({ file, tooLarge }: UploadedLogo): NewLogo {
    if (tooLarge) throw fileError('too_large', 'At most 256 KB.');
    if (!file || file.buffer.length === 0) throw fileError('required', 'A PNG or JPEG file is required.');
    if (file.buffer.length > BRANDING_LOGO_MAX_BYTES) throw fileError('too_large', 'At most 256 KB.');
    const header = readImageHeader(file.buffer);
    if (!header.ok) throw fileError('unsupported_type', 'PNG or JPEG only (a readable header is needed).');
    if (!withinImageLimits(header)) {
      throw fileError('dimensions_too_large', `At most ${IMAGE_MAX_SIDE} × ${IMAGE_MAX_SIDE} px and ${IMAGE_MAX_PIXELS / 1_000_000} megapixels.`);
    }
    return { bytes: file.buffer, mime: header.type, sha256: createHash('sha256').update(file.buffer).digest(), width: header.width, height: header.height };
  }
}
