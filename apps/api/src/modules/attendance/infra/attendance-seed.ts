/*
 * Attendance defaults of a company (bootstrap, seed:dev, e2e fixtures) and the DEMO attendance data (seed:dev) —
 * docs/contracts/attendance.md › Seed. TEST DATA. Runs as the MIGRATOR (owner, BYPASSRLS): company_id written
 * explicitly. Deterministic and idempotent: fixed ids, `on conflict do nothing` (re-running adds nothing for the days
 * already seeded; a later run adds the new days).
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { demoEmployees } from '../../employment/index.js';
import { DEMO_USERS } from '../../identity/index.js';
import { LEAVE_DEMO } from '../../leave/index.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { normalizePairingCode, pairingCodeHash } from '../domain/pairing.js';
import { addDays, algiersDate, algiersInstant, isoWeekday } from '../domain/time.js';
import { sha256, windowOf } from '../domain/tokens.js';
import { STANDARD_WEEK, type IsoDay, type Week } from '../domain/week.js';

type Executor = Kysely<DB> | Transaction<DB>;

const fixed = (kind: number, n: number) => `0190a5d0-0000-7000-9a7${kind}-${n.toString(16).padStart(12, '0')}`;
const DEMO = DEMO_ORGANIZATION.company.id;
const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
/** Fixed punch ids per (employee, date, n). */
const punchId = (n: number, date: string, k: number) => fixed(5, n * 0x1_0000_0000 + dayNumber(date) * 0x100 + k);

function user(email: string): string {
  const found = DEMO_USERS.find((u) => u.email === email);
  if (!found) throw new Error(`attendance seed: unknown user ${email}`);
  return found.id;
}

function siteId(code: string): string {
  const site = DEMO_ORGANIZATION.sites.find((s) => s.code === code);
  if (!site) throw new Error(`attendance seed: unknown site ${code}`);
  return site.id;
}

function unitId(code: string): string {
  const unit = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!unit) throw new Error(`attendance seed: unknown unit ${code}`);
  return unit.id;
}

// ── defaults (every company) ────────────────────────────────────────────────────────────────────────────────────

/**
 * The policy row, schedule `standard` (assumption 1) with one open version from 2000-01-01 and its `company`
 * assignment from 2000-01-01 (the same defaults migration 0016 gave existing companies). Returns the schedule id.
 */
export async function seedAttendanceDefaults(db: Executor, companyId: string): Promise<string> {
  await sql`insert into attendance_policy (company_id) values (${companyId}::uuid) on conflict do nothing`.execute(db);
  await sql`
    insert into attendance_schedule (company_id, code, name_fr, name_ar, name_en)
    values (${companyId}::uuid, 'standard', 'Horaire standard', 'التوقيت العادي', 'Standard hours')
    on conflict (company_id, code) do nothing`.execute(db);
  const row = await db.selectFrom('attendance_schedule').select('id').where('company_id', '=', companyId).where('code', '=', 'standard').executeTakeFirstOrThrow();
  await sql`
    insert into attendance_schedule_version (company_id, schedule_id, valid, week, tolerance_minutes)
    select ${companyId}::uuid, ${row.id}::uuid, daterange('2000-01-01', null, '[)'), ${JSON.stringify(STANDARD_WEEK)}::jsonb, 10
     where not exists (select 1 from attendance_schedule_version where company_id = ${companyId}::uuid and schedule_id = ${row.id}::uuid)`.execute(db);
  await sql`
    insert into attendance_schedule_assignment (company_id, schedule_id, target_kind, valid)
    select ${companyId}::uuid, ${row.id}::uuid, 'company', daterange('2000-01-01', null, '[)')
     where not exists (select 1 from attendance_schedule_assignment where company_id = ${companyId}::uuid and target_kind = 'company')`.execute(db);
  return row.id;
}

// ── DEMO ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sun–Thu `start`–`end` with a break (or none); Friday and Saturday rest. */
export function weekOf(start: string, end: string, breakStart: string | null, breakEnd: string | null): Week {
  return ([1, 2, 3, 4, 5, 6, 7] as IsoDay[]).map((day) => (day === 5 || day === 6 ? { day, rest: true as const } : { day, start, end, breakStart, breakEnd }));
}

export const AGENCY_WEEK = weekOf('07:30', '16:00', '12:00', '12:30');
export const RAMADAN_WEEK = weekOf('09:00', '16:00', null, null);

/** The dev pairing code of the pending DEMO kiosk (typed at /kiosk in a browser tab). */
export const DEMO_PAIRING_CODE = 'DEMK-2026';

export const DEMO_KIOSKS = {
  hq: { id: fixed(2, 1), site: 'ALG-HQ', fr: 'Siège — Entrée principale', ar: 'المقر — المدخل الرئيسي' },
  annaba: { id: fixed(2, 2), site: 'ANNABA', fr: 'Agence Annaba — Entrée', ar: 'وكالة عنابة — المدخل' },
  cne: { id: fixed(2, 3), site: 'CNE', fr: 'Constantine — Entrée', ar: 'قسنطينة — المدخل' },
  oran: { id: fixed(2, 4), site: 'ORAN', fr: 'Oran — Entrée', ar: 'وهران — المدخل' },
} as const;

export const DEMO_SCHEDULES = {
  agence: fixed(1, 1),
  ramadan: fixed(3, 1),
  agencyUnit: fixed(4, 1),
  cneSite: fixed(4, 2),
} as const;

/** DEMO's schedules (`agence` on AG-ANNABA and site CNE from 2026-01-01; the Ramadan 1448 override) and kiosks. */
export async function seedDemoAttendanceSetup(db: Executor, nowMs: number): Promise<void> {
  await seedAttendanceDefaults(db, DEMO);
  await sql`
    insert into attendance_schedule (id, company_id, code, name_fr, name_ar, name_en)
    values (${DEMO_SCHEDULES.agence}::uuid, ${DEMO}::uuid, 'agence', 'Agence — accueil du public', 'الوكالة — استقبال الجمهور', 'Agency — public hours')
    on conflict do nothing`.execute(db);
  await sql`
    insert into attendance_schedule_version (id, company_id, schedule_id, valid, week, tolerance_minutes)
    values (${fixed(1, 2)}::uuid, ${DEMO}::uuid, ${DEMO_SCHEDULES.agence}::uuid, daterange('2026-01-01', null, '[)'), ${JSON.stringify(AGENCY_WEEK)}::jsonb, 10)
    on conflict do nothing`.execute(db);
  for (const [id, kind, target] of [
    [DEMO_SCHEDULES.agencyUnit, 'unit', unitId('AG-ANNABA')],
    [DEMO_SCHEDULES.cneSite, 'site', siteId('CNE')],
  ] as const) {
    await sql`
      insert into attendance_schedule_assignment (id, company_id, schedule_id, target_kind, site_id, org_unit_id, valid)
      values (${id}::uuid, ${DEMO}::uuid, ${DEMO_SCHEDULES.agence}::uuid, ${kind},
              ${kind === 'site' ? target : null}::uuid, ${kind === 'unit' ? target : null}::uuid, daterange('2026-01-01', null, '[)'))
      on conflict do nothing`.execute(db);
  }
  // Ramadan 1448 (APPROXIMATE, like the lunar holidays): every schedule, Sun–Thu 09:00–16:00 without break
  await sql`
    insert into attendance_schedule_override (id, company_id, schedule_id, name_fr, name_ar, name_en, dates, week, tolerance_minutes, approximate)
    values (${DEMO_SCHEDULES.ramadan}::uuid, ${DEMO}::uuid, null, 'Ramadan 1448', 'رمضان 1448', 'Ramadan 1448',
            daterange('2027-02-08', '2027-03-10', '[)'), ${JSON.stringify(RAMADAN_WEEK)}::jsonb, 10, true)
    on conflict do nothing`.execute(db);

  const now = new Date(nowMs);
  const code = pairingCodeHash(normalizePairingCode(DEMO_PAIRING_CODE) ?? '');
  const expires = new Date(nowMs + 30 * DAY_MS);
  const k = DEMO_KIOSKS;
  // pending, with the dev pairing code (valid 30 days from this run; refreshed while still unpaired)
  await sql`
    insert into attendance_device (id, company_id, site_id, name_fr, name_ar, pairing_code_hash, pairing_expires_at)
    values (${k.hq.id}::uuid, ${DEMO}::uuid, ${siteId(k.hq.site)}::uuid, ${k.hq.fr}, ${k.hq.ar}, ${code}, ${expires})
    on conflict do nothing`.execute(db);
  await sql`
    update attendance_device set pairing_code_hash = ${code}, pairing_expires_at = ${expires}
     where company_id = ${DEMO}::uuid and id = ${k.hq.id}::uuid and status = 'pending'`.execute(db);
  // active with an unusable random credential (they carry the seeded punches; "Nouveau code" re-pairs them)
  for (const kiosk of [k.annaba, k.cne, k.oran]) {
    await sql`
      insert into attendance_device (id, company_id, site_id, name_fr, name_ar, status, credential_hash, paired_at, created_at)
      values (${kiosk.id}::uuid, ${DEMO}::uuid, ${siteId(kiosk.site)}::uuid, ${kiosk.fr}, ${kiosk.ar}, 'active', ${sha256(randomBytes(32))},
              ${new Date(nowMs - 20 * DAY_MS)}, ${new Date(nowMs - 21 * DAY_MS)})
      on conflict do nothing`.execute(db);
  }
  // Oran: revoked at the seed run (its punches are all before)
  await sql`
    update attendance_device
       set status = 'revoked', credential_hash = null, revoked_at = ${now}, revoked_by = ${user('rh.admin@demo.dz')}::uuid, revoke_reason = 'Tablette remplacée'
     where company_id = ${DEMO}::uuid and id = ${k.oran.id}::uuid and status <> 'revoked'`.execute(db);
}

interface PunchSeed {
  id: string;
  employmentId: string;
  direction: 'in' | 'out';
  at: number;
  source: 'qr' | 'manual';
  deviceId: string | null;
  siteId: string | null;
  deviceRef: string | null;
  reason: string | null;
  createdBy: string | null;
  void?: { by: string; reason: string };
}

/** A deterministic number in [0, 100) per key. */
function roll(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) % 100;
}

function refOf(key: string): string {
  return createHash('sha256').update(`demo-phone:${key}`).digest('hex').slice(0, 32);
}

/**
 * DEMO punches for the working days of the last 15 days up to `nowMs` (docs/contracts/attendance.md › Seed): Région
 * Est (Annaba people at the Annaba kiosk, the others at Constantine) and Région Ouest (at Oran, before its
 * revocation). ~80 % on time, ~10 % late, ~5 % absent, ~3 % incomplete, ~2 % early departure; approved leave days
 * and holidays get none; today only before `nowMs`. Plus agent.annaba's arrival at 07:52 today, a manual punch by
 * rh.est for EMP-0031, a voided double punch, a shared phone, an other-site punch. Returns the count inserted.
 */
export async function seedDemoPunches(db: Executor, nowMs: number): Promise<number> {
  const today = algiersDate(nowMs);
  const employees = demoEmployees();
  const byN = (n: number) => employees[n - 1];
  const holidays = new Set(
    (await sql<{ date: string }>`select date::text as date from public_holiday where company_id = ${DEMO}::uuid`.execute(db)).rows.map((r) => r.date),
  );
  const leave = (
    await sql<{ employmentId: string; startDate: string; endDate: string }>`
      select employment_id as "employmentId", start_date::text as "startDate", end_date::text as "endDate"
        from leave_request where company_id = ${DEMO}::uuid and status = 'approved'`.execute(db)
  ).rows;
  const onLeave = (employmentId: string, date: string) => leave.some((l) => l.employmentId === employmentId && l.startDate <= date && date <= l.endDate);
  const oran = (await sql<{ revokedAt: Date | null }>`select revoked_at as "revokedAt" from attendance_device where id = ${DEMO_KIOSKS.oran.id}::uuid`.execute(db)).rows[0]
    ?.revokedAt;
  const oranUntil = oran ? oran.getTime() : nowMs;
  const linked = new Map<string, string>([
    [LEAVE_DEMO.agent.employmentId, LEAVE_DEMO.agent.userId],
    [LEAVE_DEMO.chef.employmentId, LEAVE_DEMO.chef.userId],
    [LEAVE_DEMO.karim.employmentId, LEAVE_DEMO.karim.userId],
  ]);
  const est = Array.from({ length: 12 }, (_, i) => 22 + i);
  const ouest = Array.from({ length: 7 }, (_, i) => 34 + i);
  const annaba = new Set([29, 30, 31, 32, 33]);
  const dates = Array.from({ length: 15 }, (_, i) => addDays(today, i - 14));
  const workingDates = dates.filter((d) => ![5, 6].includes(isoWeekday(d)) && !holidays.has(d));
  const lastWorking = workingDates.filter((d) => d < today).at(-1);
  const secondLast = workingDates.filter((d) => d < today).at(-2);
  const thirdLast = workingDates.filter((d) => d < today).at(-3);
  const punches: PunchSeed[] = [];

  for (const n of [...est, ...ouest]) {
    const e = byN(n);
    if (!e) continue;
    const isEst = n <= 33;
    const kiosk = isEst ? (annaba.has(n) ? DEMO_KIOSKS.annaba : DEMO_KIOSKS.cne) : DEMO_KIOSKS.oran;
    const [start, end] = isEst ? [450, 960] : [480, 990];
    for (const date of workingDates) {
      if (e.hireDate > date || (e.endDate !== null && e.endDate < date) || onLeave(e.employmentId, date)) continue;
      if (n === 30 && date === today) continue; // agent.annaba: the explicit 07:52 arrival below
      const r = roll(`${n}|${date}`);
      if (r >= 90 && r < 95) continue; // absent
      const jitter = roll(`${date}|${n}|j`);
      const inMin = r >= 80 && r < 90 ? start + 12 + (jitter % 34) : start - (jitter % 11);
      const outMin = r >= 98 ? end - 60 - (jitter % 61) : end + (jitter % 21);
      // other_site: EMP-0023 (Constantine) at the Annaba kiosk two working days ago
      const device = n === 23 && date === secondLast ? DEMO_KIOSKS.annaba : kiosk;
      // shared phone: EMP-0026 and EMP-0027 used the same browser the last working day
      const ref = (n === 26 || n === 27) && date === lastWorking ? refOf('shared-26-27') : refOf(String(n));
      const base = {
        employmentId: e.employmentId,
        source: 'qr' as const,
        deviceId: device.id,
        siteId: siteId(device.site),
        deviceRef: ref,
        reason: null,
        createdBy: linked.get(e.employmentId) ?? null,
      };
      const inAt = algiersInstant(date, inMin) + (jitter % 50) * 1000;
      // a manual arrival recorded by rh.est for EMP-0031 (phone broken) the last working day
      if (n === 31 && date === lastWorking) {
        punches.push({ ...base, id: punchId(n, date, 1), direction: 'in', at: algiersInstant(date, start - 3), source: 'manual', deviceId: null, siteId: siteId('ANNABA'), deviceRef: null, reason: 'Téléphone en panne', createdBy: user('rh.est@demo.dz') });
      } else {
        punches.push({ ...base, id: punchId(n, date, 1), direction: 'in', at: inAt });
      }
      // a double scan voided by HR (EMP-0027, three working days ago)
      if (n === 27 && date === thirdLast) {
        punches.push({ ...base, id: punchId(n, date, 3), direction: 'in', at: inAt + 4 * 60_000, void: { by: user('rh.est@demo.dz'), reason: 'Pointage en double' } });
      }
      if (r >= 95 && r < 98) continue; // incomplete: no departure
      punches.push({ ...base, id: punchId(n, date, 2), direction: 'out', at: algiersInstant(date, outMin) + (jitter % 40) * 1000 });
    }
  }
  // agent.annaba arrived today at 07:52 (a working day of the agency schedule only)
  const agent = byN(30);
  if (agent && ![5, 6].includes(isoWeekday(today)) && !holidays.has(today)) {
    punches.push({
      id: punchId(30, today, 1),
      employmentId: agent.employmentId,
      direction: 'in',
      at: algiersInstant(today, '07:52'),
      source: 'qr',
      deviceId: DEMO_KIOSKS.annaba.id,
      siteId: siteId('ANNABA'),
      deviceRef: refOf('30'),
      reason: null,
      createdBy: LEAVE_DEMO.agent.userId,
    });
  }

  let inserted = 0;
  for (const p of punches) {
    if (p.at > nowMs) continue;
    if (p.deviceId === DEMO_KIOSKS.oran.id && p.at >= oranUntil) continue;
    const window = p.source === 'qr' ? windowOf(p.at) : null;
    const { rows } = await sql<{ id: string }>`
      insert into attendance_punch (id, company_id, employment_id, direction, occurred_at, received_at, source, device_id, qr_window, site_id,
                                    device_ref, reason, created_by, status, voided_at, voided_by, void_reason)
      values (${p.id}::uuid, ${DEMO}::uuid, ${p.employmentId}::uuid, ${p.direction}, ${new Date(p.at)}, ${new Date(p.at + 400)}, ${p.source},
              ${p.deviceId}::uuid, ${window}, ${p.siteId}::uuid, ${p.deviceRef}, ${p.reason}, ${p.createdBy}::uuid,
              ${p.void ? 'void' : 'live'}, ${p.void ? new Date(p.at + 3_600_000) : null}, ${p.void?.by ?? null}::uuid, ${p.void?.reason ?? null})
      on conflict do nothing
      returning id`.execute(db);
    inserted += rows.length;
  }
  return inserted;
}

/** The whole DEMO attendance (seed:dev): setup + punches. */
export async function seedDemoAttendance(db: Executor, nowMs: number): Promise<{ punches: number; pairingCode: string }> {
  await seedDemoAttendanceSetup(db, nowMs);
  return { punches: await seedDemoPunches(db, nowMs), pairingCode: DEMO_PAIRING_CODE };
}
