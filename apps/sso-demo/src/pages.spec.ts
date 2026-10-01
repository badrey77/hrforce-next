import { describe, expect, it } from 'vitest';
import { readUser } from './claims.js';
import { roleLabel } from './i18n.js';
import { errorPage, homePage, signedOutPage, welcomePage } from './pages.js';

const claims = {
  sub: '0192f000-0000-7000-8000-000000000030',
  name: 'Amine Agent',
  email: 'agent.annaba@demo.dz',
  locale: 'fr',
  company: { id: 'c1', code: 'DEMO', name: 'Démo SPA' },
  employee: { matricule: 'EMP-0030', active: true, unit: { id: 'u1', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة' } },
  roles: ['operator'],
};

describe('role labels', () => {
  it('translates the known roles and shows an unknown code as is', () => {
    expect(roleLabel('operator', 'fr')).toBe('Opérateur');
    expect(roleLabel('operator', 'ar')).toBe('التشغيل');
    expect(roleLabel('supervisor', 'fr')).toBe('Superviseur');
    expect(roleLabel('supervisor', 'ar')).toBe('الإشراف');
    expect(roleLabel('auditor', 'fr')).toBe('auditor');
    expect(roleLabel('constructor', 'ar')).toBe('constructor');
  });
});

describe('pages', () => {
  it('home: lang/dir per language, sign-in link, no script, stylesheet only', () => {
    const fr = homePage('fr');
    expect(fr).toContain('<html lang="fr" dir="ltr">');
    expect(fr).toContain('Se connecter avec HRForce');
    expect(fr).toContain('href="/login"');
    expect(fr).toContain('Démo SSO — application sœur fictive');
    expect(fr).toContain('href="/lang/ar?next=%2F"');
    expect(fr).not.toMatch(/<script|style=|\son\w+=/i);
    const ar = homePage('ar');
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain('تسجيل الدخول عبر HRForce');
    expect(ar).toContain('تطبيق تجريبي — تطبيق شقيق افتراضي');
    expect(homePage('fr', { cancelled: true })).toContain('Connexion annulée.');
  });

  it('welcome (fr): identity, unit, role label, claims panel and sign-out form', () => {
    const page = welcomePage('fr', readUser(claims), claims);
    expect(page).toContain('Bienvenue, Amine Agent');
    expect(page).toContain('EMP-0030');
    expect(page).toContain('Agence Annaba');
    expect(page).toContain('Démo SPA');
    expect(page).toContain('Rôle dans cette application');
    expect(page).toContain('<bdi>Opérateur</bdi>');
    expect(page).toContain('Données reçues (jeton d&#39;identité)');
    expect(page).toContain('<pre dir="ltr" lang="en">');
    expect(page).toContain('<form method="post" action="/logout">');
    expect(page).not.toContain('Aucun rôle');
  });

  it('welcome (ar): rtl, Arabic unit name, plural heading for several roles', () => {
    const c = { ...claims, roles: ['operator', 'supervisor'] };
    const page = welcomePage('ar', readUser(c), c);
    expect(page).toContain('<html lang="ar" dir="rtl">');
    expect(page).toContain('مرحبا، Amine Agent');
    expect(page).toContain('وكالة عنابة');
    expect(page).toContain('الأدوار في هذا التطبيق');
    expect(page).toContain('التشغيل');
    expect(page).toContain('الإشراف');
  });

  it('welcome: the no-role notice when roles is empty', () => {
    const c = { ...claims, roles: [] };
    expect(welcomePage('fr', readUser(c), c)).toContain('Aucun rôle ne vous est attribué dans cette application.');
    expect(welcomePage('ar', readUser(c), c)).toContain('لم يُسند أي دور لهذا الحساب في هذا التطبيق.');
  });

  it('welcome: a null employee shows the no-file message and no matricule/unit rows', () => {
    const c = { ...claims, employee: null };
    const page = welcomePage('fr', readUser(c), c);
    expect(page).toContain('Aucun dossier salarié n&#39;est rattaché à ce compte.');
    expect(page).not.toContain('Matricule');
    expect(welcomePage('ar', readUser(c), c)).toContain('لا يوجد ملف وظيفي مرتبط بهذا الحساب.');
  });

  it('escapes a hostile name, role code and unit everywhere (heading, list, claims JSON)', () => {
    const evil = '<script>alert(1)</script>';
    const c = { ...claims, name: evil, roles: [evil], employee: { matricule: evil, unit: { name: evil, nameAr: null } } };
    const page = welcomePage('fr', readUser(c), c);
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('signed-out and error pages', () => {
    expect(signedOutPage('fr')).toContain('Vous êtes déconnecté(e) de la démo et de HRForce.');
    expect(signedOutPage('ar')).toContain('تم تسجيل الخروج من التطبيق التجريبي ومن HRForce.');
    expect(errorPage('fr', 'invalid_grant')).toContain('La connexion a échoué (invalid_grant). Veuillez réessayer.');
    expect(errorPage('ar', 'invalid_grant')).toContain('تعذّر تسجيل الدخول (invalid_grant). يرجى إعادة المحاولة.');
    expect(errorPage('fr', '<b>')).toContain('(&lt;b&gt;)');
  });
});

describe('readUser', () => {
  it('tolerates missing or malformed claims', () => {
    expect(readUser({ sub: 'u1' })).toEqual({ name: 'u1', email: null, company: null, employee: null, roles: [], locale: null });
    expect(readUser({ sub: 'u1', roles: ['a', 3, null], employee: 'x', company: [] }).roles).toEqual(['a']);
  });
});
