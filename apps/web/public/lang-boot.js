// Sets <html lang dir> from the language stored on this device BEFORE the page is first styled.
//
// Why: index.html ships `lang="fr" dir="ltr"`, and Angular's LanguageService only applies the stored language once
// the app boots. In between, the browser already styles the document for French: the font stack of `:root` (styles.css)
// starts with Source Sans 3, so an Arabic session downloaded a Latin Source Sans 3 file it never used, and the first
// frames were laid out left-to-right. Running this tiny script from <head> fixes both: when the body is parsed,
// `:root:lang(ar)` already applies (Cairo first) and `dir="rtl"` is in place.
//
// Why a separate file and not an inline <script>: the Content-Security-Policy (deploy/Caddyfile) is
// `script-src 'self'` — no inline scripts — and deploy/web/check-index-csp.mjs fails the image build on any.
// A same-origin file is allowed as is, without weakening the policy. It is a CLASSIC script (not a module, no
// `defer`) on purpose: the parser runs it before it reaches <body>.
//
// Keep in sync with core/i18n/language.service.ts (LANGUAGE_STORAGE_KEY) and core/i18n/languages.ts (languages,
// RTL set). LanguageService stays the authority: it re-applies the language at startup and may still switch to the
// account's locale after sign-in (a device without a stored choice starts in French, as before).
(function applyStoredLanguage() {
  'use strict';
  try {
    var lang = window.localStorage.getItem('hrforce.lang');
    if (lang === 'fr' || lang === 'ar' || lang === 'en') {
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    }
  } catch {
    // Storage blocked (privacy settings): keep the defaults of index.html; LanguageService handles the rest.
  }
})();
