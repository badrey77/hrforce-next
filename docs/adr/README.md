# Architecture Decision Records

MADR-style records for HRForce Next Phase 1. Each ADR replaces the matching section of
the legacy "10-BACKEND-REDESIGN.md" design doc, which assumed an in-place upgrade of the
legacy app rather than a rewrite on a new database — the root issue flagged by all five
Phase 1 reviewers (security, domain model, data/platform, frontend, delivery). See
Report 13 §6 for the full P1 feature list these ADRs support.

| # | Title | Status | Supersedes |
|---|-------|--------|------------|
| [001](./001-data-access.md) | Data access — Kysely with plain-SQL forward-only migrations | Accepted | 10-BACKEND-REDESIGN.md §5 (TypeORM) |
| [002](./002-access-model.md) | Access model — scoped permission grants with RLS backstop | Accepted | 10-BACKEND-REDESIGN.md §4 (one role per user) |
| [003](./003-delivery-order.md) | Delivery order — vertical slices, org tree before permissions | Accepted | CLAUDE.md's horizontal foundation-first order |
| [004](./004-browser-auth.md) | Browser auth — httpOnly cookies for both tokens, plus XSRF | Accepted | Report 13: "Not covered today" |
| [005](./005-infrastructure.md) | Infrastructure — Postgres only in P1 | Accepted | 10-BACKEND-REDESIGN.md §2, §6 (Redis, BullMQ, four apps) |
| [006](./006-workflow-engine.md) | Workflow engine — Postgres state machine | Accepted | — (approvals were ad-hoc status columns) |
| [007](./007-sso-oidc-provider.md) | SSO — HRForce as an OpenID Connect provider (`oidc-provider` in the API, Postgres only), app roles managed in HRForce | **Accepted** 2026-09-30 | ADR 004 "SSO/OIDC out of scope for P1" |
| [008](./008-document-generation.md) | Document generation — Typst in the API, stored PDFs, gap-free numbering in Postgres | **Accepted** | 2026-09-28 |
| [009](./009-attendance-check-in.md) | Attendance check-in — rotating signed QR at the entrance, scanned by the employee's phone | **Accepted** | 2026-09-29 |

## How these fit together

- **001** and **005** are the platform layer: how data is accessed and what
  infrastructure exists to run on. Both keep P1 to Postgres alone — no ORM magic, no
  Redis/broker.
- **002** is the authorization model that every module's `@RequirePermission()` guard,
  repository scope filter, and use-case rule ultimately implement.
- **003** sequences delivery so that 002's dependency on an org tree is respected (org
  tree before permissions) and so the full stack — including 001, 004, and 005 — is
  proven end-to-end in M1 before later modules are added. It is the only ADR here still
  pending approval, since it changes an already-written plan.
- **004** is the concrete browser-side implementation of 002's guard-checked, scoped
  access: how a session is established and kept, on top of the RLS/audit
  transaction context that 001 and 005 set up per request.

- **006** (M2) is the approval engine: a synchronous Postgres state machine inside the request transaction (005),
  whose "who may act" is answered by 002's scoped grants at read time.
- **008** (M3, accepted) generates numbered PDFs inside the request transaction (005) with Typst, stores them in
  Postgres, and reuses 006 for self-service document requests.
- **007** (accepted) makes HRForce an OpenID Connect provider for the group's apps: the provider runs inside the API
  (005: its state in Postgres), reuses 004's sign-in page, cookies and two-step verification through an interaction
  handoff, and carries app roles managed with 002-style admin screens in the ID token.
- **009** (accepted) is attendance check-in: server-signed rotating QR codes on paired entrance displays, scanned with
  the phone's own camera into the web app (004's cookies, no CSP change), punches in Postgres (005), corrections
  through 006.

## Format

Each ADR follows MADR conventions: Title, Status, Date, Context, Decision, Consequences
(positive/negative), Alternatives considered, and Supersedes. Status is `Accepted` unless
noted otherwise in the table above.
