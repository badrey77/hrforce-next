/** Outgoing mail port. Adapters: SmtpMailSender (nodemailer → SMTP_URL) and LogMailSender (dev/test only). */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export abstract class MailSender {
  abstract send(message: MailMessage): Promise<void>;
}
