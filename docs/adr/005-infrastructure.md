# ADR 005: Infrastructure — Postgres only in P1

**Status:** Accepted
**Date:** 2026-09-24

## Context

The legacy design doc §2 and §6 describe an architecture built around Redis (cache,
queues) and BullMQ for background jobs, split across four separate application
processes. That shape assumes the legacy app's existing operational footprint and
in-place upgrade path. HRForce Next starts from nothing operationally: there is no
existing Redis deployment or four-app topology to preserve, and Phase 1's scope (M1's
thin vertical slice, per ADR 003) does not yet have a workload that needs a separate
cache tier or a dedicated broker. What P1 does need is: background jobs (e.g. sending
password-setup mail, processing the audit/outbox pattern that later phases build on),
scheduled/cron-style work, and an audit trail that is both trustworthy (DB-level,
can't be bypassed by forgetting to call an audit function) and application-meaningful
(knows what use case caused a change).

## Decision

**Postgres is the only stateful infrastructure dependency in P1.** No Redis, no message
broker, no object storage.

- **Background jobs, the outbox pattern, and cron-style scheduled work** all run on
  **Graphile Worker or pg-boss** — both are Postgres-native job queues (`LISTEN`/`NOTIFY`
  plus row locking, no separate broker process). The concrete choice between the two is
  an implementation detail for the module that first needs it; this ADR fixes "a
  Postgres-native job queue," not the specific library.
- **One container image, two entry points**: the same build produces both the HTTP
  server (`main.ts`) and the worker process; which one runs is chosen at container start
  (e.g. by command/entrypoint argument or env var), not by building and shipping
  separate images. This replaces the legacy four-app split.
- **No Redis, broker, or object storage in P1.** Any feature that would reach for one
  (a cache, a pub/sub channel, a file store) is either deferred past P1 or implemented
  on Postgres (e.g. files as rows with content in the database or on local/volume
  storage for P1's scale, revisited when a real need for object storage appears).
- **Cache and request throttling are none-or-Postgres in P1**: no dedicated cache tier;
  where throttling is needed (ADR 004's login throttling), it's implemented with a
  Postgres table, not an in-memory or Redis limiter.
- **Audit is both a DB trigger and an application event, deliberately doubled**: a
  trigger on every audited table captures before/after diffs at the DB level (so it
  fires regardless of which code path made the change), while the application layer
  also emits its own audit events with use-case-level context (which action, which use
  case) that a raw row-diff can't express. The audit table is **append-only** and
  **partitioned monthly**, and known-sensitive columns (matching the same
  password/hash/token/secret pattern enforced elsewhere by the response-scanning
  guardrail) are **masked** in the stored diff rather than written in clear.

## Consequences

**Positive**
- One less operational dependency (Redis) to provision, monitor, back up, and secure in
  P1 — fewer moving parts for a small team to run, matching M1's 4–6 week target.
- A Postgres-native job queue keeps jobs, the outbox, and business data in the same
  transactional boundary: an outbox row and the business change it describes can be
  written in the same transaction, avoiding a whole class of dual-write bugs that a
  separate broker would introduce.
- One image with two entry points simplifies the build/deploy pipeline (one artifact,
  one CI build step) compared to maintaining four separate app builds.
- DB-trigger audit can't be silently skipped by a code path that forgets to call an
  audit helper; app-event audit adds the "why," which the trigger alone can't know.
  Together they're more trustworthy than either alone.
- Monthly partitioning keeps the append-only audit table's indexes and vacuum cost
  bounded as it grows, instead of one ever-larger table.

**Negative**
- Postgres now carries cache-like, queue-like, and audit workloads on top of normal
  application traffic; at higher scale this can compete for the same connections/IO that
  a dedicated cache or broker would have absorbed. This ADR accepts that trade for P1's
  scale and revisits it if a later phase's load requires it.
- No cache tier means every "cacheable" read (e.g. org tree lookups) hits Postgres every
  time in P1; this is acceptable at P1's scale but is a known place to add caching later
  without redesigning the data path.
- Doubled audit (trigger + app event) is more moving parts than either alone: the two
  can disagree (e.g. an app event fires but the transaction rolls back, or a trigger
  fires on a direct DB change with no matching app event) and reconciling that is left
  to whoever consumes the audit trail.
- Masking sensitive fields in the audit diff means the audit trail cannot itself be used
  to recover a masked value (e.g. "what was the old salary") beyond what masking allows
  — an intentional trade of recoverability for not duplicating a sensitive value into a
  second, less-guarded table.
- Choosing "Graphile Worker or pg-boss" rather than picking one now defers a decision
  that the first module needing it will have to make; without a follow-up decision
  record, teams could pick differently in different modules.

## Alternatives considered

- **Redis + BullMQ** (legacy §2, §6): rejected for P1 — no existing Redis deployment to
  build on, and P1's job/queue volume doesn't need a dedicated broker; revisiting this
  if job volume or latency requirements outgrow a Postgres-native queue is not
  precluded by this ADR.
- **Four separate application processes** (legacy §6's topology): rejected — one image
  with two entry points is simpler to build, version, and deploy, and P1's job volume
  doesn't need process-level isolation from the HTTP server.
- **App-event audit only (no DB trigger)**: rejected — misses any change made outside
  the application's own use-case code path (a manual fix, a future direct-SQL tool),
  which a trigger catches unconditionally.
- **DB-trigger audit only (no app events)**: rejected — a row-level before/after diff
  can't express which use case or business reason caused the change, which the audit
  trail needs to be useful for investigation, not just forensic row recovery.
- **Object storage (e.g. S3-compatible) for documents in P1**: deferred, not adopted —
  M1 doesn't touch documents (that's M3 per ADR 003); introducing object storage before
  a real document-handling feature needs it would be infrastructure ahead of
  requirements.

## Supersedes

Replaces "10-BACKEND-REDESIGN.md" §2 and §6 in full: the Redis/BullMQ dependency and the
four-application topology described there are replaced by the Postgres-only,
one-image-two-entry-points design above.
