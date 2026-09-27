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
