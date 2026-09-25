import { randomBytes } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

/** argon2id, OWASP parameters (docs/contracts/identity.md › Passwords): m = 19 456 KiB, t = 2, p = 1. */
// `Algorithm` is an ambient const enum (not importable as a value under isolatedModules): Argon2id = 2.
const ARGON2ID = 2 as Algorithm;
export const ARGON2_OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Hashes/verifies passwords. `verify(null, …)` runs a full argon2 verification against a fixed dummy hash (made once
 * per process from random bytes) and returns false, so unknown e-mails and accounts without a password take about
 * as long as a wrong password.
 */
@Injectable()
export class PasswordHasher {
  private dummy: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    if (passwordHash === null) {
      await this.safeVerify(await this.dummyHash(), password);
      return false;
    }
    return this.safeVerify(passwordHash, password);
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= hash(randomBytes(32).toString('base64url'), ARGON2_OPTIONS);
    return this.dummy;
  }

  private async safeVerify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // malformed stored hash: never a match
    }
  }
}
