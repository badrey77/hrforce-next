import { describe, expect, it } from 'vitest';
import { END_SESSION_SCRIPT, END_SESSION_SCRIPT_PATH, escapeHtml, renderErrorPage, renderLogoutPage, renderSignedOutPage, type LogoutPageModel } from './oidc-pages.js';

const base: LogoutPageModel = {
  mode: 'auto',
  sub: '0190a5d0-0000-7000-8000-0000000000aa',
  action: 'http://localhost:4200/oidc/session/end/confirm',
  xsrf: 'abc123',
  appName: 'Démo SSO',
  appNameAr: 'تطبيق تجريبي',
  homeUrl: 'http://localhost:4200/',
};

/** Inline scripts: any <script> without a src attribute. */
const inlineScripts = (html: string) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];

describe('OIDC pages', () => {
  it('auto mode: bilingual, the hint sub and the form for the external script, no inline script', () => {
    const html = renderLogoutPage(base);
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('Déconnexion en cours…');
    expect(html).toContain('جارٍ تسجيل الخروج…');
    expect(html).toContain('dir="rtl" lang="ar"');
    expect(html).toContain(`data-mode="auto"`);
    expect(html).toContain(`data-sub="${base.sub}"`);
    expect(html).toContain('<input type="hidden" name="xsrf" value="abc123">');
    expect(html).toContain('<input type="hidden" name="logout" value="yes">');
    expect(html).toContain(`<script src="${END_SESSION_SCRIPT_PATH}" defer></script>`);
    expect(inlineScripts(html)).toHaveLength(0);
    expect(html).not.toMatch(/fonts\.googleapis|https?:\/\/(?!localhost)/);
  });

  it('confirm mode: asks with the app name (Arabic name in the Arabic block), no sub, a way back to HRForce', () => {
    const html = renderLogoutPage({ ...base, mode: 'confirm', sub: null });
    expect(html).toContain('Se déconnecter de HRForce et de « Démo SSO » ?');
    expect(html).toContain('تسجيل الخروج من HRForce ومن «تطبيق تجريبي»؟');
    expect(html).toContain('data-mode="confirm"');
    expect(html).not.toContain('data-sub');
    expect(html).toContain('Retour à HRForce');
    expect(html).toContain('العودة إلى HRForce');
    expect(html).toContain('seule la session de connexion unique sera fermée');
    expect(renderLogoutPage({ ...base, mode: 'confirm', sub: null, appName: null, appNameAr: null })).toContain('Se déconnecter de HRForce ?');
  });

  it('escapes every value', () => {
    const html = renderLogoutPage({ ...base, mode: 'confirm', appName: '<script>alert(1)</script>', appNameAr: null, xsrf: '"><img src=x>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
    expect(html).not.toContain('"><img');
    expect(escapeHtml(`<>&"'\``)).toBe('&#60;&#62;&#38;&#34;&#39;&#96;');
  });

  it('signed-out and error pages: bilingual, error code only', () => {
    const out = renderSignedOutPage('http://localhost:4200/');
    expect(out).toContain('Vous êtes déconnecté(e).');
    expect(out).toContain('تم تسجيل الخروج.');
    const error = renderErrorPage('invalid_request');
    expect(error).toContain('Connexion impossible');
    expect(error).toContain('تعذّر تسجيل الدخول');
    expect(error).toContain('<code dir="ltr">invalid_request</code>');
    expect(renderErrorPage('<b>x</b>')).toContain('<code dir="ltr">server_error</code>');
    expect(inlineScripts(error)).toHaveLength(0);
  });

  it('the external script calls the HRForce logout then submits the provider form', () => {
    expect(END_SESSION_SCRIPT).toContain("fetch('/api/auth/logout'");
    expect(END_SESSION_SCRIPT).toContain('expectedUserId');
    expect(END_SESSION_SCRIPT).toContain('form.submit()');
    expect(END_SESSION_SCRIPT).toContain("credentials: 'same-origin'");
  });
});
