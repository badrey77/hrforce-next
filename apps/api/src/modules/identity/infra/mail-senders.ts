import { Logger as NestLogger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../../../platform/config/env.schema.js';
import { MailSender, type MailMessage } from '../application/mail-sender.js';

/** Sends through SMTP (Mailpit in development: docker-compose `mailpit`, SMTP_URL=smtp://localhost:1025). */
export class SmtpMailSender extends MailSender {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    this.transport = createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
  }
}

export interface InfoLogger {
  info(payload: object, message: string): void;
}

/**
 * DEVELOPMENT/TEST ONLY (the env schema refuses MAIL_TRANSPORT=log elsewhere): writes the mail — including the
 * password link — to the logger at `info` instead of sending it.
 */
export class LogMailSender extends MailSender {
  constructor(private readonly logger: InfoLogger = nestInfoLogger('Mail')) {
    super();
  }

  send(message: MailMessage): Promise<void> {
    this.logger.info({ mail: { to: message.to, subject: message.subject, text: message.text } }, `mail to ${message.to}: ${message.subject}`);
    return Promise.resolve();
  }
}

function nestInfoLogger(context: string): InfoLogger {
  const logger = new NestLogger(context);
  return { info: (payload, message) => logger.log(payload, message) };
}

export function createMailSender(env: Pick<Env, 'MAIL_TRANSPORT' | 'SMTP_URL' | 'MAIL_FROM'>, logger?: InfoLogger): MailSender {
  if (env.MAIL_TRANSPORT === 'log') return new LogMailSender(logger);
  if (!env.SMTP_URL) throw new Error('SMTP_URL is required when MAIL_TRANSPORT=smtp');
  return new SmtpMailSender(env.SMTP_URL, env.MAIL_FROM);
}
