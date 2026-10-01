/**
 * The provider's own HTML pages (docs/contracts/sso.md › Logout flow): the RP-initiated logout page (auto / confirm),
 * the "signed out" page and the error page. French and Arabic side by side (stacked below 480 px), gender-neutral
 * Arabic, no external font, styles inline (`style-src 'unsafe-inline'`), and NO inline script: the logout page loads
 * the same-origin /oidc/assets/end-session.js, which reads its `data-*` attributes. Every value is HTML-escaped.
 */

export const END_SESSION_SCRIPT_PATH = '/oidc/assets/end-session.js';
export const LOGOUT_FORM_ID = 'op.logoutForm';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#f4f6f8;color:#1c2833;font-family:"Segoe UI",Tahoma,Arial,sans-serif;line-height:1.5}
main{max-inline-size:760px;margin:48px auto;padding:0 16px}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.15);padding:24px}
.brand{font-weight:700;color:#0b5394;margin:0 0 16px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.col h1{font-size:1.25rem;margin:0 0 8px}
.col p{margin:0 0 12px}
.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-block-start:20px}
button{font:inherit;font-weight:600;border:0;border-radius:6px;padding:10px 18px;background:#0b5394;color:#fff;cursor:pointer}
button[disabled]{opacity:.6;cursor:progress}
a{color:#0b5394}
code{background:#eef1f4;border-radius:4px;padding:2px 6px}
.note{font-size:.9rem;color:#5d6d7e}
@media (max-width:480px){.cols{grid-template-columns:1fr}main{margin:16px auto}}
`;

function layout(title: string, body: string, extraHead = ''): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${extraHead}
</head>
<body>
<main>
<div class="card">
<p class="brand">HRForce</p>
${body}
</div>
</main>
</body>
</html>`;
}

function columns(fr: string, ar: string): string {
  return `<div class="cols"><section class="col" dir="ltr" lang="fr">${fr}</section><section class="col" dir="rtl" lang="ar">${ar}</section></div>`;
}

export interface LogoutPageModel {
  /** auto: signs out at once (a valid id_token_hint); confirm: asks first (no hint) */
  mode: 'auto' | 'confirm';
  /** the hint's `sub` (auto mode): the HRForce logout call only acts on that user's session */
  sub: string | null;
  /** the provider's confirm URL (/oidc/session/end/confirm) */
  action: string;
  /** the provider's logout xsrf value */
  xsrf: string;
  /** the app's names (from the hint's client, when known) */
  appName: string | null;
  appNameAr: string | null;
  /** `${WEB_BASE_URL}/` */
  homeUrl: string;
}

/** The provider's confirm form: xsrf + logout=yes (ends the provider session and revokes the grants' tokens). */
function logoutForm(model: LogoutPageModel): string {
  return `<form id="${LOGOUT_FORM_ID}" method="post" action="${escapeHtml(model.action)}">`
    + `<input type="hidden" name="xsrf" value="${escapeHtml(model.xsrf)}">`
    + `<input type="hidden" name="logout" value="yes">`
    + `</form>`;
}

export function renderLogoutPage(model: LogoutPageModel): string {
  const app = model.appName ? escapeHtml(model.appName) : null;
  const appAr = model.appNameAr ? escapeHtml(model.appNameAr) : app;
  const data = `id="hrf-logout" data-mode="${model.mode}" data-form="${LOGOUT_FORM_ID}"${model.mode === 'auto' && model.sub ? ` data-sub="${escapeHtml(model.sub)}"` : ''}`;
  const noscript = `<noscript><p class="note" dir="ltr" lang="fr">JavaScript est désactivé : seule la session de connexion unique sera fermée. Pour vous déconnecter de HRForce, utilisez le menu de HRForce.</p>`
    + `<p class="note" dir="rtl" lang="ar">JavaScript معطّل: سيتم إغلاق جلسة الدخول الموحد فقط. لتسجيل الخروج من HRForce، يرجى استعمال قائمة HRForce.</p></noscript>`;
  const home = escapeHtml(model.homeUrl);
  const body =
    model.mode === 'auto'
      ? columns('<h1>Déconnexion en cours…</h1>', '<h1>جارٍ تسجيل الخروج…</h1>')
        + `<div class="actions" ${data}><noscript><button type="submit" form="${LOGOUT_FORM_ID}">Se déconnecter / تسجيل الخروج</button></noscript></div>${noscript}`
      : columns(
          `<h1>${app ? `Se déconnecter de HRForce et de « ${app} » ?` : 'Se déconnecter de HRForce ?'}</h1>`,
          `<h1>${appAr ? `تسجيل الخروج من HRForce ومن «${appAr}»؟` : 'تسجيل الخروج من HRForce؟'}</h1>`,
        )
        + `<div class="actions" ${data}><button id="hrf-logout-confirm" type="submit" form="${LOGOUT_FORM_ID}">Se déconnecter / تسجيل الخروج</button>`
        + `<a href="${home}">Retour à HRForce</a> <a href="${home}" dir="rtl" lang="ar">العودة إلى HRForce</a></div>${noscript}`;
  return layout('Déconnexion — HRForce', `${body}${logoutForm(model)}`, `<script src="${END_SESSION_SCRIPT_PATH}" defer></script>`);
}

/** postLogoutSuccessSource: no post_logout_redirect_uri was given. */
export function renderSignedOutPage(homeUrl: string): string {
  const home = escapeHtml(homeUrl);
  return layout(
    'Déconnecté — HRForce',
    columns(`<h1>Vous êtes déconnecté(e).</h1><p><a href="${home}">Retour à HRForce</a></p>`, `<h1>تم تسجيل الخروج.</h1><p><a href="${home}">العودة إلى HRForce</a></p>`),
  );
}

/** renderError: the OAuth error code only — never the description of a server error, never a stack. */
export function renderErrorPage(error: string): string {
  const code = /^[a-z_]{1,64}$/.test(error) ? error : 'server_error';
  return layout(
    'Connexion impossible — HRForce',
    columns(
      `<h1>Connexion impossible</h1><p>L'application n'est pas reconnue ou la demande est invalide.</p><p><code dir="ltr">${code}</code></p>`,
      `<h1>تعذّر تسجيل الدخول</h1><p>التطبيق غير معروف أو الطلب غير صالح.</p><p><code dir="ltr">${code}</code></p>`,
    ),
  );
}

/**
 * /oidc/assets/end-session.js (served by the API before the provider mount; `script-src 'self'`). Steps
 * (docs/contracts/sso.md › Logout flow): 1. the XSRF cookie for the current HRForce session (GET /api/auth/csrf);
 * 2. POST /api/auth/logout, with `{expectedUserId}` in auto mode (any outcome is ignored); 3. submit the provider's
 * confirm form. In confirm mode the button starts the same steps without `expectedUserId`.
 */
export const END_SESSION_SCRIPT = `(function () {
  'use strict';
  var root = document.getElementById('hrf-logout');
  if (!root) return;
  var form = document.getElementById(root.getAttribute('data-form') || '${LOGOUT_FORM_ID}');
  if (!form) return;
  var mode = root.getAttribute('data-mode');
  var sub = root.getAttribute('data-sub');
  function xsrf() {
    var match = document.cookie.match(/(?:^|;\\s*)XSRF-TOKEN=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  function signOutOfHrforce(expectedUserId) {
    return fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })
      .catch(function () { return null; })
      .then(function () {
        var headers = { 'Content-Type': 'application/json' };
        var token = xsrf();
        if (token) headers['X-XSRF-TOKEN'] = token;
        return fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: headers,
          body: JSON.stringify(expectedUserId ? { expectedUserId: expectedUserId } : {})
        });
      })
      .catch(function () { return null; });
  }
  var started = false;
  function run(expectedUserId) {
    if (started) return;
    started = true;
    signOutOfHrforce(expectedUserId).then(function () { form.submit(); });
  }
  if (mode === 'auto') {
    run(sub);
  } else {
    var button = document.getElementById('hrf-logout-confirm');
    if (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        button.disabled = true;
        run(null);
      });
    }
  }
})();
`;
