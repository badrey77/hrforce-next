# ADR 009: Attendance check-in — rotating signed QR at the entrance, scanned by the employee's phone

**Status:** Accepted (owner, 2026-09-29)
**Date:** 2026-09-29

(ADR 007 is reserved for SSO.)

## Context

Owner decision (2026-09-29, HANDOFF): attendance is a **module inside HRForce** (no sister app, no SSO). Employees
check in and out by scanning a **rotating signed QR code** shown on a screen or tablet at each entrance, with the
**HRForce web app on their own phone** (installable web app, no store app). Badge readers may come later behind the
same check-in API. Entrances are **mostly online**: no offline capture; when the network or a phone fails, HR records
the punch manually (audited, with a reason). **No biometrics** (Law 18-07). Contract: `docs/contracts/attendance.md`.

Constraints that shape the design:

- **ADR 005:** Postgres is the only stateful dependency. No broker, no push service, no device-management server.
- **ADR 004:** the session lives in `httpOnly`, `SameSite=Strict` cookies with a signed double-submit XSRF token;
  refresh tokens live **12 h idle / 7 days absolute**. An employee who punches at 08:00 and at 16:30 is idle from 16:30
  to 08:00 the next morning (15.5 h), so **the first scan of most days meets an expired session**: whatever we choose
  must survive "scan → sign in (password, maybe TOTP) → punch" without asking the employee to scan twice.
- **`deploy/Caddyfile`:** `Permissions-Policy: camera=(), geolocation=(), …` and the app CSP `script-src 'self'`
  (no `'wasm-unsafe-eval'`, no `eval`), `img-src 'self' data:`, `connect-src 'self'`, `manifest-src 'self'`. The
  Permissions-Policy is a property of the **document**: the SPA loads one `index.html` for every route, so allowing the
  camera for one route means allowing it for the whole app.
- **Phones are the employees' own**, heterogeneous (cheap Android, some iPhones). Entrance screens are cheap Android
  tablets. Nothing can be installed on either beyond a browser and a home-screen shortcut.
- **Law 18-07 (personal data):** attendance data is personal data; collect the minimum, say what is collected, keep it
  for a bounded time.

## Decision

### 1. The entrance display ("kiosk") is a paired device, not a user

- HR (`attendance.configure`) creates a **kiosk** in HRForce for one **site** with an entrance label (fr/ar), and gets
  a one-time **pairing code** (8 characters, Crockford base32, 40 bits, valid 10 min, stored as SHA-256).
- On the tablet, anyone opens `https://<domain>/kiosk` (a route of the same Angular app, no sign-in, no app chrome) and
  types the code. The API answers with a **device credential**: 32 random bytes in an `httpOnly; Secure;
  SameSite=Strict; Path=/api/kiosk` cookie (`hrf_kiosk`, 400 days, renewed by the kiosk's daily session call). Only
  its SHA-256 is stored. No HR password is ever typed on the shared tablet; the code can be read out over the phone
  to someone on site.
- The credential can do **one thing**: fetch QR tokens for its own kiosk (`GET /api/kiosk/qr`). It cannot read any
  personal data. HR can **revoke** it (final) or re-pair (a new code replaces the credential when used).
- Optional per-kiosk **allowed networks** (CIDR list): when set, the credential only works from those source
  addresses (the site's public IP). This is the main control against a **stolen tablet or copied credential**.
- A heartbeat (last seen, IP, user agent — kept in an audit-exempt operational table) is shown in kiosk management.
- It is a row of `attendance_device` with `kind = 'qr_kiosk'`: the same table, pairing flow and credential will
  serve **badge terminals** later (below).

### 2. The QR code: an HMAC-signed, 30-second window token in a URL

- Token = `base64url( version(1) ‖ companyId(16) ‖ deviceId(16) ‖ window(4, uint32 BE) ‖ HMAC-SHA256(K_qr, "hrforce.attendance.qr.v1\0" ‖ preceding bytes)[0..16] )`
  → 71 characters. `window = floor(unix_seconds / 30)`. `K_qr` is derived from a new server secret
  `ATTENDANCE_KEY` (32 bytes, base64, required in production like `AUTH_MFA_KEY`).
- The QR encodes the URL **`${WEB_BASE_URL}/punch#<token>`** (≈ 110 characters → QR version 7 at error correction M,
  45 × 45 modules; measured: encoding 2 ms, signing 3 µs, verifying 2 µs — prototype in the session scratchpad).
- **Only the server signs.** The kiosk fetches the tokens for the current window and the next three (2 minutes of
  cover) and shows the one whose window matches the server-corrected clock. A network blip under ~2 minutes is
  invisible; after that the kiosk hides the QR and shows an offline state instead of a code that will fail.
- **Validity:** the server accepts a token whose window is the current or the previous one — a scanned code works for
  **30 to 60 s** after it first appears. Future windows (lookahead held by the kiosk) are refused.
- HMAC, not Ed25519: signer and verifier are the same service; there is no third party to hand a public key to.

### 3. The phone: native camera → deep link; scan receipt → punch

- The employee points the **phone's own camera** (or Google Lens / the iOS camera) at the code; it opens
  `/punch#<token>`. The token is in the **fragment**: never sent in the page request, never in Caddy's access log,
  never in a Referer. The page strips it from the address bar at once (`history.replaceState`).
- **Two calls:**
  1. `POST /api/attendance/scan {token}` — **public** (XSRF anon or session token). The server verifies the token and
     answers with the entrance's name and a **scan receipt**: an HMAC-signed cookie `hrf_scan` (`httpOnly; Secure;
     SameSite=Strict; Path=/api/me/attendance; Max-Age=300`) holding {company, device, window, **scannedAt**}.
  2. `POST /api/me/attendance/punches` (no body; `attendance.punch_self`) — redeems the receipt: the punch's instant is
     **`scannedAt`** (server time when the scan reached us), its direction is inferred, the receipt cookie is cleared.
- If the session has expired, call 2 answers 401, the existing refresh interceptor sends the employee to
  `/login?returnUrl=/punch`; after sign-in (and TOTP if enrolled) the page calls 2 again and the **5-minute receipt**
  still holds the scan instant. No second scan, and the recorded time is the time the employee stood at the door.
- **Direction is inferred, not chosen:** the first live punch of the work day is an arrival, then arrivals and
  departures alternate. One scan, no extra tap in the morning queue. A second scan within 2 minutes (policy) returns
  the existing punch (`duplicate: true`) instead of creating a departure. Mistakes are fixed by a correction request
  (workflow) or by HR.
- **Why not scan inside the app (getUserMedia + a JS decoder):** it needs `camera=(self)` for the *whole* app (the
  policy is per document, not per route), a decoder library (the fast ones are WebAssembly, which needs
  `'wasm-unsafe-eval'` in `script-src`; `BarcodeDetector` does not exist on iOS Safari), a camera permission prompt, and
  more code on the weakest phones. The native camera already reads QR codes on every current phone. Kept as a later
  option if a phone population without camera QR support appears.
- **iPhone note:** a URL opened from the iOS camera goes to Safari, whose cookies are separate from a home-screen web
  app; iPhone users sign in once in Safari. Android Chrome opens the installed web app (WebAPK) or Chrome, which share
  cookies.

### 4. Time

Server time is authoritative (`Africa/Algiers`, UTC+1, no daylight saving). A punch's instant is when the API received
the scan (`scannedAt`), never a client clock. The kiosk only *displays* a clock corrected by the offset it measures
against `serverTime`; its own clock never decides validity. Future device punches (badges) will carry both
`occurred_at` (device) and `received_at` (server) — both columns exist from the first slice.

### 5. Anti-sharing and buddy punching: short windows + signals, no location

| Threat | Mitigation | Residual risk |
|---|---|---|
| **Photo of the QR sent to a colleague at home** (main threat) | Token valid 30–60 s; the colleague must scan it within that minute *and* be signed in as themselves. The punch records the kiosk; the presence board shows who is present to the unit head, who sees the absent person marked present. | A coordinated real-time relay within 60 s works. Accepted; deterred by visibility, audit and HR policy. |
| **Replay** of a token or receipt | One QR punch per employee per (kiosk, window) — unique index; receipts expire in 5 min and are cleared when redeemed; the 2-minute gap rule collapses double scans. | — |
| **One phone punching for several people** (credentials shared) | A per-browser random identifier (`hrf_dev` cookie, `httpOnly`) is stored as an HMAC (`device_ref`) on each QR punch; the HR board flags `shared_device` when one browser punched for two employees on the same day. A **signal for HR**, not a refusal (spouses may share a phone). | Clearing cookies defeats it. |
| **Stolen tablet / copied credential** (live QR feed from anywhere) | Credential is `httpOnly`, bound to one kiosk, revocable; optional allowed networks; heartbeat shows IP and last activity. | Without allowed networks, a stolen credential works until revoked. |
| **Forged or edited token** | 128-bit truncated HMAC over every field; key only on the server. | Key leak → rotate `ATTENDANCE_KEY` (only live tokens and receipts are lost). |
| **Wrong phone clock / wrong tablet clock** | Irrelevant: validity and punch time use the server clock. | — |
| **HR editing punches** | Punches are immutable (insert, or one `live → void` transition); manual punches and voids need a reason; HR cannot manage their own punches; every change is in the audit log. | Collusion between HR and an employee. |

**Geolocation is rejected** for this slice: it needs `geolocation=(self)` for the whole app, is easily spoofed on
Android, is imprecise indoors, and makes the module process location data — a new purpose under Law 18-07 that the
owner would have to declare and justify. The server does not store the phone's IP on punches either (minimisation;
the per-browser identifier is the more useful signal). An optional "phone must be on the site network" rule is left as
an extension (the intake already knows the source address).

### 6. Extension point: device-authenticated terminals (badges)

A badge terminal is another `attendance_device` (`kind = 'badge_terminal'`), paired with the same one-time code and
holding the same kind of credential (sent as a header instead of a cookie). It posts `{credentialUid, occurredAt,
deviceSeq}` to a future device endpoint; a future `attendance_badge` table maps a badge to an employment. The punch row
is unchanged: `source = 'badge'`, `device_id`, `occurred_at` (device clock, accepted within a tolerance of
`received_at`), `received_at`, and a unique `(device_id, device_seq)` for idempotent retries. Direction inference, daily
computation, corrections, retention and permissions apply as they are. This ADR does not specify that endpoint.

## Consequences

**Positive**
- No new infrastructure, no native app, no camera or location permission, **no change to the CSP or the
  Permissions-Policy**. The kiosk draws the QR on a `<canvas>` with a small MIT, eval-free encoder bundled by the
  build (`qrcode-generator`), and uses the Screen Wake Lock and Fullscreen APIs, which the current policy allows.
- The expired-session morning is handled: scan, sign in, punch — with the true scan time.
- Only the server holds signing keys; a kiosk credential cannot read data and can be limited to the site network.
- Punches are rows with a clear provenance (`source`, device, creator), immutable, and ready for badge terminals.

**Negative**
- A real-time relay of the code to a colleague within 60 s is not prevented, only made awkward and visible. Stronger
  controls (single-use codes, site-network requirement, badges) are the upgrade path.
- An employee must be signed in on the phone's browser; with today's session lifetimes that often means typing a
  password in the morning. A longer "remembered phone" session would need an ADR 004 amendment (question for the
  owner).
- Everyone at the entrance depends on the kiosk's network. When it is down, the kiosk says so and HR records punches
  manually afterwards (owner decision: no offline capture).
- iPhone users use Safari, not a home-screen app, for punching.

## Alternatives considered

- **Static QR per entrance** (printed): trivially photographed and reused forever. Rejected.
- **Employee-shown QR scanned by the kiosk** (the phone displays a rotating personal code, the tablet's camera reads
  it): the kiosk would need camera access and a decoder, would become a device that sees who comes in (an identity
  reader), and a screenshot of the personal code can be handed to a colleague at the door — buddy punching moves
  to the entrance instead of disappearing. Rejected.
- **Single-use rotating QR** (a new code after every scan, pushed to the kiosk): stops a relayed photo when someone
  scans first, but serialises the morning queue (one person per code refresh) and needs a live channel to every
  kiosk. Kept as a possible upgrade for quiet entrances.
- **Geofencing** (phone GPS inside a site polygon): see §5 — spoofable, imprecise, a new category of personal data,
  and a Permissions-Policy change for the whole app. Rejected for now.
- **In-app camera scanning** (getUserMedia + decoder): see §3. Deferred.
- **Kiosk signs tokens itself** with a key held in the tablet's browser: survives long outages, but puts a signing key
  in JS-readable storage on an unattended device and depends on the tablet clock. Rejected for a server-signed
  lookahead.
- **Badge readers now:** hardware to buy, install and maintain per entrance; badges are lent as easily as phones.
  Designed for (§6), not built.
- **Biometrics** (fingerprint, face): excluded by the owner (Law 18-07, sensitive data).

## Supersedes

Nothing (new module).
