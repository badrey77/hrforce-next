#!/usr/bin/env bash
# pass() always succeeds, so `cond && pass … || fail …` below is a real if/else.
# shellcheck disable=SC2015
# Smoke check of a deployed HRForce stack.
#   deploy/smoke.sh https://staging.hrforce.example.dz
#   SMOKE_INSECURE=1 deploy/smoke.sh https://localhost      (self-signed / internal CA, local testing only)
# Checks: /api/health 200 · the SPA loads (/, a deep link) with its hashed bundle · security headers and CSP ·
# no inline script in index.html · missing files are 404, not index.html · GET /api/me → 401 problem+json (also
# with the development identity headers) · /api/* never falls through to the SPA · OIDC discovery and issuer ·
# http:// redirects to https://.
# Exit code = number of failed checks (0 = all good).
set -uo pipefail

base=${1:-}
if [[ ! $base =~ ^https?://[^/]+$ ]]; then
  echo "usage: smoke.sh <https://host[:port]>  (no trailing slash)" >&2
  exit 2
fi
curl_opts=(--silent --show-error --max-time 20)
[[ ${SMOKE_INSECURE:-0} == 1 ]] && curl_opts+=(--insecure)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# fetch <name> <path> [curl args…] → $work/<name>.h (headers, lower-cased names), $work/<name>.b (body); echoes status
fetch() {
  local name=$1 path=$2
  shift 2
  local status
  status=$(curl "${curl_opts[@]}" "$@" -D "$work/$name.raw" -o "$work/$name.b" -w '%{http_code}' "$base$path") || status=000
  tr -d '\r' < "$work/$name.raw" 2>/dev/null | awk -F': ' 'NF>1 { printf "%s: %s\n", tolower($1), substr($0, length($1) + 3) } NF<=1 { print }' > "$work/$name.h"
  echo "$status"
}
header() { sed -n "s/^$2: //p" "$work/$1.h" | tail -n 1; }
expect_status() { if [[ $2 == "$3" ]]; then pass "$1 → $2"; else fail "$1 → $2 (expected $3)"; fi; }

echo "smoke: $base"

# --- API health -------------------------------------------------------------------------------------------------
s=$(fetch health /api/health)
expect_status "GET /api/health" "$s" 200
if grep -q '"status":"ok"' "$work/health.b"; then pass "health body reports ok"; else fail "health body: $(head -c 200 "$work/health.b")"; fi

# --- SPA --------------------------------------------------------------------------------------------------------
s=$(fetch index /)
expect_status "GET /" "$s" 200
if grep -q '<app-root' "$work/index.b"; then pass "index.html contains <app-root>"; else fail "index.html has no <app-root>"; fi
[[ $(header index content-type) == text/html* ]] && pass "index content-type text/html" || fail "index content-type: $(header index content-type)"
[[ $(header index cache-control) == *no-cache* ]] && pass "index.html is revalidated (no-cache)" || fail "index cache-control: $(header index cache-control)"

# No inline <script> (without src) and no on*= handler attributes: script-src 'self' would block them.
inline=$(grep -Eo '<script[^>]*>' "$work/index.b" | grep -Evc 'src=' || true)
handlers=$(grep -Eoic '<[^>]+[[:space:]]on[a-z]+=' "$work/index.b" || true)
if [[ $inline == 0 && $handlers == 0 ]]; then pass "index.html has no inline script or event handler"; else fail "index.html: $inline inline <script>, $handlers on*= handler(s) (CSP blocks them)"; fi

main_js=$(grep -Eo 'src="main-[A-Za-z0-9_-]+\.js"' "$work/index.b" | head -n 1 | sed 's/^src="//; s/"$//')
if [[ -n $main_js ]]; then
  s=$(fetch main "/$main_js")
  expect_status "GET /$main_js" "$s" 200
  [[ $(header main content-type) == *javascript* ]] && pass "bundle content-type javascript" || fail "bundle content-type: $(header main content-type)"
  [[ $(header main cache-control) == *immutable* ]] && pass "hashed bundle cached immutable" || fail "bundle cache-control: $(header main cache-control)"
else
  fail "no main-*.js script in index.html"
fi

s=$(fetch deeplink /employees/smoke-deep-link)
expect_status "GET /employees/smoke-deep-link (SPA fallback)" "$s" 200
grep -q '<app-root' "$work/deeplink.b" && pass "deep link serves index.html" || fail "deep link does not serve index.html"

s=$(fetch missing /chunk-SMOKE0000.js)
expect_status "GET /chunk-SMOKE0000.js (missing file)" "$s" 404

# --- Security headers (on the SPA and on the API) ----------------------------------------------------------------
for name in index health; do
  [[ $(header $name x-content-type-options) == nosniff ]] && pass "$name: X-Content-Type-Options nosniff" || fail "$name: X-Content-Type-Options missing"
  [[ $(header $name referrer-policy) == no-referrer ]] && pass "$name: Referrer-Policy no-referrer" || fail "$name: Referrer-Policy: '$(header $name referrer-policy)'"
  [[ -n $(header $name content-security-policy) ]] && pass "$name: Content-Security-Policy present" || fail "$name: Content-Security-Policy missing"
  if [[ $base == https://* ]]; then
    [[ $(header $name strict-transport-security) == *max-age=* ]] && pass "$name: HSTS present" || fail "$name: Strict-Transport-Security missing"
  fi
  [[ -z $(header $name server) ]] && pass "$name: no Server header" || fail "$name: Server header leaks '$(header $name server)'"
done
csp=$(header index content-security-policy)
script_src=$(tr ';' '\n' <<<"$csp" | sed -n 's/^ *script-src //p')
if [[ -n $script_src && $script_src != *unsafe-inline* && $script_src != *unsafe-eval* ]]; then pass "CSP script-src '$script_src' (no unsafe-*)"; else fail "CSP script-src is '$script_src'"; fi
[[ $csp == *"frame-ancestors 'none'"* ]] && pass "CSP frame-ancestors 'none'" || fail "CSP lacks frame-ancestors 'none'"
[[ $(header index x-frame-options) == DENY ]] && pass "X-Frame-Options DENY" || fail "X-Frame-Options: '$(header index x-frame-options)'"

# --- API auth ---------------------------------------------------------------------------------------------------
s=$(fetch me /api/me)
expect_status "GET /api/me (anonymous)" "$s" 401
[[ $(header me content-type) == application/problem+json* ]] && pass "401 is application/problem+json" || fail "401 content-type: $(header me content-type)"
s=$(fetch medev /api/me -H 'X-Dev-User-Id: 0190a5d0-0000-7000-8000-0000000000aa' -H 'X-Dev-Company-Id: 0190a5d0-0000-7000-8000-000000000001')
expect_status "GET /api/me with X-Dev-* headers (dev identity must be off)" "$s" 401

s=$(fetch apimissing /api/smoke-no-such-route)
if grep -q '<app-root' "$work/apimissing.b"; then fail "/api/smoke-no-such-route fell through to the SPA ($s)"; else pass "/api/* is routed to the API ($s)"; fi

# --- SSO (OpenID Connect provider, docs/contracts/sso.md) --------------------------------------------------------
s=$(fetch oidc /oidc/.well-known/openid-configuration)
expect_status "GET /oidc/.well-known/openid-configuration" "$s" 200
if grep -q "\"issuer\":\"$base/oidc\"" "$work/oidc.b"; then pass "OIDC issuer is $base/oidc"; else fail "OIDC issuer: $(grep -Eo '"issuer":"[^"]*"' "$work/oidc.b" || head -c 200 "$work/oidc.b")"; fi

# --- HTTP → HTTPS -----------------------------------------------------------------------------------------------
if [[ $base == https://* && ${SMOKE_SKIP_HTTP_REDIRECT:-0} != 1 ]]; then
  http_base="http://${base#https://}"
  s=$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$http_base/") || s=000
  if [[ $s =~ ^30[178]\ https:// ]]; then pass "http:// redirects to https:// ($s)"; else fail "http:// → '$s'"; fi
fi

if ((failures)); then
  echo "smoke: $failures check(s) FAILED"
else
  echo "smoke: all checks passed"
fi
exit "$failures"
