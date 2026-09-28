# Contract — Notifications, background worker and live updates (M2, step 2)

People currently have to open "My tasks" to notice work. This step tells them: an **in-app bell** (live), and **email**
per their preferences. It also introduces the **worker** entry point planned in ADR 005 (Postgres-only jobs and cron).
It closes the gap found in verification: leave events on the employee History tab.

## Worker (ADR 005: Graphile Worker on Postgres)

- Library: **graphile-worker** (Postgres only, LISTEN/NOTIFY, cron). Its schema `graphile_worker` is installed by the
  **migrate** step as the migrator (not at API start); `hrforce_app` may only call `graphile_worker.add_job` (via the
  library's `quickAddJob`/`WorkerUtils` or the SQL function) — no other privilege on that schema. The worker process
  connects as a dedicated role **`hrforce_worker`** (new; created by `create-roles.sql`, test harness and compose init):
  RLS applies (no BYPASSRLS); each job sets `app.company_id` (and `app.user_id` = null, actor "system") in its own
  transaction before touching tenant data.
- Entry point: `node dist/worker.js` in the **same API image**. `npm run worker -w @hrforce/api` for dev.
- Jobs are enqueued **inside the business transaction** (transactional outbox: rollback = no job).
- Cron (company by company):
  | Job | Schedule | What |
  |---|---|---|
  | `audit.ensure_partitions` | monthly, day 1 00:10 | `audit.ensure_partitions(12)` (as migrator-owned definer function callable by the worker role) |
  | `leave.accruals` | monthly, day 1 01:00 | accruals for the previous month (existing `runAccruals`, idempotent) |
  | `auth.cleanup` | daily 03:00 | delete `auth.login_event` older than 180 days and used/expired `password_token` older than 30 days (definer functions) |
  | `notifications.cleanup` | daily 03:30 | delete read notifications older than 90 days |
- Env: `WORKER_DATABASE_URL` (worker role), `WORKER_CONCURRENCY` (default 4); the worker reuses the mail settings.
- `deploy/compose.staging.yml` gets a `worker` service (same image, `node dist/worker.js`, no published port);
  `scripts/dev-up.sh|ps1` start it too.

## Notifications (module `notifications`)

| Table | Columns |
|---|---|
| `notification` | `id`, `company_id`, `user_id` (recipient), `type`, `subject_type`, `subject_id`, `data jsonb` (names/dates needed to render, no sensitive values), `created_at`, `read_at` null |
| `notification_preference` | `company_id`, `user_id`, `type`, `email bool`, pk (`company_id`,`user_id`,`type`) — absent row = default |

RLS: standard company policy **plus a restrictive policy** `user_id = current_setting('app.user_id', true)::uuid` for
SELECT/UPDATE/DELETE on both tables (a user only ever reads/marks their own). INSERT is allowed for the tenant (the
actor creates notifications for others). Audit trigger on `notification_preference` only; `notification` is exempt
(high volume, derived from audited events — list it with the reason).

Types (fr/ar/en labels and mail templates):

| Type | When | Recipients | Email default |
|---|---|---|---|
| `task.assigned` | a workflow task opens (incl. after escalation) | its candidates at that moment (user or every holder of the permission over the scope unit), minus the requester | on |
| `leave.approved` / `leave.rejected` | request finishes | the requester and the employee's linked user (deduplicated) | on |
| `leave.cancelled` | requester cancels | candidates of the task that was open | off |
| `task.escalated` | manager step skipped | the requester (information) | off |
| `leave.submitted_on_behalf` | HR files a request for an employee | the employee's linked user | on |

Rules: never notify the actor about their own action; one row per recipient; emails are a job
`notifications.email` (one per notification) that re-checks the preference and the recipient's status (skip disabled
accounts), renders in the recipient's locale with a link (`${WEB_BASE_URL}/tasks?task=<id>` or `/me/leave?request=<id>`)
and sends via the configured transport. Mail bodies never include balances or reasons (privacy); just who/what/when + link.

## Live updates (Server-Sent Events, Postgres only)

- `GET /api/me/notifications/stream` (`@Authenticated`, `text/event-stream`): events `notification` (`{id, type, …}`)
  and `unread` (`{count}`), plus a `ping` comment every 25 s. Fan-out via Postgres `LISTEN hrforce_notifications`
  (payload = `{companyId, userId, id}` only; the API re-reads the row under RLS before sending). One dedicated
  listener connection per API process.
- The stream closes itself when the access token behind it expires (≤ 15 min); the client refreshes its session with
  an ordinary API call (which goes through the refresh interceptor) and reconnects. Caddy/Nginx: no buffering on this path.
- `NOTIFY` is sent in the same transaction as the insert (delivered on commit).

## Endpoints

| Method + path | Guard | Purpose |
|---|---|---|
| `GET /me/notifications?unreadOnly=&before=&limit=` | `@Authenticated` | newest first, cursor paging → `{items: NotificationView[], nextCursor}` |
| `GET /me/notifications/unread-count` | `@Authenticated` | `{count}` |
| `POST /me/notifications/:id/read` | `@Authenticated` | 204 (404 if not yours) |
| `POST /me/notifications/read-all` | `@Authenticated` | 204 |
| `GET /me/notification-preferences` / `PUT` | `@Authenticated` | `[{type, email, default}]` / body `[{type, email}]` |
| `GET /me/notifications/stream` | `@Authenticated` | SSE (above) |

```ts
interface NotificationView {
  id: string; type: string; createdAt: string; readAt: string | null;
  subject: { type: 'workflow_task' | 'leave_request'; id: string };
  data: Record<string, string | number | null>;   // e.g. {employeeName, leaveType (code), startDate, endDate, days, actorName, stepKey}
  audience: 'approver' | 'employee' | 'requester' | null; // who the caller is to the subject (see "Wording by audience")
  link: string;                                    // app path, e.g. "/tasks?task=…"
}
```

## Audit gap (History tab)

Timeline subject `leave_request:<id>` (rows of `leave_request`, its workflow tasks, `workflow.*` events) and the
`employee:<id>` timeline also includes the employee's `leave_request` rows and workflow events. Scope as the
request's (`leave.read` in scope, or requester/candidate for their own).

## Web

- Header **bell** with unread count (`aria-live`), a dropdown with the latest 10 (mark read on open of an item,
  "mark all read", "see all"), live via an `EventSource` wrapped in a root service exposing signals; falls back to the
  existing visibility-based refresh if the stream fails repeatedly. Clicking navigates to `link`.
- `/notifications` page: full list with unread filter and paging.
- `/settings` (existing "Paramètres"): a **Notifications** section with an email toggle per type.
- Tasks badge refreshes when a `task.assigned` arrives; My leave refreshes on `leave.*`.
- History: leave events appear in the employee History tab; a History section on the leave request detail.

## Settled by the build (backend, 2026-09-27)

Behaviour the API settled where the contract above was silent (`apps/api/src/modules/notifications`, `src/worker*`,
migration 0012).

- **Recipients.** `task.escalated` goes to the requester **even though they are usually the actor** (the engine, not
  they, skipped the manager step); every other type drops the actor. `task.assigned` for a permission step = the users
  holding that permission over the unit through today's grants (`role_grant` + closure; not DEV_PERMISSIONS).
- **Subjects and links** (`link` is computed per recipient): `task.assigned` → subject `workflow_task`,
  `/tasks?task=<task id>`; `leave.cancelled` → `/tasks`; every other type → subject `leave_request`,
  `/me/leave?request=<id>` for the employee's own user, `/leave/requests/<id>` for a requester who filed it for
  someone else (e.g. `leave.approved` to the HR user who filed on behalf).
- **`data` keys:** `requestId, employeeName, employeeNameAr (null when none), leaveType (code), startDate, endDate,
  days (number), actorName (null = unknown)`; plus `taskId, stepKey` (`task.assigned`) and `stepKey,
  escalationReason` (`no-manager` | `manager-not-linked` | `manager-is-requester`, `task.escalated`).
- **One notification per (recipient, type, subject)**; a repeated hook is a no-op.
- **Endpoints:** `limit` 1–100 (default 20); `unreadOnly=true|false`; a malformed `before` → 422 (`errors[].field =
  before`); `POST …/:id/read` on an already-read row → 204; `PUT /me/notification-preferences` → 200 with the full
  list (same shape as GET); an unknown type → 422 `errors[{field: '<index>.type', code: 'unknown_type'}]`, a repeated
  type → 422 `duplicate`; types not in the body keep their value.
- **Stream:** `retry: 5000` first, then `event: unread` (`{count}`) immediately; after each `notification` event an
  `unread` event follows; marking read (any tab/device) also pushes `unread`. A stream opened with DEV_AUTH headers
  (no token expiry) lasts 15 min. Anonymous → 401 problem+json (no stream).
- **History:** `GET /audit/timeline` is now `@Authenticated`: every subject type still needs `audit.read` (403 before any
  validation) except `leave_request:<id>`, visible like `GET /leave/requests/:id` (leave.read over the unit, the
  requester, the employee's linked user, a current candidate; else 404) — so the request detail's History works for
  the employee and approvers. The employee timeline adds `leave_request` rows and the `workflow.*` events of the
  employee's requests (not their `workflow_task` rows).
- **Worker:** cron in the worker's time zone (UTC in containers), missed ticks backfilled (7 days monthly, 12 h daily);
  e-mail job retried 5 times; `leave.accruals` accepts a manual payload `{"month":"YYYY-MM"}`.
- **Verified 2026-09-27 (independent verifier).** Links per recipient, opened in a browser as that recipient: every
  one lands on a page they can see — `task.assigned` and `leave.cancelled` go to `/tasks` (no permission guard: a unit
  head with only `employe` opens it), the employee's own user to `/me/leave?request=…`, an HR requester who filed on
  behalf to `/leave/requests/<id>` (they hold `leave.read`). The web request detail shows its **History without
  `audit.read`** (the API scopes a `leave_request` timeline like the request; `rh_regional` has no `audit.read`).

## Wording by audience (hardening, 2026-09-28)

Fixes "an HR user who filed leave on someone's behalf gets `leave.approved` worded 'your request…'".

- `NotificationView.audience` (top level, per recipient) exposes the row's internal audience: `employee` = the
  recipient is the employee the request is for; `requester` = they filed it for someone else; `approver` = a task
  candidate; `null` = a row without one (treat as "someone else"). `data` still never contains `audience`.
- **Clients word the sentence by audience.** `employee` → "your request" (`Votre demande…`, `طلبك…`, `Your request…`);
  any other audience → a sentence that names the employee (`employeeName`, or `employeeNameAr` in Arabic when present),
  e.g. "La demande de congé de Walid Mansouri a été approuvée".
- Types concerned: `leave.approved`, `leave.rejected` (employee or requester) and `task.escalated` (the requester:
  `employee` when they filed their own, `requester` when HR filed it). `task.assigned` and `leave.cancelled` go to
  approvers and always name the employee; `leave.submitted_on_behalf` only goes to the employee ("pour vous").
- **E-mails** (`mail-templates.ts`) follow the same rule in fr/ar/en, subject and body. Employee: subject
  `HRForce — votre demande de congé est approuvée` / `… est refusée` / `… est transmise aux RH`, body `Votre demande de
  congé (…) a été approuvée par <actor>.` Someone else: subject `HRForce — demande de congé de <Name> approuvée` /
  `refusée` / `transmise aux RH`, body `La demande de congé de <Name> (…) a été approuvée par <actor>.`

