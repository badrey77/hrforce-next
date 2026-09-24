# ADR 004: Browser auth — httpOnly cookies for both tokens, plus XSRF

**Status:** Accepted
**Date:** 2026-09-24

## Context

The legacy design doc has no section on browser authentication for the rewritten
frontend — Report 13's root-cause review marked it "Not covered today." `apps/web` is a
same-origin Angular SPA that talks to `apps/api` at `/api` (dev proxy in development,
same origin in production), so we don't need a cross-origin token story, but we do need
to decide where the access and refresh tokens live in the browser, how credentials are
stored server-side, how login abuse is throttled without adding new infrastructure
(ADR 005 rules out Redis for P1), and what happens to the legacy `cats_queue`
password-sync mechanism used to keep credentials in sync with the sister application.

## Decision

**Both the access token and the refresh token live in same-origin, `httpOnly`,
`SameSite=Strict` cookies.** Neither token is ever readable from JavaScript. Because
`httpOnly` cookies are sent automatically, the API is protected against CSRF with the
standard **double-submit cookie** pattern: a non-`httpOnly` `XSRF-TOKEN` cookie, echoed
by the client on state-changing requests as the `X-XSRF-TOKEN` header. Angular's built-in
`HttpXsrfTokenExtractor`/`withXsrfConfiguration` support this pattern natively, so no
custom interceptor is needed on the web side (per `CONVENTIONS.md`'s web section).

**Credential storage is separate from the user record.** Password hashes live in their
own table, hashed with **argon2id**, never joined into normal user queries or included
in any API response (the `assertNoSecrets(body)` e2e helper and the pino redaction list
in `CONVENTIONS.md` both cover this).

**Refresh token rotation with reuse detection.** Every use of a refresh token issues a
new one and invalidates the old; if an already-used (rotated-away) refresh token is
presented again, that is treated as a signal of token theft and the whole session family
is revoked, forcing re-login.

**Login throttling is Postgres-backed**, not Redis-backed (consistent with ADR 005: no
Redis in P1) — failed attempts are counted per account/IP in a Postgres table with a
short-lived counter (e.g. a row with a TTL-like expiry column, cleaned up by a scheduled
job or on next read) rather than an in-memory or Redis rate limiter.

**Login history is recorded** — timestamp, IP, user agent, outcome — per login attempt,
for the user's own visibility and for incident investigation.

**Password-setup links** (for new accounts and resets) are single-use, time-limited
tokens emailed to the user; in development, outbound mail is captured by **Mailpit**
instead of a real SMTP provider, so the flow is testable without external dependencies.

**The legacy `cats_queue` password-sync mechanism is retired**, not carried into
HRForce Next. It pushed password changes to the sister application over a shared message
bus, which meant any producer with bus access could inject a password-sync message and
take over an account — an account-takeover path with no equivalent safeguard in the
rewrite. Sister-app integration is picked up again, on a safer footing (see ADR 005's
outbox pattern), no earlier than M3.

**SSO/OIDC is out of scope for P1.** Only local username/password login (plus the
above) ships in Phase 1; an OIDC-based path is a later-phase decision.

## Consequences

**Positive**
- `httpOnly` cookies mean an XSS bug cannot read the access or refresh token directly
  via `document.cookie` or `localStorage`, closing off the most common token-theft
  vector for an SPA.
- `SameSite=Strict` plus double-submit XSRF gives CSRF protection without a server-side
  session store or per-request token issuance beyond the existing cookie mechanism.
- Angular's native XSRF support means the web app needs no bespoke interceptor or manual
  header plumbing — it's `HttpClient` configuration, not application code.
- Refresh rotation with reuse detection turns a stolen refresh token into a
  self-reporting event (the legitimate user's next refresh fails and their session
  family is revoked) rather than a silent, indefinite compromise.
- Postgres-backed throttling keeps the "no Redis in P1" constraint (ADR 005) without
  giving up login-abuse protection.
- Retiring `cats_queue` closes a real account-takeover path instead of reproducing it in
  the rewrite.

**Negative**
- `SameSite=Strict` cookies aren't sent on top-level cross-site navigation into the app
  (e.g. a link from an external email landing on an authenticated page), which is
  acceptable for a same-origin internal HR tool but would need revisiting if a future
  phase adds a cross-site entry point.
- No token is accessible to JavaScript, so any client-side logic that wants to inspect
  token claims (e.g. show "your session expires soon") must ask the API for that
  information rather than decoding a JWT locally.
- Postgres-backed throttling adds write load (and needs its own cleanup) proportional to
  login attempts, on the same database as application traffic, which a dedicated
  in-memory store would not.
- Retiring `cats_queue` means password-change propagation to the sister app has no
  replacement until M3's outbox-based integration lands; until then the two systems'
  credentials can diverge, which product/ops needs to be aware of.
- Deferring SSO/OIDC means every P1 user goes through local password login, including
  any who would otherwise prefer/require SSO at their organization.

## Alternatives considered

- **Access token in memory (JS variable), refresh token in an `httpOnly` cookie**: a
  common SPA pattern that limits the access token's exposure window (lost on page
  reload) at the cost of needing a silent-refresh dance on every load and being
  vulnerable to XSS reading the in-memory token during its lifetime. Rejected in favor
  of keeping both tokens out of JS entirely, which is strictly safer for a same-origin
  app where the in-memory pattern's main benefit (surviving cross-origin restrictions)
  doesn't apply.
- **Access token in `localStorage`**: rejected outright — directly readable by any
  injected script, no XSS mitigation at all.
- **Redis-backed login throttling / session store**: rejected for P1 by ADR 005 (no
  Redis, no broker); Postgres-backed counters are sufficient at P1's scale.
- **Keep `cats_queue` password sync**: rejected — it is the account-takeover path this
  ADR exists partly to close; no mitigation short of redesigning the sync mechanism
  (deferred to M3's outbox) was judged acceptable to ship.
- **SSO/OIDC in P1**: rejected for scope — it's a real future requirement but not one
  M1's thin slice (a single HR user logging in) needs, and adding it now would delay the
  4–6 week M1 target for no M1 benefit.

## Supersedes

Replaces "Not covered today" in Report 13's review of the legacy design doc — browser
authentication for `apps/web` now has an explicit, accepted design as described above.
