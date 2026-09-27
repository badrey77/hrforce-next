import type { EventSourceFactory, EventSourceLike } from '../app/core/notifications/event-source';
import type { NotificationView } from '../app/core/notifications/notifications.models';

/**
 * A scriptable stand-in for the browser's `EventSource` (jsdom has none). Provide `fake.factory` for
 * `EVENT_SOURCE_FACTORY`; each connection the code opens is pushed to `fake.sources`, and the test plays the server:
 * `open()`, `send('unread', {count: 3})`, `fail()`.
 */
export class FakeEventSource implements EventSourceLike {
  closed = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.dispatch('open', new Event('open'));
  }

  send(type: string, data: unknown): void {
    this.dispatch(type, new MessageEvent(type, { data: JSON.stringify(data) }));
  }

  fail(): void {
    this.dispatch('error', new Event('error'));
  }
}

export interface FakeEventSources {
  readonly factory: EventSourceFactory;
  readonly sources: FakeEventSource[];
  /** The most recent connection. */
  last(): FakeEventSource;
}

export function fakeEventSources(): FakeEventSources {
  const sources: FakeEventSource[] = [];
  return {
    sources,
    factory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    last: () => {
      const source = sources.at(-1);
      if (!source) throw new Error('no EventSource was opened');
      return source;
    },
  };
}

/** A `NotificationView` shaped like the contract's example. */
export function notification(id: string, extra: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    type: 'task.assigned',
    createdAt: '2026-09-27T08:00:00Z',
    readAt: null,
    subject: { type: 'workflow_task', id: `k-${id}` },
    data: { employeeName: 'BENALI Amina', leaveType: 'annual', startDate: '2026-10-05', endDate: '2026-10-09', days: 5, actorName: 'Karim Haddad', stepKey: 'manager' },
    link: `/tasks?task=k-${id}`,
    ...extra,
  };
}
