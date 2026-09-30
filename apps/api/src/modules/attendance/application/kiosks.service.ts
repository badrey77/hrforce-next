import { randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { formatNetwork, MAX_ALLOWED_NETWORKS, parseNetwork } from '../domain/networks.js';
import { formatPairingCode, pairingCodeFrom, pairingCodeHash, PAIRING_TTL_MS } from '../domain/pairing.js';
import { AttendanceRepository } from '../infra/attendance.repository.js';
import { KiosksRepository, type DeviceRow } from '../infra/kiosks.repository.js';
import { AttendanceClock } from './attendance-clock.js';
import type { KioskView, PairingCodeView } from './attendance-views.js';
import { ATTENDANCE_PERMISSIONS as P, caller } from './presence.service.js';

export interface KioskInput {
  siteId?: string | undefined;
  labels?: { fr: string; ar: string } | undefined;
  allowedNetworks?: string[] | undefined;
}

const revoked = () => new ProblemException(409, 'kiosk-revoked', 'This kiosk is revoked (final): create a new one.');

/**
 * Kiosk management (docs/contracts/attendance.md › Endpoints /attendance/kiosks*, ADR 009 §1): create (with a first
 * one-time pairing code), edit, a new code, revoke. Reads need attendance.configure anywhere; writes over the whole
 * company. The pairing code appears once, in the response that creates it; only its SHA-256 is stored.
 */
@Injectable()
export class KiosksService {
  constructor(
    private readonly repo: KiosksRepository,
    private readonly people: AttendanceRepository,
    private readonly scopes: ScopeService,
    private readonly clock: AttendanceClock,
  ) {}

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Kiosks are managed for the whole company: attendance.configure over the root unit is needed.');
    }
  }

  private async view(device: DeviceRow, members?: ReadonlyMap<string, string>, canWrite?: boolean): Promise<KioskView> {
    const { companyId } = caller();
    const names = members ?? (await this.people.members(companyId));
    const write = canWrite ?? (await this.scopes.coversCompany(P.configure));
    const user = (id: string | null) => (id ? { id, displayName: names.get(id) ?? id } : null);
    const now = this.clock.nowMs();
    return {
      id: device.id,
      kind: device.kind,
      labels: { fr: device.nameFr, ar: device.nameAr },
      site: { id: device.siteId, code: device.siteCode, name: device.siteName },
      status: device.status,
      allowedNetworks: device.allowedNetworks,
      pairedAt: device.pairedAt?.toISOString() ?? null,
      pairing: device.pairingExpiresAt && device.pairingExpiresAt.getTime() > now ? { expiresAt: device.pairingExpiresAt.toISOString() } : null,
      lastSeen: device.lastSeenAt ? { at: device.lastSeenAt.toISOString(), ip: device.lastIp ?? '', userAgent: device.lastUserAgent ?? '' } : null,
      createdAt: device.createdAt.toISOString(),
      createdBy: user(device.createdBy),
      revoked: device.status === 'revoked' && device.revokedAt ? { at: device.revokedAt.toISOString(), by: user(device.revokedBy), reason: device.revokeReason ?? '' } : null,
      _actions: write && device.status !== 'revoked' ? ['update', 'pair', 'revoke'] : [],
    };
  }

  private async deviceOr404(id: string): Promise<DeviceRow> {
    const { companyId } = caller();
    const device = await this.repo.find(companyId, id);
    if (!device) throw new NotFoundException('Kiosk not found');
    return device;
  }

  private networksOrThrow(list: readonly string[]): string[] {
    const errors = list.flatMap((text, i) =>
      parseNetwork(text) ? [] : [{ field: `allowedNetworks.${i}`, code: 'invalid', message: 'An IPv4 / IPv6 address or CIDR block with its host bits at zero.' }],
    );
    if (list.length > MAX_ALLOWED_NETWORKS) errors.push({ field: 'allowedNetworks', code: 'too_many', message: `At most ${MAX_ALLOWED_NETWORKS}.` });
    if (errors.length > 0) throw new ValidationProblemException(errors);
    return [...new Set(list.map((text) => formatNetwork(parseNetwork(text) as NonNullable<ReturnType<typeof parseNetwork>>)))];
  }

  private newCode(): { view: PairingCodeView; hash: Buffer; expiresAt: Date } {
    const code = pairingCodeFrom(randomBytes(5));
    const expiresAt = new Date(this.clock.nowMs() + PAIRING_TTL_MS);
    return { view: { code: formatPairingCode(code), expiresAt: expiresAt.toISOString() }, hash: pairingCodeHash(code), expiresAt };
  }

  async list(): Promise<{ items: KioskView[] }> {
    const { companyId } = caller();
    const [devices, members, canWrite] = await Promise.all([this.repo.list(companyId), this.people.members(companyId), this.scopes.coversCompany(P.configure)]);
    return { items: await Promise.all(devices.map((d) => this.view(d, members, canWrite))) };
  }

  async create(input: Required<Pick<KioskInput, 'siteId' | 'labels'>> & KioskInput): Promise<{ kiosk: KioskView; pairing: PairingCodeView }> {
    const { companyId, userId } = caller();
    await this.assertCompanyWide();
    const networks = this.networksOrThrow(input.allowedNetworks ?? []);
    if (!(await this.repo.siteExists(companyId, input.siteId))) {
      throw new ValidationProblemException([{ field: 'siteId', code: 'not_found', message: 'Unknown site.' }]);
    }
    const code = this.newCode();
    const id = await this.repo.insert(companyId, {
      siteId: input.siteId,
      nameFr: input.labels.fr,
      nameAr: input.labels.ar,
      allowedNetworks: networks,
      createdBy: userId,
      pairingHash: code.hash,
      pairingExpiresAt: code.expiresAt,
    });
    return { kiosk: await this.view(await this.deviceOr404(id)), pairing: code.view };
  }

  async update(id: string, input: KioskInput): Promise<KioskView> {
    const { companyId } = caller();
    const device = await this.deviceOr404(id);
    await this.assertCompanyWide();
    if (device.status === 'revoked') throw revoked();
    const networks = input.allowedNetworks === undefined ? undefined : this.networksOrThrow(input.allowedNetworks);
    if (input.siteId !== undefined && !(await this.repo.siteExists(companyId, input.siteId))) {
      throw new ValidationProblemException([{ field: 'siteId', code: 'not_found', message: 'Unknown site.' }]);
    }
    await this.repo.update(companyId, id, {
      ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
      ...(input.labels ? { nameFr: input.labels.fr, nameAr: input.labels.ar } : {}),
      ...(networks !== undefined ? { allowedNetworks: networks } : {}),
    });
    return this.view(await this.deviceOr404(id));
  }

  /** A new one-time code (replaces an unused one); the paired tablet keeps working until the new code is used. */
  async pairingCode(id: string): Promise<PairingCodeView> {
    const { companyId } = caller();
    const device = await this.deviceOr404(id);
    await this.assertCompanyWide();
    if (device.status === 'revoked') throw revoked();
    const code = this.newCode();
    await this.repo.setPairingCode(companyId, id, code.hash, code.expiresAt);
    return code.view;
  }

  async revoke(id: string, reason: string): Promise<KioskView> {
    const { companyId, userId } = caller();
    const device = await this.deviceOr404(id);
    await this.assertCompanyWide();
    if (device.status === 'revoked') throw revoked();
    await this.repo.revoke(companyId, id, userId, reason);
    return this.view(await this.deviceOr404(id));
  }
}
