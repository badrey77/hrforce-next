/**
 * Page builders (docs/contracts/sso.md › Demo sister app › Pages). Pure functions: data in, escaped HTML out.
 * No client-side JavaScript at all; the only stylesheet is /assets/demo.css (CSP `style-src 'self'`).
 */
import type { DemoUser } from './claims.js';
import { html, type SafeHtml } from './html.js';
import { dirOf, type Lang, roleLabel, STRINGS } from './i18n.js';

/** Pages a language link may return to (`/lang/:lang?next=…`). */
export const PAGE_PATHS = ['/', '/welcome', '/signed-out'] as const;
export type PagePath = (typeof PAGE_PATHS)[number];

interface LayoutInput {
  lang: Lang;
  title: string;
  /** the page to come back to after switching language */
  path: PagePath;
  body: SafeHtml;
}

function layout({ lang, title, path, body }: LayoutInput): string {
  const t = STRINGS[lang];
  const other: Lang = lang === 'fr' ? 'ar' : 'fr';
  return html`<!doctype html>
<html lang="${lang}" dir="${dirOf(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<link rel="stylesheet" href="/assets/demo.css">
</head>
<body>
<header class="bar">
<span class="product">${t.productLine}</span>
<a class="lang" href="/lang/${other}?next=${encodeURIComponent(path)}" lang="${other}" hreflang="${other}">${t.switchTo}</a>
</header>
<main class="card">
${body}
</main>
</body>
</html>
`.value;
}

export function homePage(lang: Lang, options: { cancelled?: boolean } = {}): string {
  const t = STRINGS[lang];
  return layout({
    lang,
    title: t.homeTitle,
    path: '/',
    body: html`<h1>${t.homeTitle}</h1>
${options.cancelled ? html`<p class="notice" role="status">${t.cancelled}</p>` : ''}
<p>${t.homeText}</p>
<p><a class="button" href="/login">${t.signIn}</a></p>`,
  });
}

export function welcomePage(lang: Lang, user: DemoUser, claims: Record<string, unknown>): string {
  const t = STRINGS[lang];
  const unit = user.employee?.unit;
  const unitName = unit ? (lang === 'ar' && unit.nameAr ? unit.nameAr : unit.name) : null;
  const rows: [string, SafeHtml | string][] = [];
  if (user.email) rows.push([t.email, html`<bdi dir="ltr">${user.email}</bdi>`]);
  if (user.company) rows.push([t.company, user.company]);
  if (user.employee) {
    rows.push([t.matricule, html`<bdi dir="ltr">${user.employee.matricule}</bdi>`]);
    rows.push([t.unit, unitName ?? '—']);
  }
  const roles = user.roles.length
    ? html`<h2>${t.rolesHeading(user.roles.length)}</h2>
<ul class="roles">${user.roles.map((code) => html`<li><bdi>${roleLabel(code, lang)}</bdi></li>`)}</ul>`
    : html`<h2>${t.rolesHeading(1)}</h2>
<p class="notice" role="status">${t.noRole}</p>`;
  return layout({
    lang,
    title: t.homeTitle,
    path: '/welcome',
    body: html`<h1>${t.welcome(user.name)}</h1>
<dl>${rows.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>
${user.employee ? '' : html`<p class="notice">${t.noEmployee}</p>`}
${roles}
<details>
<summary>${t.claimsSummary}</summary>
<pre dir="ltr" lang="en">${JSON.stringify(claims, null, 2)}</pre>
</details>
<form method="post" action="/logout"><button type="submit">${t.signOut}</button></form>`,
  });
}

export function signedOutPage(lang: Lang): string {
  const t = STRINGS[lang];
  return layout({
    lang,
    title: t.homeTitle,
    path: '/signed-out',
    body: html`<h1>${t.homeTitle}</h1>
<p>${t.signedOut}</p>
<p><a class="button" href="/login">${t.signIn}</a></p>`,
  });
}

/** `code` is an OAuth error code (or a fixed local one), never an error description. */
export function errorPage(lang: Lang, code: string): string {
  const t = STRINGS[lang];
  return layout({
    lang,
    title: t.errorTitle,
    path: '/',
    body: html`<h1>${t.errorTitle}</h1>
<p class="notice error" role="alert">${t.error(code)}</p>
<p><a href="/">${t.backHome}</a></p>`,
  });
}

export function notFoundPage(lang: Lang): string {
  const t = STRINGS[lang];
  return layout({
    lang,
    title: t.notFound,
    path: '/',
    body: html`<h1>${t.notFound}</h1>
<p><a href="/">${t.backHome}</a></p>`,
  });
}
