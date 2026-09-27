# Contract — Two-step sign-in (MFA, TOTP) (M2, step 3)

Adds a second factor to the Identity slice (ADR 004): time-based one-time codes from an authenticator app (RFC 6238),
plus single-use recovery codes. Enforced by company policy for people holding sensitive or access-management
permissions; optional for everyone else.

## Data (migration 0013, schema `auth` — same rule: no direct privilege for `hrforce_app`, SECURITY DEFINER functions only)

| Table | Columns |
|---|---|
| `auth.user_mfa` | `user_id` pk, `secret_enc bytea` (AES-256-GCM: nonce ‖ ciphertext ‖ tag, key `AUTH_MFA_KEY`), `status` (`pending`/`active`), `created_at`, `enabled_at` null, `last_used_step bigint` null (replay guard) |
| `auth.mfa_recovery_code` | `id`, `user_id`, `code_hash bytea` (sha-256 of the normalized code), `used_at` null |
| `auth.mfa_challenge` | `id` pk (= `mfa` claim of the pending token), `user_id`, `company_id`, `created_at`, `expires_at` (+5 min), `failures int`, `consumed_at` null |
| `public.security_policy` | tenant: `company_id` pk, `mfa_enforced bool` (default **true**), `mfa_required_permissions text[]` (default: every `sensitive` permission + `access.grant`, `access.manage_roles`, `leave.configure`); RLS; audited |

`seed:dev` sets `mfa_enforced = false` for the DEMO company (demos keep working); `bootstrap` creates the row with the
defaults (enforced).

## Crypto

- Secret: 20 random bytes, base32 (no padding) for the user. TOTP: HMAC-SHA1, 6 digits, 30 s period, accept the
  current step ±1; a code whose step ≤ `last_used_step` is refused (**replay**). Implement with `node:crypto`
  (constant-time compare); unit-test against the RFC 6238 test vectors.
- Recovery codes: 10 per set, 10 characters from a 32-character alphabet without ambiguous letters, shown once as
  `XXXXX-XXXXX`; stored as sha-256; regenerating replaces the whole set.
- `AUTH_MFA_KEY`: 32 bytes, base64, validated at boot (production: required; dev/test: may default to a fixed dev
  key, documented as insecure). Key rotation: out of scope (note in README).
- QR code: generated **server-side as a PNG data URL** (`qrcode` package, the only new dependency) so the web needs no
  library; the CSP must allow `img-src data:` (check `deploy/Caddyfile`).

## Login flow

1. `POST /auth/login` (unchanged request). If the password is right and MFA is **active** for the user:
   **200** `{mfaRequired: true}` and a cookie `hrf_mfa` (`HttpOnly; SameSite=Strict; Path=/api/auth/mfa; Max-Age=300`)
   holding a signed short JWT (`sub`, `cid`, `mfa` = challenge id, `exp` +5 min). **No** session cookies yet. Without
   MFA: unchanged (204 + session cookies).
2. `POST /auth/mfa/verify` `{code}` or `{recoveryCode}` (`@Public` + XSRF, needs `hrf_mfa`): valid → 204 + the usual
   session cookies, challenge consumed, `hrf_mfa` cleared, `login_event` `success`, audit event `auth.login` with
   `{mfa: 'totp'|'recovery'}`. Wrong → **401** `mfa-invalid`; 5 failures on one challenge → challenge dead, **401**
   `mfa-challenge-expired` (start over); each failure also counts toward the existing per-email lockout
   (`login_event.outcome = 'mfa_failed'`). Expired/unknown challenge → 401 `mfa-challenge-expired`.
3. Using a recovery code sends a security email ("a recovery code was used; N left").

## Enforcement

- A user is **MFA-required** in a company when `security_policy.mfa_enforced` and they hold (anywhere) any permission in
  `mfa_required_permissions`.
- Required but not enrolled → after login the session works **only** for: `GET /me`, `/me/mfa*`, `/auth/*`,
  `GET /me/notifications/unread-count`; every other route → **403** `mfa-enrollment-required`. Implemented once in the
  platform permission check (not per controller), with a decorator `@AllowWithoutMfa()` for the exceptions; the
  route-scan guardrail and the authorization matrix learn about it.
- `GET /me` gains `mfa: {enabled: boolean, required: boolean, recoveryCodesLeft: number | null}`.

## Endpoints

| Method + path | Guard | Purpose |
|---|---|---|
| `POST /auth/mfa/verify` | `@Public` + `hrf_mfa` | second step (above) |
| `GET /me/mfa` | `@Authenticated` `@AllowWithoutMfa` | `{enabled, required, enrolledAt, recoveryCodesLeft}` |
| `POST /me/mfa/enroll/start` | same | new pending secret (replaces a previous pending one) → `{secret, otpauthUri, qrPng}` (issuer `HRForce`, label `HRForce:<email>`) |
| `POST /me/mfa/enroll/confirm` | same | `{code}` → activates, returns `{recoveryCodes: string[10]}` once; 409 `mfa-already-enabled`; 422 `mfa-invalid` on `code` |
| `POST /me/mfa/recovery-codes` | same | `{code}` (current TOTP) → new set |
| `POST /me/mfa/disable` | same | `{code}` → 204; **409** `mfa-required-by-policy` when required |
| `POST /access/users/:id/mfa/reset` | `access.grant` over the user (same visibility rule as `GET /access/users/:id`), not self (409 `mfa-reset-self`) | removes the user's MFA and recovery codes, revokes their sessions, emails them; audit `auth.mfa_reset` |
| `GET/PUT /access/security-policy` | `access.manage_roles` | `{mfaEnforced, mfaRequiredPermissions}` |

Audit events: `auth.mfa_enrolled`, `auth.mfa_disabled`, `auth.mfa_recovery_regenerated`, `auth.mfa_reset`,
`auth.mfa_recovery_used`. Log redaction: `code`, `recoveryCode`, `secret`, `otpauthUri`, `qrPng`, `hrf_mfa`.

## Web

- Login: when the response is `{mfaRequired: true}`, the page switches to a **code step** (6-digit input:
  `autocomplete="one-time-code"`, `inputmode="numeric"`, auto-submit at 6 digits), link "Use a recovery code", back
  to the password step; messages for `mfa-invalid`, `mfa-challenge-expired`, lockout.
- `/me/security` (from the user menu): status, **enroll** wizard (1 · scan the QR / type the key, 2 · enter a code,
  3 · recovery codes shown once with Copy and Download `.txt` and a "I have saved them" checkbox before finishing),
  regenerate codes, disable (hidden when required).
- Enforcement: when `me.mfa.required && !me.mfa.enabled`, a guard sends every route (except `/me/security`, logout) to
  the enrollment wizard with an explanation; a 403 `mfa-enrollment-required` from any call does the same.
- Access → user detail: "Reset two-step sign-in" (confirm dialog) with `access.grant`. Access → a **Security policy**
  section (`access.manage_roles`): enforce toggle + permission checklist (reuse the permission checklist).
- i18n fr/ar/en; RTL; the code input stays LTR (`dir="ltr"`).
