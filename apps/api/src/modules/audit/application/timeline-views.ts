import type { FieldChange } from '../domain/timeline.js';

/** docs/contracts/audit.md › Endpoint. */
export interface TimelineEntry {
  /** "c:<id>" (change_log) or "e:<id>" (event) */
  id: string;
  at: string;
  /** null = system / seed / migration */
  actor: { id: string; displayName: string } | null;
  requestId: string | null;
  kind: 'change' | 'event';
  table?: string;
  op?: 'insert' | 'update' | 'delete';
  changes?: FieldChange[];
  event?: { type: string; data: Record<string, unknown> };
}

export interface TimelineView {
  items: TimelineEntry[];
  nextCursor: string | null;
}
