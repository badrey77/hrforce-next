/**
 * CLI: first-run setup of a real company (docs/contracts/staging.md › first admin). See bootstrap-company.ts.
 *   npm run bootstrap -w @hrforce/api -- --company-code ACME --company-name "ACME SPA" \
 *     --root-code DG --root-name "Direction Générale" [--root-name-ar "المديرية العامة"] \
 *     --site-code HQ --site-name "Siège" --wilaya "Alger" \
 *     --admin-email admin@acme.dz --admin-name "Prénom Nom" [--locale fr|ar|en]
 * Runs as the migrator (MIGRATOR_DATABASE_URL) and mails the admin's setup link through MAIL_TRANSPORT.
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { z } from 'zod';
import { migratorEnvSchema } from '../platform/config/env.schema.js';
import { parseEnv } from '../platform/config/load-env.js';
import { createDatabase } from '../platform/db/database.js';
import { createMailSender, passwordLink, passwordMail } from '../modules/identity/index.js';
import { bootstrapCompany } from './bootstrap-company.js';

const DEV_ONLY = ['development', 'test'];

const bootstrapEnvSchema = migratorEnvSchema
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    WEB_BASE_URL: z
      .string()
      .regex(/^https?:\/\/[^\s?#]+$/, 'must be an http(s):// URL')
      .transform((v) => v.replace(/\/+$/, '')),
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
    SMTP_URL: z.string().regex(/^smtps?:\/\//, 'must be an smtp:// or smtps:// URL').optional(),
    MAIL_FROM: z.string().min(3).default('HRForce <no-reply@hrforce.invalid>'),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_TRANSPORT === 'log' && !DEV_ONLY.includes(env.NODE_ENV)) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'may only be log when NODE_ENV is development or test' });
    }
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'is required when MAIL_TRANSPORT is smtp' });
    }
  });

const USAGE =
  'usage: npm run bootstrap -w @hrforce/api -- --company-code X --company-name "…" --root-code DG --root-name "…" ' +
  '--site-code HQ --site-name "…" --wilaya "…" --admin-email a@b --admin-name "…" [--root-name-ar "…"] [--locale fr|ar|en]';

const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function main(): Promise<void> {
  const { values: v } = parseArgs({
    options: {
      'company-code': { type: 'string' },
      'company-name': { type: 'string' },
      'root-code': { type: 'string' },
      'root-name': { type: 'string' },
      'root-name-ar': { type: 'string' },
      'site-code': { type: 'string' },
      'site-name': { type: 'string' },
      wilaya: { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-name': { type: 'string' },
      locale: { type: 'string' },
    },
    strict: true,
  });
  const required = ['company-code', 'company-name', 'root-code', 'root-name', 'site-code', 'site-name', 'wilaya', 'admin-email', 'admin-name'] as const;
  const missing = required.filter((k) => !v[k]);
  if (missing.length > 0) throw new Error(`missing --${missing.join(', --')}\n${USAGE}`);

  const env = parseEnv(bootstrapEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'bootstrap' });
  const mail = createMailSender(env, { info: (payload, message) => logger.info(payload, message) });
  const db = createDatabase({ connectionString: env.MIGRATOR_DATABASE_URL, maxConnections: 1, applicationName: 'hrforce-bootstrap' });
  try {
    const result = await db.transaction().execute((tx) =>
      bootstrapCompany(
        tx,
        {
          companyCode: v['company-code'] ?? '',
          companyName: v['company-name'] ?? '',
          rootCode: v['root-code'] ?? '',
          rootName: v['root-name'] ?? '',
          ...(v['root-name-ar'] ? { rootNameAr: v['root-name-ar'] } : {}),
          siteCode: v['site-code'] ?? '',
          siteName: v['site-name'] ?? '',
          wilaya: v.wilaya ?? '',
          adminEmail: v['admin-email'] ?? '',
          adminName: v['admin-name'] ?? '',
          ...(v.locale ? { adminLocale: v.locale } : {}),
        },
        localToday(),
      ),
    );
    const { admin } = result;
    if (admin.setupToken) {
      await mail.send(
        passwordMail({ purpose: 'setup', locale: admin.locale, displayName: admin.displayName, to: admin.email, link: passwordLink(env.WEB_BASE_URL, admin.setupToken) }),
      );
    }
    logger.info(
      { companyId: result.companyId, rootUnitId: result.rootUnitId, admin: admin.email, mailed: admin.setupToken !== null },
      `company ${v['company-code']} created; ${admin.email} is admin_rh_central on the whole company` +
        (admin.setupToken ? ' — password setup link sent' : ' (account already active, no mail sent)'),
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`bootstrap: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
