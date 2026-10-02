# Contract — Attendance (pointage): entrance kiosks, punches, work schedules, daily presence, corrections

Binding contract between `apps/api` (new module `attendance`; small additions to Leave, Staffing, Workflow,
Notifications, Audit, platform security and the worker) and `apps/web` (kiosk display, phone punch landing, Pointage,
presence board, team view, employee Attendance tab, settings, corrections). Check-in mechanism and threat model:
**ADR 009** (Proposed). Owner decision (2026-09-29): attendance is a module **inside HRForce**; check-in by a
**rotating signed QR** at each entrance scanned with the HRForce web app on the employee's phone; no offline capture
(HR records missed punches manually); **no biometrics**; first slice = arrivals and departures, daily presence view,
work schedules, corrections through the workflow engine.

Two phases, one contract. **Phase A** (build now): kiosks and pairing, QR check-in, manual punches, schedules and
their assignment, the daily computation, the presence board (HR and unit heads), the employee's own Pointage page, the
employee Attendance tab, retention. **Phase B** (after A is verified): correction requests through the workflow engine
(new subject type), their notifications, and the monthly report with CSV export. Phase B adds tables and endpoints; it
changes nothing Phase A defines except the columns and check constraints it lists.

All four owner-requested features are covered: arrivals/departures (A), daily presence (A), schedules (A),
corrections (B).

> **Phase A API built (2026-09-30) — what the web must know** (details in *Settled by the build (Phase A API)* at the
> end of Phase A): every shape of the TypeScript block is implemented as written. Additions / readings: `GET
> /me/employment` returns `headOf: UnitRef[]` (always present, `[]` when none; `UnitRef` = `{id, code, name, nameAr,
> kind}` as employment.md); an ANONYMOUS caller of a non-public route with a matching XSRF header/cookie now gets
> **401** (not 403 `xsrf`) so the refresh/login flow runs; punches never appear as `change` entries in a timeline —
> they are `event` entries `attendance.punch_recorded` / `attendance.punch_voided` / `attendance.punch_deleted` with
> `data: {source, direction?}` only (no time, no employment); day-range 422s use field `from` for `invalid` (from after
> to) and `range_too_long`, field `to` for `future`; the team view's too-old date is 422 `date` code `too_old`.

> **Phase B API built (2026-09-30) — what the web must know** (details in *Settled by the build (Phase B API)* at the
> end of Phase B): every Phase B shape is implemented as written, plus:
> - **Scan receipt = 2 minutes** (`hrf_scan` `Max-Age=120`, `ScanView.receiptExpiresAt` = `scannedAt` + 120 s).
> - **New route for the /punch one-tap confirmation: `GET /me/attendance/receipt`** (`attendance.punch_self`, reads the
>   `hrf_scan` cookie, writes nothing, keeps the receipt, `Cache-Control: no-store`) → `ReceiptView {kiosk: {labels: {fr, ar},
>   site: {code, name}}, scannedAt, localTime, workDate, receiptExpiresAt, direction: 'in' | 'out', duplicate: boolean}`;
>   same errors as the punch (409 `attendance-not-linked` → 409 `attendance-no-scan` → 422 `attendance-qr-invalid` → 409
>   `attendance-not-employed`). Flow: scan → (sign in) → `GET /me/attendance/receipt` → « Enregistrer mon arrivée à … ? »
>   → `POST /me/attendance/punches`. `duplicate: true` = redeeming returns the existing punch (« Déjà enregistré »); `localTime` is then that punch's time
>   (settled by the verification).
> - `MyDaysView` / `EmployeeDaysView` gain `correctionWindow: {from, to} | null` (the days a correction may be asked for
>   today; employees cannot read the policy). `PolicyView` gains `correctionMaxAgeDays`, `correctionWorkflowCode`.
> - `GET /attendance/corrections` also accepts `employmentId=` (the employee Présence tab's list).
> - `CorrectionView.workflow` is `WorkflowProgressView | null` (null never happens through the API); `requestedBy` is always set.
> - `CorrectionDetailView` = `CorrectionView` + `history: TaskHistoryView[]` + `day: AttendanceDayView` (with `punches`, their
>   `_actions` always `[]`).
> - New 422 codes on `POST /me/attendance/corrections`: `changes.<i>.time` `exists` (a live punch at that minute that the
>   request does not void) and `duplicate` (two adds at one minute); `attendance-correction-date` carries
>   `errors[{field: 'date', code: 'out_of_window'}]`.
> - `task.escalated` can be about a correction: `notification.subject.type = 'attendance_correction'`, link
>   `/me/attendance?correction=<id>`, `data` = the correction data + `stepKey`, `escalationReason`.
> - Timeline subject `attendance_correction:<id>` (visible like the detail, no `audit.read`): correction events only
>   (`attendance.correction_requested`, `attendance.correction_item_added {position, action, direction}`,
>   `attendance.correction_approved|rejected|cancelled`), workflow rows and `workflow.*` events, and the punch events of
>   the punches it added / voided — **no `change` entries for the correction tables** (see *Audit*).

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Standard schedule | **Sunday–Thursday 08:00–16:30**, unpaid break **12:00–12:30** (8 h/day, 40 h/week, the legal weekly duration); **Friday + Saturday** weekly rest. Some employers use a 1-hour break (37.5 h) — edit the data | `attendance_schedule_version.week` (seeded `standard`) |
| 2 | Tolerance | **10 minutes** on arrival and on departure. Lateness is counted **from the scheduled start** once the tolerance is exceeded (08:11 → 11 min late; 08:10 → on time) | `attendance_schedule_version.tolerance_minutes` |
| 3 | Ramadan hours | A company-wide date-bounded override **Sun–Thu 09:00–16:00, no break**, seeded for Ramadan 1448 (**2027-02-08 → 2027-03-09, approximate**, like the lunar holidays); HR confirms dates and hours each year | `attendance_schedule_override` |
| 4 | Half days | A half-day leave (leave module flags) removes the morning or the afternoon: the split is the schedule's break (morning ends at `breakStart`, afternoon starts at `breakEnd`), or the middle of the day when there is no break | computation rule |
| 5 | Retention | Punches (and Phase B corrections) are deleted **60 months (5 years)** after the end of the month of the work day; the audit log's own copies follow the audit retention (see question below) | `attendance_policy.retention_months` (12–120) |
| 6 | Correction approval chain (Phase B) | **Unit head (manager) → HR** (`attendance.manage` over the employee), the leave default; `attendance.hr_only` available as a policy switch | `attendance_policy.correction_workflow_code` |
| 7 | Correction window (Phase B) | An employee may ask for a correction of a day up to **30 days** back, 1–4 changes per request, one pending request per day | `attendance_policy.correction_max_age_days` |
| 8 | Where one may punch | At **any kiosk of the company**; a punch at a site other than the employee's site that day is flagged `other_site` (missions, cover), not refused | computation rule |
| 9 | Punch direction | **Inferred** by the server: first punch of the day = arrival, then alternating; a second scan within **2 minutes** returns the first one | `attendance_policy.min_punch_gap_seconds` |
| 10 | Who sees what | `admin_rh_central`: everything; `rh_regional`: read + manual punches + HR approval in scope; `lecture`: read in scope; **unit heads** (linked users of `org_unit_head`) see their units' daily presence without a grant; employees see their own history. Kiosks, schedules and policy: `admin_rh_central` only (company-wide) **(confirmed 2026-09-29)** | seed (Permissions) |
| 11 | Kiosk display | Shows **no names** of people who punched (privacy); fr and ar side by side | web |
| 12 | Shifts | Day schedules only: a working day starts and ends on the same calendar day (no night shifts), no rotating rosters, **no overtime computation** | schedule rules |
| 13 | Device signal | A random per-browser identifier (cookie) is kept, as a keyed hash, on QR punches, to flag one phone punching for several employees (`shared_device`, HR only). No geolocation, no IP address, no photo on punches | ADR 009 §5 |
| 14 | Information notice (Law 18-07) | The Pointage page shows a notice of what is recorded (text in *Web*); the owner checks whether an ANPDP declaration is needed | web |

**Questions for the owner (not assumptions):** (a) **Session length on phones** — today's refresh session (12 h idle,
ADR 004) means most employees sign in again every morning; the scan receipt (below) makes that work, but a longer
"remembered phone" session would need an ADR 004 amendment. (b) **Audit log retention** — the audit log keeps a copy of
every punch insert (it is append-only, with no retention job yet), so deleting punches after 5 years does not erase
them until an audit retention policy exists.

> **Owner decisions 2026-09-29:** ADR 009 accepted as written (shared 30 s windows, not single-use). Daily sign-in kept (no "remember this phone"; ADR 004 unchanged). Visibility (assumption 10) confirmed. **Audit and retention:** punch rows are immutable and carry who/when, so the audit log records punch events **without the personal payload** (no row copy of `attendance_punch` in `audit_event` before/after); the retention purge then fully erases punches. This replaces the contract's proposed audit-trigger exception for the purge; the builders record the exact mechanism under "Settled by the build".

## Wording (fr / ar, gender-neutral Arabic — owner rule 2026-09-29)

| Key idea | fr | ar |
|---|---|---|
| module / nav (employee) | Pointage | تسجيل الحضور |
| nav (HR) | Présence | الحضور |
| nav (heads) | Mon équipe | فريق العمل |
| arrival / departure | Arrivée / Départ | دخول / خروج |
| punch recorded | Arrivée enregistrée à 07:58 / Départ enregistré à 16:34 | تم تسجيل الوصول على الساعة 07:58 / تم تسجيل المغادرة على الساعة 16:34 |
| statuses | Présent, En retard, Absent, Incomplet, Attendu, En congé, Jour férié, Repos | حضور، تأخر، غياب، تسجيل ناقص، وصول منتظر، عطلة، عطلة رسمية، يوم راحة |
| kiosk instruction | Scannez ce code avec l'appareil photo de votre téléphone | يرجى مسح هذا الرمز بكاميرا الهاتف |
| kiosk offline | Pointage indisponible — connexion perdue. Adressez-vous au service RH. | تسجيل الحضور غير متاح حاليا — انقطاع الاتصال. يرجى التوجه إلى مصلحة الموارد البشرية. |
| QR expired | Ce code a expiré. Veuillez scanner à nouveau le code affiché à l'entrée. | انتهت صلاحية الرمز. يرجى إعادة مسح الرمز المعروض عند المدخل. |
| scan again after sign-in | Veuillez scanner à nouveau le code à l'entrée. | يرجى إعادة مسح الرمز عند المدخل. |
| kiosk | Borne de pointage | شاشة تسجيل الحضور |

Arabic never uses a masculine imperative (« امسح », « اتصل »): « يرجى + masdar », verbal nouns, passive.

---

## Phase A — kiosks, punches, schedules, daily presence

### Data (migration 0016)

All tenant tables: `company_id` + RLS/FORCE + the standard policy, composite `(company_id, …)` FKs, the audit trigger
unless listed exempt (reason in `tools/guardrails/audit-exempt.json`). Users referenced without FK (as
`role_grant.user_id`). Times of day are `time` columns in the JSON documents only (below); instants are `timestamptz`.

| Table | Columns | Rules |
|---|---|---|
| `attendance_policy` (pk `company_id`, audited with `audit.capture('company_id')`) | `retention_months int` (60), `min_punch_gap_seconds int` (120), `updated_at` | 12 ≤ retention ≤ 120; 0 ≤ gap ≤ 600. Created per company by the migration (existing), `bootstrap` and the `SYSTEM_*` helpers (new). A missing row = the defaults |
| `attendance_device` | `id`, `company_id`, `kind` (`qr_kiosk`; check — `badge_terminal` is reserved, ADR 009 §6), `site_id` (FK site), `name_fr`, `name_ar` (1–120, trimmed; the entrance label, e.g. « Siège — Entrée principale » / « المقر — المدخل الرئيسي »), `status` (`pending`/`active`/`revoked`), `credential_hash bytea` null (32 bytes), `paired_at` null, `pairing_code_hash bytea` null (32), `pairing_expires_at` null, `allowed_networks cidr[]` not null default `'{}'` (≤ 10), `created_by`, `created_at`, `revoked_at` null, `revoked_by` null, `revoke_reason` null (3–500) | `pending` ⇔ never paired (`credential_hash` null); `active` ⇒ `credential_hash` not null; `revoked` ⇒ credential and pairing columns null and the three revoke columns set; `pairing_code_hash` null ⇔ `pairing_expires_at` null; **global** unique index on `pairing_code_hash` where not null (the pairing lookup runs before the company is known); `revoked` is final (BEFORE UPDATE trigger); no DELETE for `hrforce_app`. Masked in the audit diff: `credential_hash`, `pairing_code_hash` |
| `attendance_device_heartbeat` (**audit-exempt**: operational heartbeat overwritten every minute, not business data) | `device_id` pk (FK device), `company_id`, `last_seen_at`, `last_ip inet`, `last_user_agent text` (≤ 300, truncated) | upsert only (app: INSERT, UPDATE) |
| `attendance_schedule` | `id`, `company_id`, `code` (`^[a-z][a-z0-9_]{1,39}$`, immutable), `name_fr/ar/en` (1–120), `active bool` (true), `created_at` | unique (`company_id`,`code`); no delete (deactivate); an inactive schedule cannot be newly assigned |
| `attendance_schedule_version` | `id`, `company_id`, `schedule_id`, `valid daterange` (`[from, to)`, `to` null = open), `week jsonb`, `tolerance_minutes int` (0–60) | no overlap per schedule (exclusion, `btree_gist` exists since 0004); versions are appended, never edited (BEFORE UPDATE trigger allows only closing an open `valid` upper bound) |
| `attendance_schedule_override` | `id`, `company_id`, `schedule_id` null (null = **every schedule**), `name_fr/ar/en`, `dates daterange` (`[from, to+1)`), `week jsonb`, `tolerance_minutes int`, `approximate bool` (false), `created_at` | no overlap per (`company_id`, `coalesce(schedule_id, '00000000-0000-0000-0000-000000000000')`) — exclusion on the expression; length ≤ 60 days; editable and deletable (history via audit, as public holidays) |
| `attendance_schedule_assignment` | `id`, `company_id`, `schedule_id`, `target_kind` (`company`/`site`/`unit`/`employment`), `site_id` null, `org_unit_id` null, `employment_id` null, `valid daterange`, `created_at` | exactly the target column of the kind is set (`company`: none); FKs composite; no overlap per (`company_id`, `target_kind`, `coalesce(site_id, org_unit_id, employment_id, zero uuid)`) — exclusion; `unit` target is never the root unit (API 422); for `company`, the ranges of a company are contiguous from the first one and the last one is open (API rule) |
| `attendance_punch` | `id`, `company_id`, `employment_id`, `direction` (`in`/`out`), `occurred_at timestamptz` (the instant that counts), `work_date date` **generated always as `((occurred_at at time zone 'Africa/Algiers')::date) stored`** (verified on PG16), `received_at timestamptz default now()`, `source` (`qr`/`manual`; Phase B adds `correction`; `badge` reserved), `device_id` null (FK device), `qr_window bigint` null, `site_id` null (FK site), `device_ref text` null (32 lower-case hex), `reason` null (3–500), `created_by uuid` (the employee's user for `qr`, the HR user for `manual`), `status` (`live`/`void`), `voided_at` null, `voided_by` null, `void_reason` null (3–500) | `source='qr'` ⇔ (`device_id`, `qr_window`, `site_id` not null, `reason` null); `source='manual'` ⇒ `reason` not null and `device_id`, `qr_window`, `device_ref` null; void columns all set ⇔ `status='void'`; **unique (`company_id`,`employment_id`,`device_id`,`qr_window`) where `source='qr'`** (one punch per employee per QR window); indexes (`company_id`,`work_date`,`employment_id`), (`company_id`,`employment_id`,`occurred_at`); **immutable except `live → void` once** (BEFORE UPDATE trigger); no DELETE for `hrforce_app`; DELETE for `hrforce_worker` (retention). `device_ref` masked in the audit diff |

`permission_group_ck` gains `attendance`. `security_policy.mfa_required_permissions`: the column default and every
existing row gain `attendance.configure` (a kiosk credential can produce valid codes; pairing is access management).

**Week document** (`week jsonb`, validated by the application; a check constraint enforces `jsonb_typeof = 'array'`
and length 7):

```ts
type WeekDay =
  | { day: 1 | 2 | 3 | 4 | 5 | 6 | 7; rest: true }                         // ISO: 1 = Monday … 5 = Friday, 6 = Saturday, 7 = Sunday
  | { day: 1 | 2 | 3 | 4 | 5 | 6 | 7; start: string; end: string;         // "HH:MM", 24 h, 00:00–23:59
      breakStart: string | null; breakEnd: string | null };               // both or neither
type Week = WeekDay[];   // exactly 7 entries, days 1..7 in order
```
Rules (422 `errors[{field: 'week.<i>.<key>', code}]`): `start < end`; break both or neither and
`start < breakStart < breakEnd < end` (`invalid_time` / `invalid_break`); at least one working day (`no_working_day`).
`scheduledMinutes(day) = end − start − (breakEnd − breakStart)`.

**Seeded per company** (migration for existing companies, `bootstrap` and `SYSTEM_*` for new ones): the policy row,
schedule `standard` (« Horaire standard » / « التوقيت العادي » / "Standard hours") with one open version from
`2000-01-01` = assumption 1, and the `company` assignment of `standard` from `2000-01-01`, open. Nothing else is
seeded outside `seed:dev`.

### Schedule resolution

For employment E on date D (inside its employment), the **effective schedule** is found in this order; the first match
wins and is reported as `source`:

1. an `employment` assignment of E valid on D;
2. a `unit` assignment valid on D on E's assignment unit on D, else on its nearest ancestor that has one (ancestors
   from `org_unit_closure`, i.e. today's tree); a unit assignment therefore covers the unit's sub-units;
3. a `site` assignment valid on D on E's **effective site** on D (`assignment.site_id`, else the unit's effective site);
4. the `company` assignment valid on D (always exists).

The schedule's **day rule** on D = the override covering D for that schedule, else the company-wide override covering
D, else the schedule version valid on D, taking the `week` entry of D's ISO weekday and that document's tolerance.
A day is a **rest day** when that entry is `rest`.

### Check-in (ADR 009)

**Secret.** Env `ATTENDANCE_KEY`: base64 of exactly 32 bytes, required in production (validated at boot like
`AUTH_MFA_KEY`; a public development default is refused in production; `deploy/init-env.sh` generates it). Subkeys:
`K_qr = HMAC(ATTENDANCE_KEY, "qr")`, `K_scan = HMAC(…, "scan")`, `K_dev = HMAC(…, "device")`. Rotating the key only
invalidates live codes (≤ 2 min) and receipts (≤ 2 min, Phase B) and changes device refs from then on.

**Pairing.** A pairing code is 8 characters of Crockford base32 (`0-9 A-H J K M N P-T V-Z`), displayed `XXXX-XXXX`;
input is case-insensitive, hyphens/spaces ignored, `O→0`, `I/L→1`. Stored as SHA-256 of the 8 normalised characters,
valid **10 minutes**, single use. `POST /api/kiosk/pair {code}`: the lookup of `(company_id, device_id)` by hash goes
through a migrator-owned `SECURITY DEFINER` function `public.attendance_pairing_lookup(bytea)` (pinned
`search_path`, returns only those two ids for a non-expired code of a non-revoked device); the use case then runs in
its own transaction with `app.company_id` set to that company and `app.user_id` null. On success: new 32-byte secret,
`credential_hash` = its SHA-256, `status='active'`, `paired_at=now()`, pairing columns null (a previous credential of
the device stops working), audit event `attendance.device_paired`. 40 bits of entropy over a 10-minute life make
guessing hopeless without a throttle; none is added.

**Kiosk credential cookie** `hrf_kiosk` = `base64url(companyId(16) ‖ deviceId(16) ‖ secret(32))`; `HttpOnly; Secure;
SameSite=Strict; Path=/api/kiosk; Max-Age=34560000` (400 days, the browser cap), re-sent by every `GET
/api/kiosk/session`. Checking it: decode (bad → 401), transaction with `app.company_id` = the embedded company, read
the device, constant-time compare the hash, `status='active'`, and if `allowed_networks` is non-empty the client
address (same `TRUST_PROXY_HOPS` rule as the login throttle) must be inside one of them (else **403**
`kiosk-network-refused`). Any other failure → **401** `kiosk-unpaired` and the cookie is cleared. Each successful
call upserts the heartbeat when `last_seen_at` is older than 60 s.

**QR token** (71 characters): `base64url(0x01 ‖ companyId(16) ‖ deviceId(16) ‖ window(uint32 BE) ‖
HMAC-SHA256(K_qr, "hrforce.attendance.qr.v1\0" ‖ the 37 preceding bytes)[0..16])`, `window = floor(epochSeconds / 30)`.
`GET /api/kiosk/qr` returns windows `w, w+1, w+2, w+3` (w = the current window) with, for each, `qr =
${WEB_BASE_URL}/punch#<token>`. A token is **accepted when its window is the current or the previous one** (so it
works 30–60 s after it first shows); any other window → 410 `attendance-qr-expired`; wrong length/version/MAC, unknown
or non-active device → 422 `attendance-qr-invalid`.

**Scan** (`POST /api/attendance/scan {token}`, public). XSRF: the double-submit header must equal the cookie, but the
signature is **not bound to a session** (new platform decorator `@XsrfUnbound()`, a third value of the existing
`XSRF_BINDING_KEY` metadata, allowed only on `@Public` routes that write nothing to the database; documented in
`platform/security`). Reason: the phone's session has usually expired overnight, so its `XSRF-TOKEN` may still be bound
to a dead session id; the route creates no server state and its only effect is a cookie for the caller's own browser.
On success the API sets:
- `hrf_scan` = `base64url(0x01 ‖ companyId ‖ deviceId ‖ window(uint32) ‖ scannedAtMs(uint64 BE) ‖ HMAC(K_scan, …)[0..16])`;
  `HttpOnly; Secure; SameSite=Strict; Path=/api/me/attendance; Max-Age=120` (**2 minutes** since Phase B, owner decision
  2026-09-30; was 300). `scannedAt` = the server's clock at the
  scan.
- `hrf_dev` if absent: 16 random bytes base64url; `HttpOnly; Secure; SameSite=Strict; Path=/api/me/attendance;
  Max-Age=34560000`.

**Punch** (`POST /api/me/attendance/punches`, no body, `attendance.punch_self`). In the request transaction:
1. the caller's linked employment (`user_employment`), else 409 `attendance-not-linked`;
2. `hrf_scan` present, MAC valid, same company as the session, `scannedAt` ≤ 2 min ago (was 5) — else 409 `attendance-no-scan`;
   the device is still `active` — else 422 `attendance-qr-invalid`;
3. the employment is active on `work_date(scannedAt)` (hire ≤ D, end null or ≥ D) — else 409 `attendance-not-employed`;
4. `pg_advisory_xact_lock` on (company, employment) (double taps are serialised);
5. **duplicate**: a live punch of the employment with `|occurred_at − scannedAt| < min_punch_gap_seconds`, or a punch
   with the same (device, window) → answer **200** with that punch, `duplicate: true`, write nothing;
6. **direction**: the latest live punch of the same `work_date` with `occurred_at < scannedAt`; none or `out` → `in`,
   `in` → `out`;
7. insert: `source='qr'`, `occurred_at = scannedAt`, `received_at = now()`, `device_id`, `qr_window`, `site_id` = the
   device's site, `device_ref = hex(HMAC(K_dev, hrf_dev value)[0..16])` (null when the cookie is missing),
   `created_by` = caller → **201**.
Both 200 and 201 clear `hrf_scan` (`Max-Age=0`). A signed-in caller gets the same answer; the web always calls scan
first, then punch (see *Web*).

### Daily computation (pure domain code, unit-tested)

Computed **on read** for each (employment, date) requested — nothing is stored, so late leave approvals, holiday
edits, schedule changes, manual punches and (Phase B) corrections are reflected at once in every past day.
`today` = the date in `Africa/Algiers` (provider `AttendanceClock`, pinned by tests); a day is **final** when
`date < today`. Inputs per employee and day: employment dates, assignment (unit, effective site), the effective
schedule's day rule (above), approved and pending leave requests covering the day (Leave module), public holidays
(Leave module's `public_holiday`), live punches of the day ordered by `occurred_at` then `id`.

1. **Outside the employment** → status `not_employed` (per-employee views only; the board never lists them).
2. **Leave**: an **approved** request covering the day. Its part: `full`, or `afternoon` off when the day is its
   `start_date` with `half_day_start`, or `morning` off when the day is its `end_date` with `half_day_end` (a one-day
   request with one flag is a half day of that flag's kind). A pending request covering the day adds the flag
   `leave_pending` and changes nothing else.
3. Precedence of non-working days: **full-day approved leave → `on_leave`**; else **public holiday → `holiday`**; else
   **rest day of the schedule → `rest_day`**. In these three cases, if live punches exist, `workedMinutes` is computed
   (step 5) and a flag `worked_on_leave` / `worked_on_holiday` / `worked_on_rest_day` is added; `scheduledMinutes = 0`.
4. **Working day**: `expectedStart = start`, `expectedEnd = end`; a `morning` half-day leave sets `expectedStart =
   breakEnd` (no break: the middle of start–end, minute rounded down) and adds `half_day_leave_morning`; an
   `afternoon` one sets `expectedEnd = breakStart` (or the middle) and adds `half_day_leave_afternoon`.
   `scheduledMinutes` = the minutes of [expectedStart, expectedEnd] minus the break inside it.
5. **Pairs**: walk the ordered punches; an `in` opens a pair (an `in` while one is open is ignored for pairing and adds
   `unpaired_punch`); an `out` closes the open pair (an `out` with none open adds `unpaired_punch`).
   `arrival` = the first `in`; `departure` = the last `out` after `arrival`.
   `workedMinutes` = Σ(pair out − pair in) − the part of the pairs inside [breakStart, breakEnd] (working days with a
   break only), floored to whole minutes, never negative.
   An `in` still open: on a non-final day adds `open`; on a final day makes the day incomplete (below).
6. **Status of a working day**:
   - no live punch: final → `absent`; today and `now < expectedStart + tolerance` → `expected`; else `absent`;
   - no `in` but some `out`, or (final and a pair still open) → `incomplete`;
   - else `late` when `arrival > expectedStart + tolerance`, otherwise `present`.
   `lateMinutes = arrival − expectedStart` (whole minutes) when late, else 0 (reported on `incomplete` days too).
   `earlyDepartureMinutes = expectedEnd − departure` when `departure < expectedEnd − tolerance` and the day is final or
   no pair is open (then flag `early_departure`), else 0.
7. Other flags: `other_site` (a live QR punch at a device whose site ≠ the employee's effective site that day),
   `manual_punch` (a live manual punch that day), `corrected` (Phase B: a live correction punch or a punch voided by a
   correction), `shared_device` (a live QR punch whose `device_ref` was also used by a live QR punch of **another**
   employment of the company that same `work_date`) — `shared_device` is returned **only** to callers holding
   `attendance.manage` over the employee.

Required unit tests: every status and flag, tolerance boundaries (exactly `start + tolerance` is on time), break
subtraction, both half days, leave on a holiday (→ `on_leave`), an override inside a version, resolution order
(employment > unit > ancestor unit > site > company), a punch at 23:30Z counting for the next Algiers day.

### Permissions (catalogue additions, group `attendance`, sort 710–740; labels fr/ar/en)

| Code | fr | ar | en | Granted to |
|---|---|---|---|---|
| `attendance.punch_self` | Pointer et consulter son pointage | تسجيل الحضور والاطلاع على السجل الشخصي | Clock in and view own attendance | `employe`, `admin_rh_central` (all non-medical codes) |
| `attendance.read` | Consulter la présence | الاطلاع على الحضور | View attendance | `admin_rh_central`, `rh_regional`, `lecture` |
| `attendance.manage` | Gérer les pointages (saisie manuelle, annulation, validation RH des corrections) | تسيير تسجيلات الحضور (الإدخال اليدوي، الإلغاء، مصادقة الموارد البشرية على التصحيحات) | Manage punches (manual entry, void, HR approval of corrections) | `admin_rh_central`, `rh_regional` |
| `attendance.configure` | Paramétrer le pointage (horaires, bornes) | إعداد نظام الحضور (المواقيت، شاشات المداخل) | Configure attendance (schedules, kiosks) | `admin_rh_central` |

`PERMISSION_CODES`, `SYSTEM_ROLES` and the catalogue unit test are updated; the migration grants them to the existing
system roles of every company. Unit heads need **no permission** for the team view (as the leave manager step).

### Scope

- **Per-employee routes** (`/employees/:id/attendance/*`, manual punch, void): the employment scope rule
  (`employment.md`: assignment unit **today**; ended employment → last assignment's unit) for the route's permission.
  Unknown / other company / out of `attendance.read` scope → **404**; readable but outside `attendance.manage` scope →
  **403** `forbidden-scope`.
- **Presence board for date D**: employees whose employment is active on D and whose assignment unit **on D** is in the
  caller's `attendance.read` scope (so a transferred employee appears on the board of the region that had them that
  day). `unitId`/`includeSubUnits`/`siteId` filter on the unit and effective site on D.
- **Team view**: the units the caller heads on D (their linked employment is the `org_unit_head` of the unit on D) and
  all their sub-units; the same listing rule as the board, without any grant.
- **Configuration** (`attendance.configure`): writes need the permission over the **whole company** (the root unit),
  else 403 `forbidden-scope` (as `document.configure`); kiosk and schedule reads need `attendance.configure` /
  `attendance.read` anywhere.
- **Separation of duties**: nobody records or voids a manual punch on their **own** linked employment → 409
  `attendance-self-manage`.
- **Self-service**: `/me/attendance*` work only on the caller's linked employment (`attendance-not-linked` 409).

### Endpoints (under `/api`, problem+json)

**Device side and scan (public; no user session involved)**

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /kiosk/pair` | `@Public` + XSRF (normal) | `{code}` → 200 `KioskSessionView` + `hrf_kiosk`; malformed → 422 `errors[{field:'code', code:'invalid'}]`; unknown / expired / used / revoked device → **410** `kiosk-pairing-invalid` |
| `GET /kiosk/session` | `@Public` (device cookie) | → 200 `KioskSessionView`, cookie renewed; 401 `kiosk-unpaired`; 403 `kiosk-network-refused` |
| `GET /kiosk/qr` | `@Public` (device cookie) | → 200 `KioskQrView`, `Cache-Control: no-store`; same errors |
| `POST /attendance/scan` | `@Public` + `@XsrfUnbound()` | `{token}` → 200 `ScanView` + `hrf_scan` (+ `hrf_dev`); 422 `attendance-qr-invalid`; 410 `attendance-qr-expired` |

**Self-service and team**

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /me/attendance/punches` | `attendance.punch_self` | no body → **201** `PunchResultView` (200 `duplicate: true`); 409 `attendance-not-linked`, `attendance-no-scan`, `attendance-not-employed`; 422 `attendance-qr-invalid` |
| `GET /me/attendance/days?from=&to=` | `attendance.punch_self` | default `from = to = today`; `to ≤ today`, range ≤ 62 days (422 `errors[{field:'from'\|'to', code:'invalid'\|'future'\|'range_too_long'}]`) → `MyDaysView`; 409 `attendance-not-linked` |
| `GET /me/team/presence?date=&status=&q=&page=&pageSize=` | `@Authenticated` | `date` default today, `today − 31 ≤ date ≤ today` (else 422 `date`) → `TeamPresenceView` (`units: []` and no items when the caller heads nothing that day) |

**HR**

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /attendance/presence?date=&unitId=&includeSubUnits=&siteId=&status=&q=&sort=&lang=&page=&pageSize=` | `attendance.read` | `date` default today, not in the future (422); `includeSubUnits` default true; `status` one of `DayStatus` except `not_employed`; `q` = name (Latin/Arabic) or matricule as `/employees`; `sort` = `unit` (default) \| `name` \| `arrival` \| `status`; `lang` as `/employees`; `pageSize` ≤ 100 (default 50) → `PresenceBoardView`. Counts are over every matching employee **before** the `status` filter. More than 5 000 matching employees → 422 `errors[{field:'unitId', code:'too_many'}]` |
| `GET /employees/:id/attendance/days?from=&to=` | `attendance.read` | as `/me/attendance/days` → `EmployeeDaysView` (punches with `_actions`) |
| `GET /employees/:id/attendance/schedule?from=&to=` | `attendance.read` | range ≤ 366 days, default the current month → `ScheduleSegmentsView` |
| `POST /employees/:id/attendance/punches` | `attendance.manage` | `{direction: 'in'\|'out', date: 'YYYY-MM-DD', time: 'HH:MM', reason, siteId?}` (Algiers local time; `siteId` default the employee's effective site that day) → **201** `PunchView`. 422: `time` in the future (`future`), `date` older than the retention (`too_old`), `reason` 3–500, unknown `siteId` (`not_found`); 409 `attendance-not-employed`, `attendance-self-manage`, `attendance-punch-exists` (a live punch of the employee at the same minute) |
| `POST /attendance/punches/:id/void` | `attendance.manage` | `{reason}` (3–500) → 200 `PunchView`; 409 `attendance-punch-void` (already void), `attendance-self-manage`; the punch's employee gives the scope |
| `GET /attendance/policy` | `attendance.read` | → `PolicyView` |
| `PUT /attendance/policy` | `attendance.configure` (company) | `{retentionMonths?, minPunchGapSeconds?}` → 200 `PolicyView` |
| `GET /attendance/schedules` | `attendance.read` | → `{items: ScheduleView[]}` (inactive included, `code` order) |
| `POST /attendance/schedules` | `attendance.configure` (company) | `{code, labels:{fr,ar,en}, week, toleranceMinutes, validFrom?}` (`validFrom` default today) → 201 `ScheduleView`; 409 `attendance-schedule-code-taken` |
| `PATCH /attendance/schedules/:id` | `attendance.configure` (company) | `{labels?, active?}` → 200; deactivating a schedule with a current or future assignment → 409 `attendance-schedule-in-use` |
| `POST /attendance/schedules/:id/versions` | `attendance.configure` (company) | `{validFrom, week, toleranceMinutes}` → 201 `ScheduleView`; `validFrom` must be after the latest version's start (else 409 `attendance-version-date`); the latest version is closed at `validFrom`. A past `validFrom` is allowed (past days recompute; audited) |
| `GET /attendance/schedule-overrides?year=` | `attendance.read` | → `{items: OverrideView[]}` (overrides intersecting the year, default current) |
| `POST /attendance/schedule-overrides` | `attendance.configure` (company) | `{scheduleId: string \| null, labels, from, to, week, toleranceMinutes, approximate}` → 201; overlap → 409 `attendance-override-overlap`; > 60 days → 422 `to` `range_too_long` |
| `PUT /attendance/schedule-overrides/:id` | `attendance.configure` (company) | same body → 200 |
| `DELETE /attendance/schedule-overrides/:id` | `attendance.configure` (company) | → 204 |
| `GET /attendance/schedule-assignments?targetKind=&scheduleId=&at=` | `attendance.read` | `at` (default today) = only assignments valid on that date; `at=all` = every assignment → `{items: AssignmentView[]}` |
| `POST /attendance/schedule-assignments` | `attendance.configure` (company) | `{scheduleId, target: {kind, id: string \| null}, validFrom}` → 201 `AssignmentView`. The target's open assignment that started before `validFrom` is closed at `validFrom`; any other overlap → 409 `attendance-assignment-overlap`. `unit` on the root → 422 `target.id` `root_unit`; unknown target → 422 `not_found`; inactive schedule → 422 `scheduleId` `inactive` |
| `POST /attendance/schedule-assignments/:id/end` | `attendance.configure` (company) | `{validTo}` (last day, inclusive) → 200; on a `company` assignment → 409 `attendance-assignment-company` (change the default by adding a new one) |
| `DELETE /attendance/schedule-assignments/:id` | `attendance.configure` (company) | only when it starts after today → 204, else 409 `attendance-assignment-started`; never the only `company` one |
| `GET /attendance/kiosks` | `attendance.configure` | → `{items: KioskView[]}` newest first |
| `POST /attendance/kiosks` | `attendance.configure` (company) | `{siteId, labels:{fr,ar}, allowedNetworks?: string[]}` → **201** `{kiosk: KioskView, pairing: PairingCodeView}`; bad CIDR → 422 `allowedNetworks.<i>` `invalid` |
| `PATCH /attendance/kiosks/:id` | `attendance.configure` (company) | `{labels?, siteId?, allowedNetworks?}` → 200; revoked → 409 `kiosk-revoked` |
| `POST /attendance/kiosks/:id/pairing-code` | `attendance.configure` (company) | → 200 `PairingCodeView` (replaces an unused code; the paired device keeps working until the new code is used); revoked → 409 `kiosk-revoked` |
| `POST /attendance/kiosks/:id/revoke` | `attendance.configure` (company) | `{reason}` (3–500) → 200 `KioskView`; already revoked → 409 `kiosk-revoked` |

Out-of-company ids on configuration routes → 404. Response bodies never contain the credential, its hash or the
pairing code hash; the pairing code appears only in `PairingCodeView` (key `code`), once.

```ts
type DayStatus = 'present' | 'late' | 'absent' | 'incomplete' | 'expected' | 'on_leave' | 'holiday' | 'rest_day' | 'not_employed';
type DayFlag = 'open' | 'early_departure' | 'half_day_leave_morning' | 'half_day_leave_afternoon' | 'leave_pending'
  | 'worked_on_rest_day' | 'worked_on_holiday' | 'worked_on_leave' | 'other_site' | 'unpaired_punch' | 'manual_punch'
  | 'corrected' | 'shared_device';
type Labels = { fr: string; ar: string; en: string };
interface UserRef { id: string; displayName: string }                       // displayName = id for a former member
interface SiteRef { id: string; code: string; name: string }
interface EmployeeRef { id: string; matricule: string; person: NamePair; unit: UnitRef; site: SiteRef | null } // on that day (employment.md types)
interface PunchTime { id: string; occurredAt: string; localTime: string }   // ISO UTC; "HH:MM" Algiers
interface DaySchedule {
  scheduleId: string; code: string; labels: Labels;
  source: 'employment' | 'unit' | 'site' | 'company';
  override: { id: string; labels: Labels; approximate: boolean } | null;
  start: string | null; end: string | null; breakStart: string | null; breakEnd: string | null;   // null on a rest day
  expectedStart: string | null; expectedEnd: string | null;                                        // after half days
  toleranceMinutes: number; scheduledMinutes: number;
}
interface AttendanceDayView {
  date: string; employee: EmployeeRef; status: DayStatus; final: boolean;
  schedule: DaySchedule | null;                                              // null when not_employed
  arrival: PunchTime | null; departure: PunchTime | null;
  lateMinutes: number; earlyDepartureMinutes: number; workedMinutes: number;
  flags: DayFlag[];                                                          // sorted as the DayFlag union
  leave: { requestId: string; type: { code: string; labels: Labels }; part: 'full' | 'morning' | 'afternoon' } | null;
  holiday: { labels: Labels; approximate: boolean } | null;
  punches?: PunchView[];                                                     // per-employee routes only, oldest first, void included
}
interface PunchView {
  id: string; direction: 'in' | 'out'; occurredAt: string; localTime: string; workDate: string;
  source: 'qr' | 'manual' | 'correction';
  kiosk: { id: string; labels: { fr: string; ar: string }; site: SiteRef } | null;
  site: SiteRef | null; reason: string | null; createdBy: UserRef | null;    // createdBy null for qr (the employee)
  correctionId: string | null;                                               // Phase B
  status: 'live' | 'void';
  void: { at: string; by: UserRef | null; reason: string; correctionId: string | null } | null;
  _actions: ('void')[];                                                      // always [] on /me routes
}
type Counts = Record<Exclude<DayStatus, 'not_employed'>, number> & { total: number };
interface PresenceBoardView { date: string; final: boolean; asOf: string; counts: Counts;
  items: AttendanceDayView[]; total: number; page: number; pageSize: number }
interface TeamPresenceView extends PresenceBoardView { units: UnitRef[] }
interface MyDaysView { from: string; to: string; employee: EmployeeRef;     // as of `to`
  items: AttendanceDayView[];                                                // with punches, oldest first
  totals: { workedMinutes: number; scheduledMinutes: number; lateDays: number; lateMinutes: number; absentDays: number;
            incompleteDays: number; leaveDays: number; earlyDepartureDays: number };
  retentionMonths: number }                                                  // the company policy (for the notice)
interface EmployeeDaysView extends MyDaysView { canManage: boolean }        // attendance.manage over the employee, not self
interface ScheduleSegmentsView { items: { from: string; to: string; schedule: { id: string; code: string; labels: Labels };
  source: 'employment' | 'unit' | 'site' | 'company';
  sourceRef: { kind: 'employment' | 'unit' | 'site'; id: string; code: string; name: string } | null;
  overrides: { id: string; labels: Labels; from: string; to: string }[] }[] }   // consecutive dates merged
interface PolicyView { retentionMonths: number; minPunchGapSeconds: number }   // Phase B adds two fields
interface ScheduleView { id: string; code: string; labels: Labels; active: boolean;
  versions: { id: string; validFrom: string; validTo: string | null; week: WeekDay[]; toleranceMinutes: number }[]; // newest first
  current: { validFrom: string; week: WeekDay[]; toleranceMinutes: number; weeklyMinutes: number } | null;
  assignmentCount: number }                                                  // current and future
interface OverrideView { id: string; schedule: { id: string; code: string; labels: Labels } | null; labels: Labels;
  from: string; to: string; week: WeekDay[]; toleranceMinutes: number; approximate: boolean }
interface AssignmentView { id: string; schedule: { id: string; code: string; labels: Labels };
  target: { kind: 'company' | 'site' | 'unit' | 'employment'; id: string | null; code: string | null; name: string | null };
  validFrom: string; validTo: string | null; _actions: ('end' | 'delete')[] }
interface KioskView { id: string; kind: 'qr_kiosk'; labels: { fr: string; ar: string }; site: SiteRef;
  status: 'pending' | 'active' | 'revoked'; allowedNetworks: string[]; pairedAt: string | null;
  pairing: { expiresAt: string } | null; lastSeen: { at: string; ip: string; userAgent: string } | null;
  createdAt: string; createdBy: UserRef | null; revoked: { at: string; by: UserRef | null; reason: string } | null;
  _actions: ('update' | 'pair' | 'revoke')[] }
interface PairingCodeView { code: string; expiresAt: string }               // "K7M2-9QXA"
interface KioskSessionView { kiosk: { id: string; labels: { fr: string; ar: string }; site: { code: string; name: string } };
  company: { name: string }; serverTime: string; windowSeconds: 30 }
interface KioskQrView { serverTime: string; windowSeconds: 30;
  windows: { window: number; qr: string; showFrom: string; showUntil: string }[] }   // 4 entries, qr = the URL
interface ScanView { kiosk: { labels: { fr: string; ar: string }; site: { code: string; name: string } };
  scannedAt: string; localTime: string; receiptExpiresAt: string }
interface PunchResultView { punch: PunchView; duplicate: boolean; day: AttendanceDayView }
```

### Module boundaries

- **Leave** exports (from `modules/leave/index.ts`) a read-only `LeaveFacts.attendanceInputs(companyId,
  employmentIds | null, from, to)` → `{holidays: {date, labels, approximate}[], requests: {id, employmentId, status:
  'approved' | 'pending', typeCode, labels, startDate, endDate, halfDayStart, halfDayEnd}[]}`.
- **Staffing** exports `StaffingService.unitsHeadedBy(employmentId, date)` → unit ids (and uses the existing
  `linkedEmploymentOf`, `managerOf`); `GET /me/employment` gains `headOf: UnitRef[]` (units the caller heads today,
  `[]` when none) — the web's "Mon équipe" nav entry reads it.
- **Organization/Employment**: effective site (`effectiveSite`), closure, assignments as today; nothing new.
- **Platform security**: `@XsrfUnbound()` (above) and the cookie names `hrf_kiosk`, `hrf_scan`, `hrf_dev` in
  `cookies.ts`; pino redaction paths gain `req.body.code` for `/api/kiosk/pair` (a pairing code is a credential).

### Audit and timeline

- Row triggers on every Phase A table except `attendance_device_heartbeat` (exempt). Masked: `attendance_device.
  credential_hash`, `attendance_device.pairing_code_hash`, `attendance_punch.device_ref`.
- Application events: `attendance.device_paired` `{deviceId, ip, userAgent, replacedCredential: boolean}` (actor null,
  subject `attendance_device`), `attendance.purged` `{punches, before}` (worker, subject null, only when > 0).
- Timeline subjects: new `attendance_device:<id>` (its rows and events; visible with `attendance.configure` anywhere,
  else 404). The `employee:<id>` timeline (existing rule, `audit.read`) adds the employee's `attendance_punch` rows
  **except QR inserts** (volume: two a day; they are visible in the Attendance tab) — i.e. manual inserts and every
  void. Labels: `audit.fields.attendance_punch.*`, `audit.fields.attendance_device.*`, `audit.events.attendance.*`.

### Retention and worker

- Cron **`attendance.retention`** at `30 2 1 * *` (UTC, like the others; backfill 7 days; idempotent), company by
  company as `hrforce_worker`; `payload.today` overrides the Algiers date. Deletes punches with `work_date <
  (first day of today's month − retention_months)`, then writes `attendance.purged` when the count > 0.
- **The purge must not copy what it erases into the audit log.** `audit.capture()` is changed (migration 0016) to
  skip a `DELETE` row when all three hold: `session_user = 'hrforce_worker'`, `current_setting('audit.retention_purge',
  true) = 'on'` (the job sets it `local`), and the table is listed in a new `audit.retention_purgeable(table_name)`
  (seeded: `attendance_punch`; Phase B adds its two tables). The `attendance.purged` event records the count instead.
  Tested: the app role setting the flag still produces delete rows (it has no DELETE anyway), the worker without the
  flag produces them, a non-listed table produces them.
- Worker privileges: `DELETE` on `attendance_punch`; `SELECT` via the 0012 defaults; `EXECUTE` on
  `audit.record_event`.
- No day-end job: the daily status is computed on read.

### Notifications

None in Phase A.

### Deploy and platform

- Env: `ATTENDANCE_KEY` (above). `deploy/init-env.sh` generates it; existing staging installs add it to
  `deploy/.env` before the deploy that ships Phase A (ops note for HANDOFF).
- **CSP and Permissions-Policy: no change.** The kiosk draws the QR on a `<canvas>` (no `img-src`/`blob:` need), uses
  Screen Wake Lock and Fullscreen (not restricted by the current Permissions-Policy, default `self`), and fetches only
  same-origin. The phone uses no camera or geolocation API (`camera=()` and `geolocation=()` stay). The QR encoder is
  the npm package **`qrcode-generator@2.0.4`** (MIT, plain JS, no `eval`/`new Function`, no WebAssembly — checked),
  bundled by the Angular build.
- `deploy/web/Caddyfile`: serve `/manifest.webmanifest` with `Content-Type: application/manifest+json` and
  `Cache-Control: no-cache` (Go's MIME table lacks `.webmanifest`). The edge Caddyfile is unchanged (`manifest-src
  'self'` is already in the CSP).

### Web (Phase A)

Every screen: fr/ar/en keys under `attendance.*` (fr/ar parity), RTL, usable at 390 px. Times are shown from the API's
`localTime` (Algiers), never re-derived from the device's time zone. Minutes are formatted `1 h 05` / `1 س 05 د`.

- **PWA**: `public/manifest.webmanifest` — `name` "HRForce", `short_name` "HRForce", `start_url` "/", `scope` "/",
  `display` "standalone", `background_color`/`theme_color` from the app palette, icons 192 and 512 px PNG (plus a
  `maskable` 512) in `public/icons/`; `index.html` links it and adds `<meta name="theme-color">` and
  `<link rel="apple-touch-icon">`. **No service worker**: nothing authenticated is cached on shared or lost phones, no
  stale-release problem, and current Chrome on Android installs from the manifest alone (the verifier confirms on a
  real phone; if a target browser still refuses, a service worker **without a fetch handler** is the only allowed
  addition).
- **Kiosk** `/kiosk` (no guard, no header/nav/skip link — route `data: { chrome: false }` read by the root component;
  the startup session check must not redirect this URL, and the refresh interceptor never handles `/api/kiosk/*`
  401s). States:
  - *unpaired*: a large code input (`XXXX-XXXX`, `autocapitalize`, monospace), "Appairer"; 410 → « Code invalide ou
    expiré ». Before pairing, `GET /api/kiosk/session` tells whether the tablet is already paired.
  - *running*: the entrance label in **both languages** (French block `dir="ltr"`, Arabic block `dir="rtl"`,
    independent of the UI language), the company name, a large clock `HH:MM:SS` (server-corrected), the QR on a canvas
    (black on white whatever the theme, quiet zone 4 modules, side ≈ 60 % of the shorter screen side), the instruction
    in both languages, a thin countdown of the current window.
  - *offline*: no QR (a stale code would fail), the offline message in both languages, retry every 5 s.
  - *revoked/unpaired* (401): back to the pairing screen with « Borne désactivée — contactez les RH ».
  Behaviour: fetch `/api/kiosk/qr` once per window (at `showFrom` + 1–3 s random jitter) and immediately on
  `visibilitychange` → visible and on `online`; `offset = serverTime − (t_send + t_receive)/2`; show the window whose
  `[showFrom, showUntil)` contains `Date.now() + offset`; *offline* when none does. Screen Wake Lock requested after
  the first tap ("Plein écran" button that also enters fullscreen) and re-requested on visibility; `GET
  /api/kiosk/session` once a day and a full reload between 03:00 and 03:05 (picks up new releases). Must run on a cheap
  Android tablet (Chrome ≥ 100, 2 GB RAM) for days.
- **Punch landing** `/punch` (no guard; keeps the header): on init read `location.hash` (the token), then
  `history.replaceState` to drop it; if there was a token → `POST /api/attendance/scan` (410/422 → a full-page message
  with "scan again" in the UI language); then, if the session signal is null → navigate to
  `/login?returnUrl=/punch` (the login page shows « Connectez-vous pour enregistrer votre pointage » when `returnUrl` is
  `/punch`); else `POST /api/me/attendance/punches`. Without a token (back from login) → `POST
  /api/me/attendance/punches` directly (409 `attendance-no-scan` → "scan again"). Success → a full-screen confirmation:
  big direction word and time, entrance label, green (arrival) / blue (departure) with an icon (never colour alone),
  « Déjà enregistré » when `duplicate`, and "Voir mon pointage" → `/me/attendance`. 403 (no `attendance.punch_self`)
  and 409 `attendance-not-linked` → an explanation to contact HR.
- **Pointage** `/me/attendance` (`attendance.punch_self`; nav "Pointage" when also linked, like My leave): *Aujourd'hui*
  card (status, arrival, departure, worked so far, schedule of the day), "Comment pointer ?" (point the phone camera
  at the code at the entrance; iPhone: use Safari), *Mon mois* (month navigator; one row per day: date, status chip,
  arrival–departure, late minutes, flags as small chips; tapping a row shows its punches), and the **information
  notice** (below). Refreshes on `visibilitychange`.
  Notice — fr: « Le pointage enregistre l'heure, l'entrée utilisée et un identifiant aléatoire de ce navigateur. Aucune
  localisation, photo ni donnée biométrique n'est collectée. Les pointages sont conservés {years} ans. » — ar: « يسجل
  نظام الحضور الوقت والمدخل المستعمل ومعرّفا عشوائيا لهذا المتصفح. لا يتم جمع أي موقع جغرافي أو صورة أو بيانات
  بيومترية. تحفظ التسجيلات لمدة {years} سنوات. » — `{years}` = `MyDaysView.retentionMonths / 12` (employees cannot
  read `GET /attendance/policy`); months shown instead when not a whole number of years.
- **Presence board** `/attendance` (`attendance.read`, nav "Présence"): date picker (default today, ‹ › day
  buttons), unit picker + sub-units, site, status chips with the counts (click = filter), search — **all in the URL
  query** (as `/employees`); desktop table (employee, unit, schedule, arrival, departure, late, worked, status,
  flags), phone cards; rows link to the employee's Attendance tab at that date. Today refreshes every 60 s while
  visible. Flags have tooltips/labels (`shared_device` only appears for managers, as the API decides).
- **Mon équipe** `/me/team` (signed in; nav entry only when `GET /me/employment` returns `headOf` non-empty — new field
  `headOf: UnitRef[]`, today's headed units, added by Staffing): the board's layout on `/me/team/presence`, without
  unit/site pickers.
- **Employee detail → Présence tab** (`attendance.read`): month navigator; day list with punches (source icon: QR /
  manual; void struck through with its reason), the day's schedule and its source ("Horaire agence — via le site
  CNE"), totals; "Ajouter un pointage" (shown when `EmployeeDaysView.canManage`) opening a dialog: direction, date,
  time, site, reason (required); "Annuler" on a punch
  (`_actions`) with a required reason. Problem slugs map to fields/banners.
- **Settings** `/attendance/settings` (`attendance.configure`; child route of `/attendance`, which asks for ANY of
  `attendance.read`, `attendance.configure`), tabs:
  - *Horaires*: schedules list; editor with a 7-row week grid (Sunday first in the display, ISO numbers underneath;
    rest toggle, start, end, break), tolerance, "Nouvelle version à partir du …"; version history; overrides list per
    year with create/edit/delete (company-wide or one schedule; `approximate` badge as for holidays).
  - *Affectations*: current assignments by kind (default of the company, sites, units, employees) with pickers (reuse
    the unit and employee pickers), "à partir du", end, delete future ones; a notice that the company default is
    changed by adding a new default from a date.
  - *Bornes*: kiosks table (label, site, status, last seen "il y a 2 min", networks); "Nouvelle borne" → dialog → on
    success a large **pairing code** panel with its expiry countdown and the instructions (« Sur la tablette, ouvrez
    https://…/kiosk et saisissez ce code ») — the code is never shown again; "Nouveau code", edit networks, revoke
    (reason). History (timeline `attendance_device:<id>`) with `audit.read`.
  - *Politique*: retention (months), punch gap (seconds).
- **Angular guide**: new chapter(s) for the concepts this slice introduces — timers aligned to a server clock with
  `DestroyRef`-driven cleanup, `visibilitychange`/`online` events, the Wake Lock and Fullscreen APIs behind a small
  service, drawing on `<canvas>` from a component (`viewChild` + `afterRenderEffect`/`effect`), a route without the app
  chrome (route `data` read through the router), reading and clearing a URL fragment, and the web app manifest.

### Seed (`seed:dev`, DEMO; TEST DATA)

- Policy defaults. Schedules: `standard` (company default, assumption 1); `agence` (« Agence — accueil du public » /
  « الوكالة — استقبال الجمهور »: Sun–Thu 07:30–16:00, break 12:00–12:30, tolerance 10) assigned to unit `AG-ANNABA`
  and to site `CNE` from 2026-01-01; the company-wide override `ramadan_1448` (assumption 3, `approximate`).
- Kiosks: « Siège — Entrée principale » (`ALG-HQ`, `pending`, dev pairing code **`DEMK-2026`** valid 30 days from the
  seed run, printed by the seed — the one a developer pairs in a browser tab at `/kiosk`), « Agence Annaba — Entrée »
  (`ANNABA`) and « Constantine — Entrée » (`CNE`), both `active` with an unusable random credential (they carry the
  seeded punches; "Nouveau code" in the settings re-pairs them), « Oran — Entrée » (`ORAN`, `revoked` at the seed run,
  reason « Tablette remplacée »).
- Punches for the working days of the last 15 days up to today (relative to the seed run, fixed ids per (employee,
  date, n), re-running adds nothing): employees of `REG-EST` (Annaba ones at the Annaba kiosk, the others at the CNE
  kiosk) and of `REG-OUEST` (for the `lecture` user's board; at the Oran kiosk, all before its revocation). Deterministic mix: ~80 % on time, ~10 % late
  (12–45 min), ~5 % absent, ~3 % incomplete, ~2 % early departure; approved leave days get no punches; today only
  punches earlier than the seed time. Plus: `agent.annaba` (EMP-0030) arrived today at 07:52; a manual punch by
  `rh.est` for EMP-0031 (« Téléphone en panne »); one voided punch (« Pointage en double »); two Est employees sharing
  one `device_ref` on one day (`shared_device`); one `other_site` punch.
- BETA (test fixture): policy, default schedule, one active kiosk whose credential is known to the tests, one punch.
  The e2e fixture option `attendance: true` seeds DEMO's schedules, kiosks and one punch per matrix target plus the
  tokens/receipts helpers (`kioskCookie(deviceId)`, `qrToken(deviceId, window)`, `scanReceipt(…)`).

### Authorization matrix rows (expected, Phase A)

Actors and targets as in `authorization-matrix.e2e-spec.ts` (`est` = EMP-0027 / its punch, `ouest` = EMP-0036 / its
punch, `other` = BETA's). `✓` = the route's success status.

| Route | Rows |
|---|---|
| `POST /kiosk/pair` | anon with an unknown code 410; anon with a fixture code 200 (one row per fixture code) |
| `GET /kiosk/session`, `GET /kiosk/qr` | anon without cookie 401; anon with the fixture kiosk cookie 200; with a revoked kiosk's cookie 401 |
| `POST /attendance/scan` | anon with a fixture token 200; anon with a malformed token 422 |
| `POST /me/attendance/punches` (fixture receipt cookie per row) | agent 201, est 201 (linked, holds `employe`), chef 201; admin 409, beta 409 (`attendance-not-linked`); ouest 403, acces 403 |
| `GET /me/attendance/days` | agent 200, est 200, chef 200; admin 409, beta 409; ouest 403, acces 403 |
| `GET /me/team/presence` | chef 200 (only AG-ANNABA employees — asserted), est 200 (REG-EST — asserted), agent 200 (`units: []`), admin 200 (empty), ouest 200, acces 200, beta 200 (empty) |
| `GET /attendance/presence` | admin 200, est 200 (only Est rows — asserted), ouest 200 (only Ouest rows — asserted), acces 403, beta 200, agent 403, chef 403 |
| `GET /employees/:id/attendance/days`, `GET /employees/:id/attendance/schedule` | ATT_READ: admin est/ouest 200, other 404; est est 200, est ouest 404; ouest ouest 200, ouest est 404; acces est 403; beta est 404, beta other 200; agent est 403 |
| `POST /employees/:id/attendance/punches` | ATT_MANAGE(201): admin est/ouest ✓, other 404; est est ✓, est ouest 404; ouest ouest 403 (read, no manage → guard), acces 403; beta est 404, beta other ✓; agent 403 |
| `POST /attendance/punches/:id/void` | ATT_MANAGE(200), each ✓ row on its own fixture punch |
| `GET /attendance/policy`, `GET /attendance/schedules`, `GET /attendance/schedule-overrides`, `GET /attendance/schedule-assignments` | admin 200, est 200, ouest 200, acces 403, beta 200, agent 403 |
| `GET /attendance/kiosks` | admin 200, est 403, ouest 403, acces 403, beta 200, agent 403 |
| `PUT /attendance/policy`, `POST /attendance/schedules`, `PATCH /attendance/schedules/:id`, `POST /attendance/schedules/:id/versions`, `POST/PUT/DELETE /attendance/schedule-overrides…`, `POST /attendance/schedule-assignments`, `POST …/:id/end`, `DELETE …/:id`, `POST /attendance/kiosks`, `PATCH /attendance/kiosks/:id`, `POST …/pairing-code`, `POST …/revoke` | CONFIG_ROWS on the caller's own company (admin and beta ✓; est, ouest, acces 403); plus beta on company A's id → 404 for the `:id` routes |
| anonymous | 401 on every non-public route above |

Plus e2e (not matrix): the full phone flow (scan → punch 201 → second scan within 2 min → 200 `duplicate` → scan after
the gap → `out`); a token of window w−2 → 410; a token of window w+1 → 410; a forged MAC → 422; a revoked kiosk's token
→ 422; the same token by two employees → both 201; the same employee twice on one window → one punch; a receipt older
than 2 min (5 in Phase A) → 409; `hrf_scan` of company A redeemed by a BETA user → 409 `attendance-no-scan`; `allowed_networks`
refusing another address → 403; a pairing code used twice → 410; re-pairing kills the old credential; manual punch on
one's own employment → 409; the punch immutability trigger (UPDATE of `occurred_at` refused, a second void refused, DELETE
refused for the app role); the retention job (worker role, pinned `today`) deletes old punches without audit delete
rows and writes `attendance.purged`; `assertNoSecrets` on every response.

### Settled by the build (Phase A API)

**Audit of punches (owner decision 2026-09-29) — the mechanism.** `attendance_punch` has the standard trigger name
`audit_capture_tg` (AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW — so `guard:db` audit-per-write covers it without an
exemption), but it executes **`audit.capture_punch_event()`** (SECURITY DEFINER, migration 0016) instead of
`audit.capture()`: it writes **no `audit.change_log` row** and one `audit.event` per write, subject
`attendance_punch:<id>`, company from the row, request id from the session:
- insert → `attendance.punch_recorded {source, direction}`, actor = `app.user_id`, **except a QR punch: actor null**
  (the actor would be the employee and the event instant the punch time — the attendance record itself);
- update (the guard allows only live → void) → `attendance.punch_voided {source}`, actor = the HR user;
- delete → `attendance.punch_deleted {source}`, **none when the session user is `hrforce_worker`** (its only DELETE is
  the retention purge, which writes one `attendance.purged {punches, before}` per company run).
No employment id, instant, device, device ref or reason ever reaches the audit log, so after the purge only opaque punch
ids remain (tested). `audit.capture()` and `audit.masked_column` are unchanged for punches (the contract's
`audit.retention_purgeable` / `audit.retention_purge` flag is **not** built). The employee timeline lists the punch
events of the employee's existing punches except QR inserts (joined through `attendance_punch`, so they disappear with
the purge). `attendance_device` rows are audited normally (credential and pairing-code hashes masked).

**Other settled behaviour**
- `attendance_punch.created_by` and `attendance_device.created_by` are nullable (seeded rows); `revoked_by` /
  `voided_by` are required.
- Lateness / early departure compare the punch's Algiers time **truncated to the minute** with the schedule (08:10:59
  is on time with a 10-minute tolerance); worked minutes are summed at millisecond precision and floored.
- A day with no schedule rule (e.g. a schedule created with `validFrom` today, assigned to past dates) counts as a rest
  day. `leaveDays` in totals counts `on_leave` days (half days are not counted).
- Duplicate rule: the lookup runs under `pg_advisory_xact_lock(company, employment)`; parallel redemptions of one
  receipt give one 201 and 200 `duplicate` for the rest (tested with 6 parallel calls); the unique index is the backstop.
- A receipt dated more than 5 s in the future (clock skew between API processes) is refused like an expired one
  (`attendance-no-scan`). The punch check order is 409 `attendance-not-linked` → 409 `attendance-no-scan` (missing,
  bad MAC, other company, > 2 min — 5 min before Phase B) → 422 `attendance-qr-invalid` (kiosk no longer active) → 409
  `attendance-not-employed`.
- `@XsrfUnbound()` routes must be `@Public()` (the guard answers 403 otherwise). Platform change: an anonymous caller
  of a non-public route whose XSRF header equals the cookie is passed to the PermissionGuard (401) instead of failing
  the signature check (403); missing / mismatched header and cookie still give 403.
- Pairing: the definer lookup runs in its own transaction, then the device row is locked and the code re-checked
  (two tablets with one code: one 200, one 410). Code expiry is checked against the database clock. The heartbeat is
  also written by `POST /kiosk/pair`. The kiosk cookie is cleared (`Max-Age=0`) on every `kiosk-unpaired`, kept on
  `kiosk-network-refused`. `GET /kiosk/session` and `GET /kiosk/qr` both send `Cache-Control: no-store`.
- Allowed networks: IPv4 / IPv6 CIDR or a bare address (= /32 or /128), host bits must be zero (else 422
  `allowedNetworks.<i>` `invalid`), duplicates collapsed, returned in canonical form (`2001:db8::/32`); > 10 →
  `allowedNetworks` (zod `too_big`). The client address follows `TRUST_PROXY_HOPS`; an IPv4-mapped IPv6 address is
  compared as IPv4.
- Manual punch: 422 checks after the scope (404/403) and the self-management check (409); `siteId` omitted = the
  employee's effective site that day (may be null); 409 `attendance-punch-exists` also carries `errors[{field:'time',
  code:'exists'}]`.
- Assignments: `DELETE` of a future assignment gives its end back to the assignment of the same target that ended on its
  start (so the company default stays contiguous and open). `POST …/end` refuses `validTo` before the start (422
  `validTo` `invalid`). A company target with an id → 422 `target.id` `invalid`; other kinds without one → `required`.
  `AssignmentView.validTo` is the last day (inclusive).
- Schedules: `POST /attendance/schedules` without `validFrom` starts its version today. Version date conflicts carry
  `errors[{field:'validFrom', code:'too_early'}]`; override overlaps `errors[{field:'from', code:'overlap'}]`; override
  `from > to` → 422 `to` `invalid`.
- Board: rows are sorted in memory (collation fr / ar per `lang`); `arrival` sort puts days without arrival last.
  `shared_device` on the board/team uses attendance.manage over the employee's unit today, never on one's own row.
- Seed (`seed:dev`): punch ids `0190a5d0-0000-7000-9a75-…` per (employee, date, n); kiosks `…-9a72-…0001..0004`;
  schedule `agence` `…-9a71-…0001`; Ramadan override `…-9a73-…0001`. The dev code `DEMK-2026` is refreshed on every
  seed while the Siège kiosk is still pending.
- e2e fixture: `seedAccessFixture(db, today, { attendance: true })`; helpers in `apps/api/test/support/
  attendance-fixture.ts` (`kioskCookie`, `qrToken`, `scanReceipt`, known credentials on the Annaba and Constantine
  kiosks, BETA kiosk and punch).

### Settled by the verification (Phase A, 2026-09-30)

Full gate green from clean (PG18). Browser checks in fr/ar at 1280 × 800, 800 × 1280 and 390 px, security probes against
the dev API and through `deploy/Caddyfile` + `deploy/web/Caddyfile` in Docker.

**XSRF change (anonymous caller → 401).** Probed: anonymous + no/mismatched header → 403 `xsrf` (unchanged); anonymous +
any matching header/cookie on a non-public route → 401 (nothing runs: the PermissionGuard refuses before the
transaction); public routes (`/auth/*`, `/kiosk/pair`) still verify the signature (403 for an unsigned value); a
signed-in caller with an arbitrary matching value or an `anon`-bound token → 403; a garbage access cookie counts as
anonymous → 401. A cross-site page cannot send the custom header (no CORS on the API), so the change gives an attacker
nothing: the only new outcome is 401 instead of 403 for a caller who has no session to abuse.

**Scan and receipt — residual risks (for the owner, not defects).**
- *Link-punch.* Any page (or message) can navigate a signed-in employee's browser to `/punch#<live token>`; the SPA then
  scans and punches with the employee's own same-site cookies. `SameSite=Strict` does not help (the calls come from our
  own page), and nothing can tell this apart from the camera opening the link. It needs a live token (someone at the
  entrance, or a kiosk credential) and the victim to open it within 30–60 s; the success card shows what happened. Same
  class as the relayed photo (ADR 009 §5).
- *The receipt is a bearer value.* `hrf_scan` is not bound to a browser or a user: anyone who calls the public scan
  with a live token (a script is enough, no sign-in) gets a valid receipt, and any employee of the company who puts that
  cookie in their browser (developer tools on a computer) redeems it within 5 minutes. A technically able pair can thus
  stretch the 60 s relay window to about 5.5 minutes. The punch still records the kiosk and the duplicate rule applies
  per employee. Binding the receipt to `hrf_dev` would not help (both are copyable).
- Cross-site CSRF of the scan itself is impossible (header required); scanning only sets cookies for the caller's own
  browser. Cookies seen: `hrf_scan` and `hrf_dev` `Path=/api/me/attendance`, `hrf_kiosk` `Path=/api/kiosk`, all
  `HttpOnly; SameSite=Strict` (`Secure` with `COOKIE_SECURE=true`, as in `compose.staging.yml`).

**Other checked behaviour.** Tokens: future window 410, flipped window/device/MAC/version bytes 422, a token 52 s old
410; 20 parallel redeems of one receipt → one 201 + 19 × 200 `duplicate` (one punch). A kiosk cookie gives 401 on every
non-kiosk route; a flipped byte → 401 `kiosk-unpaired` with the cookie cleared. Pairing: no throttle (200 wrong codes
in ~0.3 s from one client ≈ 4 × 10⁵ guesses in 10 min against 2⁴⁰ codes); single use (410 on reuse). Allowed networks:
through Caddy a client `X-Forwarded-For` / `Forwarded` / `X-Real-IP` is replaced, so spoofing is refused (403); the API
itself trusts one hop (`TRUST_PROXY_HOPS=1`), so it must never be published without the proxy (it is not). Scope:
regional HR manual punch out of region 404, on self 409, `lecture` 403, void twice 409, unit head without grant 403 on
per-employee routes, `/me/team` limited to headed units. Audit: QR punches → `attendance.punch_recorded {source,
direction}` with actor null; manual/void events carry the HR actor; no `change_log` rows for punches; kiosk hashes
masked; after the purge (`payload.today` pinned) only opaque ids, one `attendance.purged {punches, before}`.
Punch time: a scan at 07:21:31Z with sign-in 40 s later was recorded at 07:21:31 (`received_at` 07:22:11).
Kiosk: offline state ~105 s after the network loss (end of the prefetched windows), QR back at once on `online`;
revocation → back to pairing with « Borne désactivée » within ~3 s, credential cookie cleared. Manifest: served as
`application/manifest+json` through Caddy, Chrome reports no installability errors (no service worker); CSP unchanged,
no violation on `/kiosk` or `/punch`. A real-phone install check is still to do on staging.

**Fixed by the verification (web).**
- `/punch` listens to `route.fragment` instead of reading the snapshot once: a second code opened while the page is
  still on `/punch` (same-document navigation, e.g. the departure scan in the installed app) did nothing and kept
  showing the earlier card.
- Timeline: punch events read naturally — `audit.events.attendance.punch_recorded.<source>_<direction>` and
  `punch_voided.<source>` / `punch_deleted.<source>` (fr/ar/en), instead of « Événement attendance.punch_recorded ».
- Kiosk history names the site (was a raw id); list values in a timeline (allowed networks) show as `a, b` or
  « (vide) », not JSON.

---

## Phase B — corrections through the workflow engine, monthly report

### Data (migration 0017)

| Table | Columns | Rules |
|---|---|---|
| `attendance_correction` | `id`, `company_id`, `employment_id`, `org_unit_id` (the employee's unit when requested: HR step scope), `work_date`, `reason` (3–500), `status` (`pending`/`approved`/`rejected`/`cancelled`), `requested_by`, `requested_at`, `workflow_instance_id` | one `pending` per (`employment_id`,`work_date`) (partial unique index); no DELETE for the app; DELETE for the worker (retention) |
| `attendance_correction_item` | `id`, `company_id`, `correction_id`, `position int` (0–3), `action` (`add`/`void`), `direction` null, `occurred_at` null, `punch_id` null (FK punch), `result_punch_id` null (FK punch, set on approval for `add`) | `add` ⇔ (`direction`, `occurred_at` not null, `punch_id` null); `void` ⇔ `punch_id` not null; unique (`correction_id`,`position`); immutable except `result_punch_id` set once; worker DELETE |

Also: `attendance_punch.source` check gains `correction`; new columns `correction_id` null (FK) and
`void_correction_id` null (FK); `source='correction'` ⇔ `correction_id` not null. The retention purge deletes, per
company and in this order, items, corrections and punches older than the retention (a correction's own `work_date`);
`audit.retention_purgeable` gains both tables; `hrforce_worker` gets DELETE on both. `attendance_policy` gains
`correction_max_age_days int` (30; 1–90) and `correction_workflow_code text` (`attendance.manager_then_hr` |
`attendance.hr_only`). `workflow_instance_subject_type_ck` and `notification_subject_type_ck` gain
`attendance_correction`. Workflow definitions seeded per company: `attendance.manager_then_hr` = `[{key: 'manager',
kind: 'manager'}, {key: 'hr', kind: 'permission', permission: 'attendance.manage'}]` and `attendance.hr_only` = the
`hr` step alone (labels « Responsable » / « المسؤول المباشر » / "Manager", « RH » / « الموارد البشرية » / "HR").

### Rules

- **Request** (`POST /me/attendance/corrections`): `{date, reason, changes: ({action: 'add', direction, time} |
  {action: 'void', punchId})[]}`. Checks in order: `attendance-not-linked` (409); `date` ≤ today and ≥ today −
  `correction_max_age_days` and inside the employment (409 `attendance-correction-date`); 1–4 changes (422 `changes`
  `min_items`/`max_items`); an `add` time on `date` not in the future (422 `changes.<i>.time` `future`); a `void`
  target = a live punch of the caller's employment on `date` (422 `changes.<i>.punchId` `not_found`), no target twice
  (`duplicate`); 409 `attendance-correction-pending`. Starts the workflow with the policy's definition; the task
  scope unit = the employee's unit.
- **Manager step**: the same resolution and escalation as leave (`StaffingService.managerOf`, reasons `no-manager`,
  `manager-not-linked`, `manager-is-requester`). Separation of duties as the engine enforces
  (`workflow-self-approval`).
- **Approved** (`onApproved`, in the approval transaction): for each item in `position` order — `add` inserts a punch
  `source='correction'`, `correction_id`, the requested direction and instant, `created_by` = the final approver, and
  sets `result_punch_id`; `void` voids the target (`voided_by` = approver, `void_reason` = the correction's reason,
  `void_correction_id`). A target already void → 409 `attendance-correction-stale` and the approval rolls back (the
  approver rejects instead). Punches are **never edited in place**.
- `onRejected` / `onCancelled` set the status. Cancel: the requester, `pending` only (409
  `attendance-correction-not-cancellable`).
- The requester cannot see `shared_device`; the approvers see the day as computed today plus the requested changes.

### Endpoints

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /me/attendance/corrections` | `attendance.punch_self` | above → **201** `CorrectionView` |
| `GET /me/attendance/corrections?status=` | `attendance.punch_self` | → `{items: CorrectionView[]}` newest first |
| `POST /me/attendance/corrections/:id/cancel` | `attendance.punch_self` | → 200 `CorrectionView`; another person's → 404 |
| `GET /attendance/corrections?status=&unitId=&includeSubUnits=&from=&to=&q=&page=&pageSize=` | `attendance.read` | scoped by the employee (employment rule), `from`/`to` on `work_date` → `{items, total, page, pageSize}` |
| `GET /attendance/corrections/:id` | `@Authenticated` | the employee's linked user, a current candidate, or `attendance.read` over the employee; else 404 → `CorrectionView` + `history[]` (as leave detail) + `day: AttendanceDayView` |
| `GET /attendance/reports/monthly?month=&unitId=&includeSubUnits=&siteId=&q=&page=&pageSize=` | `attendance.read` | `month` `YYYY-MM` ≤ current (422) → `MonthlyReportView` |
| `GET /attendance/reports/monthly.csv?month=&unitId=&includeSubUnits=&siteId=&lang=fr\|ar` | `attendance.read` | `text/csv; charset=utf-8`, UTF-8 BOM, `;` separator, CRLF, header row in `lang`, `Content-Disposition: attachment; filename="presence-<month>.csv"`, all rows (no paging, ≤ 5 000, else 422); audit event `attendance.report_exported {month, unitId, rows}` |
| `PUT /attendance/policy` | `attendance.configure` (company) | also accepts `correctionMaxAgeDays`, `correctionWorkflowCode` (applies to new requests) |

Approval and rejection go through the existing `POST /tasks/:id/approve|reject`.

```ts
interface CorrectionView { id: string; date: string; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; requestedAt: string; requestedBy: UserRef | null;
  employee: EmployeeRef;
  changes: { position: number; action: 'add' | 'void'; direction: 'in' | 'out' | null; time: string | null;   // "HH:MM"
             punch: { id: string; direction: 'in' | 'out'; localTime: string } | null;                       // void target
             resultPunchId: string | null }[];
  workflow: WorkflowProgressView;            // as leave list items
  rejectionComment: string | null; _actions: ('cancel')[] }
interface MonthlyReportView { month: string; days: number; items: {
  employee: EmployeeRef;                     // as of min(month end, employment end, today)
  counts: { present: number; late: number; absent: number; incomplete: number; onLeave: number; holiday: number; restDay: number };
  lateMinutes: number; earlyDepartureMinutes: number; workedMinutes: number; scheduledMinutes: number;
  absentDates: string[]; incompleteDates: string[] }[]; total: number; page: number; pageSize: number }
```
Report rule: employees with an employment active on at least one day of the month, in scope by their assignment unit
on `min(month end, employment end, today)`; days after today are not counted. CSV columns: matricule, nom, prénom,
unité, présents, retards, minutes de retard, absences, incomplets, congés, fériés, heures travaillées (`h:mm`), heures
prévues, dates d'absence (`,`-separated) — Arabic headers in `lang=ar`.

### Notifications

| Type | When | Recipients | Email default | Link |
|---|---|---|---|---|
| `task.assigned` (existing) | a correction task opens | its candidates minus the requester | on | `/tasks?task=<id>` |
| `attendance.correction_approved` | final approval | the employee's linked user | **off** | `/me/attendance?correction=<id>` |
| `attendance.correction_rejected` | rejection | the employee's linked user | on | `/me/attendance?correction=<id>` |

`data`: `{correctionId, employeeName, employeeNameAr, date, changes (count), actorName}`; `task.assigned` data gains
`subjectType: 'attendance_correction'` and `date`. Wording — fr: « Correction de pointage à traiter : <Nom> (<date>) »,
« Votre correction de pointage du <date> a été acceptée / refusée »; ar: « طلب تصحيح تسجيل الحضور للمعالجة: <الاسم>
(<التاريخ>) », « تم قبول / رفض طلب تصحيح تسجيل الحضور ليوم <التاريخ> ». Mails never include the reason or times.

### Audit and timeline (Phase B)

Row triggers on both tables. Timeline subject `attendance_correction:<id>` (its rows, items, workflow tasks and
`workflow.*` events), visible like `GET /attendance/corrections/:id`; the `employee:<id>` timeline adds correction
rows and correction punches. Task summaries (`WorkflowSubject.summaries`) return `{type: 'attendance_correction',
employee, date, reason, changes, day: {status, arrival, departure}}`, and `{type: 'attendance_correction', purged:
true}` when the subject was deleted by the retention job.

### Web (Phase B)

- **Pointage**: "Demander une correction" on a day row (days within the window) → dialog: that day's live punches
  with a "retirer" toggle, "ajouter" rows (direction, time), reason; my corrections with the workflow stepper
  (`shared/workflow-stepper`), cancel; `?correction=` highlights one (notification link).
- **My tasks**: `attendance_correction` tasks show the employee, date, the day as computed (arrival/departure/status),
  the requested changes and the reason; approve / reject (comment required) as for leave; `attendance-correction-stale`
  shown in the task panel.
- **HR**: `/attendance/corrections` (scoped list, URL state) and detail with history; the employee Présence tab lists
  the employee's corrections; `/attendance/reports` (month picker, filters, table, "Exporter CSV" downloaded as a Blob
  like documents, `lang` = UI language).

### Authorization matrix rows (Phase B)

| Route | Rows |
|---|---|
| `POST /me/attendance/corrections`, `GET /me/attendance/corrections` | agent 201/200, est 201/200, chef 201/200; admin 409, beta 409; ouest 403, acces 403 |
| `POST /me/attendance/corrections/:id/cancel` | agent (own) 200; est on agent's 404; ouest 403; admin 409 (`attendance-not-linked`, added by the build) |
| `GET /attendance/corrections` | admin 200, est 200 (Est only — asserted), ouest 200 (Ouest only), acces 403, beta 200, agent 403 |
| `GET /attendance/corrections/:id` | admin est/ouest 200, other 404; est est 200, est ouest 404; ouest ouest 200; acces 404; beta est 404, beta other 200; agent own 200, agent on EMP-0027's 404; chef on agent's pending correction (manager candidate) 200 |
| `GET /attendance/reports/monthly`, `…/monthly.csv` | admin 200, est 200, ouest 200, acces 403, beta 200, agent 403 |
| `GET /me/attendance/receipt` (added by the build; fixture receipt cookie per row) | agent 200, est 200, chef 200; admin 409, beta 409 (`attendance-not-linked`); ouest 403, acces 403 |

Plus e2e: chain manager → HR (chef approves agent's correction, then rh.est), approval inserts/voids punches and the
day recomputes; rejection changes nothing; the requester cannot approve; `hr_only` switch; stale target → 409 and
rollback; escalation when the head has no linked user (AG-CNE).

### Settled by the build (Phase B API)

Migration **0017_attendance_corrections.sql**. No new permission (`attendance.manage` already names the HR approval of
corrections), no seed change beyond the per-company workflow definitions; `seed:dev` adds no demo correction.

**Audit of corrections — events without personal payload (same owner rule as punches).** A correction is the
attendance record itself (the employee, the day, the requested instants, a free-text reason), so both tables keep the
standard trigger name `audit_capture_tg` (guard:db audit-per-write passes without exemption) but execute
`audit.capture_correction_event()` (SECURITY DEFINER): **no `audit.change_log` row**, one `audit.event`, subject
`attendance_correction:<id>`, actor = `app.user_id`:
- correction insert → `attendance.correction_requested {}`; status change → `attendance.correction_<status> {}`; the
  `workflow_instance_id` link → nothing;
- item insert → `attendance.correction_item_added {position, action, direction}`; item update (`result_punch_id`) →
  nothing (the punch it creates has its `attendance.punch_recorded {source: 'correction', direction}` event);
- delete by `hrforce_worker` (retention) → nothing; by anyone else → `attendance.correction_deleted {}` /
  `attendance.correction_item_deleted {position}`.
No employment, day, instant or reason reaches the audit log. The contract's `audit.retention_purgeable` rows are not
built (Phase A settled that mechanism away). Workflow rows keep their normal row audit (no personal data).

**Retention.** The purge deletes, per company, items of corrections older than the cutoff, then punches, then
corrections (foreign-key order: items → punches, punches → corrections); `attendance.purged` is now `{punches,
corrections, before}` (written when either count > 0). Workflow instances, tasks and notifications of a purged
correction stay; "My tasks" summarises such a subject as `{type: 'attendance_correction', purged: true}`.

**Data.** `attendance_punch`: `source='correction'` ⇔ `correction_id` set, and then device, window, device ref and
reason are null (the reason lives on the correction); `void_correction_id` only on a void punch; the punch guard also
freezes `correction_id`. `attendance_correction`: guard — only `status` (once out of `pending`) and
`workflow_instance_id` (once) change. `attendance_correction_item`: guard — only `result_punch_id`, once; `void` items
have no direction/instant/result. No DELETE for the app role on either table; DELETE for the worker.

**Request rules as built** (after the zod shape: `date` YYYY-MM-DD, `reason` 3–500 trimmed, `changes` ≤ 20 entries of
`{action:'add', direction, time:'HH:MM'}` | `{action:'void', punchId: uuid}`): 409 `attendance-not-linked` → 409
`attendance-correction-date` (`date` > today, < today − `correctionMaxAgeDays`, or outside the employment; today and
exactly N days back are allowed) → 422 `changes` `min_items` / `max_items` → 422 per change (`changes.<i>.time`
`future` / `exists` / `duplicate`; `changes.<i>.punchId` `not_found` — a void punch, another day's or another person's —
/ `duplicate`) → 409 `attendance-correction-pending` (also the backstop of the partial unique index). The request's
`org_unit_id` (HR step scope) = the employee's scope unit today. The chain = the policy's `correctionWorkflowCode` at
request time.

**Approval as built.** In the final approver's transaction, under the employment's advisory lock, items in `position`
order: `add` → punch `source='correction'`, `created_by` = approver, `site_id` = the employee's effective site that
day, `result_punch_id` set; `void` → the target locked; not live (or not the employee's) → 409
`attendance-correction-stale` and **everything rolls back** (the task stays open: reject it); else voided with
`voided_by` = approver, `void_reason` = the correction's reason, `void_correction_id`. Then status `approved` and the
notification. The engine's separation of duties applies (the employee can never approve; 409 `workflow-self-approval`).
The day flag `corrected` = a live `correction` punch or a punch with `void_correction_id` (a plain HR void is not).
`PunchView.correctionId` / `void.correctionId` are filled; a correction punch has `reason: null`, `kiosk: null`,
`createdBy` = the approver.

**Views as built.** `CorrectionView.employee` is the EmployeeRef on the correction's date; `changes[].time` /
`punch.localTime` are Algiers "HH:MM"; `_actions: ['cancel']` only on `/me` routes, for the requester, while pending.
List and summaries are newest first (`requested_at desc`). The detail's `day` shows `shared_device` only to a caller
holding `attendance.manage` over the employee who is not the employee. "My tasks" `subject` for a correction: `{type:
'attendance_correction', id, employee, date, reason, changes, day: {status, arrival, departure}}`.
Detail / timeline visibility: the employee's linked user, **or** `attendance.read` over the employee's scope unit today,
**or** a current candidate of its open task (so the unit head sees it only while the manager task is open).

**Monthly report as built.** `month` defaults to the current month; malformed → 422 `month` `invalid`, after the current
month → 422 `month` `future`. `days` = 1st → min(month end, today). An employee's days are counted from max(1st, hire)
to min(end, employment end); `expected` and `not_employed` days are not counted. Sort: name (Latin, or Arabic with
`lang=ar`) then matricule; `lang` also accepted by the JSON route. `unitId`/`includeSubUnits` use the tree on the period
end, `siteId` the effective site on the employee's reference day. More than 5 000 employees → 422 `unitId` `too_many`.
**CSV**: `;` separator (settled: Excel in a French locale splits on `;`, and the absence dates use `,`), UTF-8 **with
BOM**, CRLF (also after the last row), `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment;
filename="presence-YYYY-MM.csv"`, `Cache-Control: no-store`; `lang=ar` → Arabic header and Arabic names / unit names when
present (else Latin), anything else → French. 14 columns in the contract's order; hours as `h:mm` (e.g. `40:10`).
**Formula injection**: a text cell starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'`; then a cell containing
`;`, `"`, CR or LF is quoted with `"` doubled. Audit event `attendance.report_exported {month, unitId, rows}` (actor =
caller, subject null).

**Notifications as built.** `attendance.correction_approved` (e-mail default off) and `attendance.correction_rejected`
(on) to the employee's linked user, audience `employee`, subject `attendance_correction:<id>`; `data` =
`{correctionId, employeeName, employeeNameAr, date, changes, actorName}`; `task.assigned` data adds `subjectType`,
`stepKey`, `taskId`. Mails (fr/ar/en) name the day only — never the reason, times or comment; Arabic is gender-neutral
(« تم قبول / رفض طلب تصحيح تسجيل الحضور ليوم … من طرف … »). A cancelled correction notifies nobody.

**Receipt and confirmation.** `RECEIPT_TTL_SECONDS = 120` (exactly 120 s old is still accepted, 121 s is not).
`GET /me/attendance/receipt` as in the summary at the top; it computes the direction exactly as the punch would (the
duplicate lookup first, then the latest live punch of that day before the scan) but without the advisory lock, so a
concurrent punch can still turn the real result into a duplicate — the punch response remains the truth.

### Settled by the verification (Phase B, 2026-09-30)

Full gate green from clean (PG18, `npm test` twice without a failure). Browser checks in fr/ar at 1280 px and 390 px
against the dev stack (kiosk paired with `DEMK-2026`, QR decoded from the canvas), Mailpit, security probes through the
API, audit inspection as superuser before and after a retention run (`payload.today` pinned).

**One-tap confirmation.** Signed out: scan → login (« Connectez-vous pour enregistrer votre pointage ») → question
« Enregistrer mon départ à Siège — Entrée principale ? » / « تسجيل الخروج عند المقر — المدخل الرئيسي؟ » with the
button focused; nothing is recorded before the tap (checked through the API); the punch keeps the scan time (scan
11:14:58, sign-in 20 s later, punch 11:14). A link opened while signed in only shows the question. No tap for 125 s →
« Code expiré » / « انتهت صلاحية الرمز » without a button, nothing recorded. A second scan within the gap →
« Déjà enregistré » / « مسجَّل مسبقا » without a button. The receipt route writes nothing (audit.event, change_log and
punch counts unchanged over three reads, no `Set-Cookie`), sends `Cache-Control: no-store`, and a receipt handed to
another employee answers with **that** employee's own direction (the receipt stays a bearer value, as Phase A said).

**Fixed by the verification.**
- `ReceiptView.localTime` with `duplicate: true` is now the Algiers time of the punch **already recorded** (the one
  « Déjà enregistré » is about), not the time of the new scan: the page showed « Départ 11:15 — Déjà enregistré » for a
  departure recorded at 11:14. `scannedAt` stays the new scan's instant (e2e assertion added).
- Timeline: `attendance.correction_item_added` / `…_deleted` read « Changement n° 1 » for the first change (the event
  keeps the 0-based `position`; the web adds `number` = position + 1).

**Checked behaviour.** Request rules and codes as built (31 days back / tomorrow → 409 `attendance-correction-date`
`date` `out_of_window`, exactly 30 days back accepted; 5 changes `max_items`; `exists`, `duplicate` (time and target),
`future`, another employee's / another day's / a void punch → `punchId` `not_found`); the dialog maps them to the field
(two adds at one minute showed « Deux pointages à ajouter à la même minute. » on the second row); a pending day loses its
"Demander une correction" button and shows the pending chip; a shorter window (5 days) hides the button on older days
and the API refuses them. Chain manager → HR (chef.annaba, then rh.est in Arabic), `hr_only` switch from the Politique
tab (the chef gets no task), rejection with a required comment, cancel (dialog, then « Annulée », remaining steps
cancelled), stale approval (target voided by HR first → the panel shows the stale message, nothing added, reject
still possible), approval of voids (`void.correctionId`, `void_reason` = the correction's reason, `voided_by` = the HR
approver) and adds (`source='correction'`, `correctionId`), flag `corrected` only for correction punches/voids. HR list
(pending by default, `?status=all|approved|…` in the URL) and detail with history; employee Présence tab lists the
month's corrections; purged subject in My tasks → « Correction effacée », approve 404, reject 200.
Notifications and mails: `task.assigned` mails « correction de pointage à traiter : Sarah Ferhat (29/09/2026) » /
« طلب تصحيح تسجيل الحضور للمعالجة: سارة فرحات (29/09/2026) »; rejection mail « تم رفض طلب تصحيح تسجيل الحضور ليوم
20/09/2026 من طرف Amina Benali. التفاصيل متاحة في التطبيق. »; approved → bell only (« تم قبول طلب تصحيح تسجيل الحضور ليوم
29/09/2026. »); the link opens `/me/attendance?correction=<id>` with that request focused and highlighted. No mail
carries a reason, a time or the comment.
Scope: regional HR list/report only Est units, a filter on an Ouest unit gives 0 rows; `lecture` reads its region, 404 on
another region's correction, cannot approve (404) nor request (403); the unit head sees a correction only while its
manager task is open, approving another unit's task → 404, no HR list/report (403); employees: another person's detail
or cancel → 404, HR routes 403; self-approval by an HR requester → 409 `workflow-self-approval` (the requester is not
listed as a candidate). CSV (fr and ar): BOM `EF BB BF`, `;`, CRLF on every line including the last, no bare LF,
Arabic header `الرقم;اللقب;الاسم;…` with Arabic names, `'=HYPERLINK(""…"")` quoted, `'+Touati`, `"'-Leïla;x"`, `'@Khelifi`,
`'=عمر`; each export is one `attendance.report_exported {month, unitId, rows}` with the caller as actor.
Audit after corrections and a purge: correction events carry `{}` or `{position, action, direction}` only, no
`change_log` rows for the two tables, `attendance.purged {punches: 348, corrections: 9, before}`; no reason, day, time
or employment of a correction is left.

**Remaining (not defects of this slice, for the owner).**
- A **rejection comment** is free text written about the day (« Aucune trace de présence après 16:03 ») and lives in the
  workflow audit (`workflow.reject` event data and the `workflow_task` change row), which the attendance purge does not
  reach — the audit-retention question (b) above covers it. `workflow_instance` rows also keep the requester's user id
  and request instant (opaque subject id).
- Notifications of a purged correction keep the employee's name and the day until the notifications cleanup removes
  them (read rows only).
- Arabic « تسجيل الخروج » means both *sign out* (the header button) and *record the departure* (the /punch question and
  the direction word « خروج »): on the phone both appear on one screen. A wording choice for the owner/Arabic reader.

## Out of scope (later)

Badge terminals (ADR 009 §6), in-app camera scanning, single-use QR codes, site-network rule for phones, night shifts
and rosters, overtime and payroll export, month locking, reminders ("no departure recorded" at 20:00), kiosk-offline
alerts to HR, HR corrections on behalf of an employee through the workflow (HR records manual punches instead).

- **Arabic arrival/departure wording (2026-09-30, lead):** « تسجيل الدخول / تسجيل الخروج » also mean "sign in / sign out" and appeared on the same phone screen as the header's sign-out button. Attendance strings now use **« الوصول » (arrival)** and **« المغادرة » (departure)**: « تسجيل الوصول عند {{entrance}}؟ », « تم تسجيل المغادرة على الساعة {{time}} », labels « الوصول / المغادرة ». Sign-in/sign-out strings are unchanged.

**Settled by the cleanup (2026-10-02)**
- `/punch`: the result card (done, already recorded, problem) is scrolled into view and focused (`RevealAlertDirective`):
  on a 390 px phone the app header and menu pushed it below the fold. Browser-checked: the card lies within the
  viewport and holds the focus.
- Policy settings: retention, duplicate gap and correction window refuse a value outside their range, or a fraction,
  with one message naming the range (« Un nombre entier entre 12 et 120. » / « يرجى إدخال عدد صحيح بين 12 و120. »).
- Corrections: a malformed time (`24:00`, `25:00`) answers 422 code **`invalid_time`** on `changes.<i>.time` (was
  `custom`), like the week editor. Platform: a zod `.refine()` may name its contract code in `params.code`.

