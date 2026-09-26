/**
 * CLI: invite a user (docs/contracts/identity.md › CLI and seed) — the only way to create accounts until the admin UI.
 *   npm run user:invite -w @hrforce/api -- --email x@y --name "Prénom Nom" --company <code> [--locale fr|ar|en]
 * Runs as the migrator (MIGRATOR_DATABASE_URL): creates an INVITED account + membership (and the company's system
 * roles when it has none — docs/contracts/authorization.md) and mails a setup link
 * (`${WEB_BASE_URL}/password/setup?token=…`, valid 72 h) through MAIL_TRANSPORT (smtp → SMTP_URL; log → stdout log,
 * development/test only).
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { z } from 'zod';
import { migratorEnvSchema } from '../platform/config/env.schema.js';
import { parseEnv } from '../platform/config/load-env.js';
import { createDatabase } from '../platform/db/database.js';
import { seedSystemRoles } from '../modules/authorization/index.js';
import { createMailSender, inviteUser, passwordLink, passwordMail } from '../modules/identity/index.js';

const DEV_ONLY = ['development', 'test'];

const inviteEnvSchema = migratorEnvSchema
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

const USAGE = 'usage: npm run user:invite -w @hrforce/api -- --email x@y --name "…" --company <code> [--locale fr|ar|en]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      company: { type: 'string' },
      locale: { type: 'string' },
    },
    strict: true,
  });
  if (!values.email || !values.name || !values.company) throw new Error(USAGE);

  const env = parseEnv(inviteEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'user-invite' });
  const mail = createMailSender(env, { info: (payload, message) => logger.info(payload, message) });
  const db = createDatabase({ connectionString: env.MIGRATOR_DATABASE_URL, maxConnections: 1, applicationName: 'hrforce-user-invite' });
  try {
    const { result, rolesSeeded } = await db.transaction().execute(async (tx) => {
      const invited = await inviteUser(tx, {
        email: values.email ?? '',
        displayName: values.name ?? '',
        companyCode: values.company ?? '',
        ...(values.locale ? { locale: values.locale } : {}),
      });
      const company = await tx.selectFrom('company').select('id').where('code', '=', values.company ?? '').executeTakeFirstOrThrow();
      return { result: invited, rolesSeeded: await seedSystemRoles(tx, company.id, { onlyIfNone: true }) };
    });
    if (rolesSeeded) logger.info({ company: values.company }, 'system roles created for the company (it had none)');
    if (result.setupToken) {
      await mail.send(
        passwordMail({
          purpose: 'setup',
          locale: result.locale,
          displayName: result.displayName,
          to: result.email,
          link: passwordLink(env.WEB_BASE_URL, result.setupToken),
        }),
      );
    }
    logger.info(
      { userId: result.userId, email: result.email, company: values.company, created: result.created, mailed: result.setupToken !== null },
      result.setupToken
        ? `invitation sent to ${result.email} (${result.companyName})`
        : `${result.email} is already active: membership of ${result.companyName} ensured, no mail sent`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`user:invite: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
