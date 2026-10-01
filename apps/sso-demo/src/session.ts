/**
 * In-memory sessions (docs/contracts/sso.md › Demo sister app › Session). Fine for a demo: a restart signs everyone
 * out. Ids are 32 random bytes (base64url); an entry expires after 8 h without use, a pending sign-in after 10 min.
 */
import { randomBytes } from 'node:crypto';
import type { Lang } from './i18n.js';

export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingSignIn {
  codeVerifier: string;
  state: string;
  nonce: string;
  createdAt: number;
}

export interface SessionEntry {
  pending?: PendingSignIn;
  user?: { claims: Record<string, unknown>; idToken: string };
  /** the language the visitor chose (or the account's, after sign-in); unset = not chosen yet */
  lang?: Lang;
  lastSeen: number;
}

export class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Creates an entry and returns its new id. */
  create(data: Omit<SessionEntry, 'lastSeen'> = {}): { id: string; entry: SessionEntry } {
    const id = randomBytes(32).toString('base64url');
    const entry: SessionEntry = { ...data, lastSeen: this.now() };
    this.entries.set(id, entry);
    return { id, entry };
  }

  /** The live entry for `id` (touching it), or undefined. An expired pending sign-in is dropped from the entry. */
  get(id: string | undefined): SessionEntry | undefined {
    if (!id) return undefined;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.lastSeen > SESSION_IDLE_MS) {
      this.entries.delete(id);
      return undefined;
    }
    if (entry.pending && now - entry.pending.createdAt > PENDING_TTL_MS) delete entry.pending;
    entry.lastSeen = now;
    return entry;
  }

  /** Replaces `oldId` by a fresh id holding `data` (session fixation defence after sign-in). */
  regenerate(oldId: string | undefined, data: Omit<SessionEntry, 'lastSeen'>): { id: string; entry: SessionEntry } {
    if (oldId) this.entries.delete(oldId);
    return this.create(data);
  }

  destroy(id: string | undefined): void {
    if (id) this.entries.delete(id);
  }

  /** Removes idle entries; returns how many were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (now - entry.lastSeen > SESSION_IDLE_MS) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
