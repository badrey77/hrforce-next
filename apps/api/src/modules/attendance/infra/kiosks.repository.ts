import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';

export interface DeviceRow {
  id: string;
  kind: 'qr_kiosk';
  siteId: string;
  siteCode: string;
  siteName: string;
  nameFr: string;
  nameAr: string;
  status: 'pending' | 'active' | 'revoked';
  credentialHash: Buffer | null;
  pairedAt: Date | null;
  pairingExpiresAt: Date | null;
  allowedNetworks: string[];
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
  lastSeenAt: Date | null;
  lastIp: string | null;
  lastUserAgent: string | null;
}

const DEVICE_COLUMNS = sql`
  d.id, d.kind, d.site_id as "siteId", s.code as "siteCode", s.name as "siteName", d.name_fr as "nameFr", d.name_ar as "nameAr",
  d.status, d.credential_hash as "credentialHash", d.paired_at as "pairedAt", d.pairing_expires_at as "pairingExpiresAt",
  d.allowed_networks::text[] as "allowedNetworks", d.created_by as "createdBy", d.created_at as "createdAt",
  d.revoked_at as "revokedAt", d.revoked_by as "revokedBy", d.revoke_reason as "revokeReason",
  h.last_seen_at as "lastSeenAt", host(h.last_ip) as "lastIp", h.last_user_agent as "lastUserAgent"`;

/**
 * Entrance kiosks (attendance_device) and their heartbeat — through the CURRENT transaction (a request's, or the
 * kiosk routes' own transaction bound to the company of the kiosk cookie), always filtered by company too.
 */
@Injectable()
export class KiosksRepository {
  async list(companyId: string): Promise<DeviceRow[]> {
    const { rows } = await sql<DeviceRow>`
      select ${DEVICE_COLUMNS}
        from attendance_device d
        join site s on s.company_id = d.company_id and s.id = d.site_id
        left join attendance_device_heartbeat h on h.company_id = d.company_id and h.device_id = d.id
       where d.company_id = ${companyId}::uuid
       order by d.created_at desc, d.id desc`.execute(currentTx());
    return rows;
  }

  async find(companyId: string, id: string, { lock = false } = {}): Promise<DeviceRow | undefined> {
    const { rows } = await sql<DeviceRow>`
      select ${DEVICE_COLUMNS}
        from attendance_device d
        join site s on s.company_id = d.company_id and s.id = d.site_id
        left join attendance_device_heartbeat h on h.company_id = d.company_id and h.device_id = d.id
       where d.company_id = ${companyId}::uuid and d.id = ${id}::uuid
       ${lock ? sql`for update of d` : sql``}`.execute(currentTx());
    return rows[0];
  }

  async insert(
    companyId: string,
    input: { siteId: string; nameFr: string; nameAr: string; allowedNetworks: string[]; createdBy: string | null; pairingHash: Buffer; pairingExpiresAt: Date },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into attendance_device (company_id, site_id, name_fr, name_ar, allowed_networks, created_by, pairing_code_hash, pairing_expires_at)
      values (${companyId}::uuid, ${input.siteId}::uuid, ${input.nameFr}, ${input.nameAr}, ${input.allowedNetworks}::cidr[],
              ${input.createdBy}::uuid, ${input.pairingHash}, ${input.pairingExpiresAt})
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('attendance_device insert returned no id');
    return id;
  }

  async update(companyId: string, id: string, patch: { siteId?: string; nameFr?: string; nameAr?: string; allowedNetworks?: string[] }): Promise<void> {
    const sets = [
      ...(patch.siteId !== undefined ? [sql`site_id = ${patch.siteId}::uuid`] : []),
      ...(patch.nameFr !== undefined ? [sql`name_fr = ${patch.nameFr}`] : []),
      ...(patch.nameAr !== undefined ? [sql`name_ar = ${patch.nameAr}`] : []),
      ...(patch.allowedNetworks !== undefined ? [sql`allowed_networks = ${patch.allowedNetworks}::cidr[]`] : []),
    ];
    if (sets.length === 0) return;
    await sql`update attendance_device set ${sql.join(sets)} where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async setPairingCode(companyId: string, id: string, hash: Buffer, expiresAt: Date): Promise<void> {
    await sql`update attendance_device set pairing_code_hash = ${hash}, pairing_expires_at = ${expiresAt}
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** The pairing: a new credential, the code consumed (a previous credential of the device stops working). */
  async pair(companyId: string, id: string, credentialHash: Buffer): Promise<void> {
    await sql`update attendance_device
                 set credential_hash = ${credentialHash}, status = 'active', paired_at = now(),
                     pairing_code_hash = null, pairing_expires_at = null
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async revoke(companyId: string, id: string, by: string, reason: string): Promise<void> {
    await sql`update attendance_device
                 set status = 'revoked', credential_hash = null, pairing_code_hash = null, pairing_expires_at = null,
                     revoked_at = now(), revoked_by = ${by}::uuid, revoke_reason = ${reason}
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** Global lookup by pairing-code hash (SECURITY DEFINER function: the company is not known yet). */
  async pairingLookup(codeHash: Buffer): Promise<{ companyId: string; deviceId: string } | undefined> {
    const { rows } = await sql<{ companyId: string; deviceId: string }>`
      select company_id as "companyId", device_id as "deviceId" from public.attendance_pairing_lookup(${codeHash})`.execute(currentTx());
    return rows[0];
  }

  /** Upsert of the heartbeat, at most once a minute. */
  async heartbeat(companyId: string, deviceId: string, ip: string | null, userAgent: string | null): Promise<void> {
    await sql`
      insert into attendance_device_heartbeat (device_id, company_id, last_seen_at, last_ip, last_user_agent)
      values (${deviceId}::uuid, ${companyId}::uuid, now(), ${ip}::inet, ${userAgent})
      on conflict (device_id) do update
         set last_seen_at = excluded.last_seen_at, last_ip = excluded.last_ip, last_user_agent = excluded.last_user_agent
       where attendance_device_heartbeat.last_seen_at < now() - interval '60 seconds'`.execute(currentTx());
  }

  async companyName(companyId: string): Promise<string> {
    const row = await currentTx().selectFrom('company').select('name').where('id', '=', companyId).executeTakeFirst();
    return row?.name ?? '';
  }

  async siteExists(companyId: string, siteId: string): Promise<boolean> {
    const row = await currentTx().selectFrom('site').select('id').where('company_id', '=', companyId).where('id', '=', siteId).executeTakeFirst();
    return row !== undefined;
  }
}
