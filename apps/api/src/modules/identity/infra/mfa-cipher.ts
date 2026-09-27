import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV } from '../../../platform/config/config.module.js';
import { DEV_MFA_KEY, type Env } from '../../../platform/config/env.schema.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM encryption of the TOTP secrets (docs/contracts/mfa.md › Crypto): stored value = nonce (12) ‖
 * ciphertext ‖ tag (16), with the user id as additional authenticated data (a value copied onto another user fails to
 * decrypt). Key: AUTH_MFA_KEY (base64, 32 bytes); development/test fall back to the public DEV_MFA_KEY (insecure,
 * warned at boot). The database never sees the key.
 */
@Injectable()
export class MfaCipher implements OnApplicationBootstrap {
  private readonly logger = new Logger('MfaCipher');
  private readonly key: Buffer;
  private readonly devKey: boolean;

  constructor(@Inject(ENV) env: Env) {
    this.devKey = env.AUTH_MFA_KEY === undefined;
    this.key = Buffer.from(env.AUTH_MFA_KEY ?? DEV_MFA_KEY, 'base64');
    if (this.key.length !== 32) throw new Error('AUTH_MFA_KEY must decode to 32 bytes');
  }

  onApplicationBootstrap(): void {
    if (this.devKey) this.logger.warn('AUTH_MFA_KEY is not set: TOTP secrets use the PUBLIC development key (insecure; development/test only).');
  }

  encrypt(secret: Buffer, userId: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(userId, 'utf8'));
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }

  /** The secret, or null when the value was not encrypted for this user with this key (tampered, other key…). */
  decrypt(value: Buffer, userId: string): Buffer | null {
    if (value.length <= NONCE_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, NONCE_BYTES));
      decipher.setAAD(Buffer.from(userId, 'utf8'));
      decipher.setAuthTag(value.subarray(value.length - TAG_BYTES));
      return Buffer.concat([decipher.update(value.subarray(NONCE_BYTES, value.length - TAG_BYTES)), decipher.final()]);
    } catch {
      return null;
    }
  }
}
