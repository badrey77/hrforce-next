# ADR 006: Workflow engine — Postgres state machine

**Status:** Accepted
**Date:** 2026-09-26

## Context

M2 starts with Leave (docs/contracts/leave.md): a request goes through an approval chain — by default the
employee's **unit head** (manager) then **regional HR** — and later slices (training, expenses, document requests,
contract changes) will need the same thing: a subject, an ordered list of approval steps, "who may act now", a history
of who did what, and callbacks into the subject module when the chain finishes.

Constraints that shape the choice:

- **ADR 005: Postgres is the only stateful dependency in P1/M2.** No broker, no extra server to run, back up and secure.
- **ADR 002: access is scoped permission grants.** "Who may approve" must be answered by the same grants and scopes as
  every other route (an HR step = "a holder of `leave.approve_hr` over the employee's unit"), evaluated when someone
  looks — a grant added today must make yesterday's pending tasks visible.
- **ADR 001/005: one transaction per request, audit by trigger.** An approval must change the task, the instance and the
  subject (a leave request, its balance ledger) atomically, and every row change must land in `audit.change_log`.
- The chains are short (1–3 human steps), human-paced (hours to days), and there is no timer-driven behaviour yet
  (reminders and deadlines are M2-worker material).

## Decision

**A small, synchronous state machine in the API, stored in three Postgres tables** (migration 0011, module
`apps/api/src/modules/workflow`):

- `workflow_definition` — per company, an ordered `steps` JSON array; a step is `manager` (resolved by the subject
  module when the step opens) or `permission` (every user holding that permission over the subject's unit). The last
  step must be a `permission` step so an escalated manager step always has somewhere to go. Definitions are data
  (`leave.manager_then_hr`, `leave.hr_only`), chosen per leave type.
- `workflow_instance` — one per subject (`subject_type`, `subject_id`, unique), `status`
  (`pending`/`approved`/`rejected`/`cancelled`), `current_step`, `started_by` and `subject_user_id` (the user the subject
  is about).
- `workflow_task` — one row per step reached: assignee (`user`, `permission` + `scope_unit_id`, or `none` for an
  escalation), `status` (`open`/`done`/`skipped`/`cancelled`), outcome, actor, time, comment. At most one open task per
  instance (partial unique index).

Rules:

- **Candidates are computed at read time**: a `user` task's candidate is its assignee; a `permission` task's candidates
  are whoever `ScopeService.scopeOf(permission)` covers `scope_unit_id` for — "My tasks" is one SQL query with one scope
  sub-query per permission in use. Nothing is copied into the task, so grant changes apply immediately.
- **Separation of duties**: `started_by` and `subject_user_id` never act (409 `workflow-self-approval`) and are
  excluded from candidate lists; a BEFORE UPDATE trigger on `workflow_task` refuses it in the database too.
- **Escalation**: a manager step whose manager cannot act (no head up the tree, the head has no linked user, or the
  manager is the requester) is written as a `skipped` task with outcome `escalated` and the reason, and the next step
  opens in the same transaction.
- **Concurrency**: acting locks the task row (`SELECT … FOR UPDATE`) and the instance; the second of two concurrent
  approvers waits, re-reads a closed task and gets 409 `workflow-task-closed`.
- **Subject hooks**: subject modules register `resolveManager`, `onApproved`, `onRejected`, `onCancelled` and
  `summaries` in a registry (`WorkflowSubjects`); the engine calls them inside the request transaction, so a hook
  failure (e.g. `leave-balance` at final approval) rolls the whole action back.
- **History is append-only**: the app role cannot DELETE workflow rows; a closed task can never change (trigger).
  Every action also writes an application event `workflow.<start|approve|reject|escalate|cancel>` next to the row-level
  audit.

## Consequences

**Positive**
- No new infrastructure; the workflow commits or rolls back with the business change it drives.
- Authorization stays in one place (grants + ScopeService); the matrix test covers task routes like any other.
- The state is plain, queryable SQL: HR reporting, audit timelines and support queries need no engine API.
- Small enough to read in one sitting (~400 lines + tests), with the rules unit-tested as pure domain code.

**Negative**
- Only sequential chains. Parallel branches, quorum ("2 of 3"), conditional routing (e.g. "> 10 days → director")
  and delegation are not modelled; each will need a deliberate extension of the `steps` document and the engine.
- No timers: reminders, deadlines and auto-escalation after N days wait for the M2 worker (a Postgres job queue per ADR
  005), which will read open tasks and call the same engine.
- Definitions are validated by the application (the JSON shape is not a database type); editing them through an API
  is not offered yet (system definitions are seeded).
- The manager is resolved when the step opens; if the unit head changes afterwards, the open task keeps its assignee
  (HR can still act through the permission step after a reject/re-request). Re-assignment is future work.

## Alternatives considered

- **BPMN engine (Camunda / Flowable)** — powerful modelling, timers and a designer, but a JVM server (or SaaS) with its
  own database and transaction boundary: approvals would become a distributed transaction with our Postgres, and the
  "who may act" rule would have to be duplicated in its identity model. Violates ADR 005 and far exceeds 1–3-step chains.
- **Temporal** — durable workflows as code with excellent timer support, but a cluster (frontend, history, matching
  services plus its persistence) to operate, and activities run outside our request transaction and RLS context.
  Rejected for P1/M2 (ADR 005); worth revisiting only if long-running, timer-heavy orchestration appears.
- **Queue-based saga (outbox + worker per step)** — decouples steps, but every approval becomes eventually consistent
  (the requester sees "processing"), needs compensation logic for rejections, and still needs a state table for "My
  tasks". Human approval steps are synchronous by nature; the future worker will only add timers around this engine.

## Supersedes

Nothing — the legacy design doc had no workflow section (approvals were ad-hoc status columns per feature).
