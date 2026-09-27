import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Server-Sent Events client for the e2e tests (GET /api/me/notifications/stream): a real HTTP connection to the app
 * (the server is started on an ephemeral port on first use — supertest reuses it), parsing `event:`/`data:` blocks
 * as they arrive. `close()` ends the connection like a browser tab would.
 */
export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseStream {
  status: number;
  headers: IncomingHttpHeaders;
  events: SseEvent[];
  /** raw text received so far (comments such as `: ping` included) */
  raw: () => string;
  /** resolves when the server ends the stream */
  ended: Promise<void>;
  /** waits until an event matching `predicate` has arrived (rejects after `timeoutMs`) */
  next: (predicate: (e: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  const out: { resolve: (() => void) | null } = { resolve: null };
  const promise = new Promise<void>((r) => {
    out.resolve = r;
  });
  return { promise, resolve: () => out.resolve?.() };
}

async function baseUrl(app: NestExpressApplication): Promise<string> {
  const server = app.getHttpServer() as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export async function openSse(app: NestExpressApplication, path: string, headers: Record<string, string> = {}): Promise<SseStream> {
  const url = new URL(path, await baseUrl(app));
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      let buffer = '';
      let raw = '';
      const events: SseEvent[] = [];
      const waiters: { predicate: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }[] = [];
      const end = deferred();
      const ended = end.promise;
      const endResolve = end.resolve;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        buffer += chunk;
        let cut: number;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!name || data === undefined) continue;
          const e = { event: name, data: JSON.parse(data) as unknown };
          events.push(e);
          for (const w of waiters.filter((x) => x.predicate(e))) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(e);
          }
        }
      });
      res.on('end', () => endResolve());
      res.on('close', () => endResolve());
      res.on('error', () => endResolve());
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        events,
        raw: () => raw,
        ended,
        next: (predicate, timeoutMs = 3000) => {
          const found = events.find(predicate);
          if (found) return Promise.resolve(found);
          return new Promise((res2, rej) => {
            const timer = setTimeout(() => rej(new Error(`no matching SSE event within ${timeoutMs} ms; got ${JSON.stringify(events)}`)), timeoutMs);
            waiters.push({
              predicate,
              resolve: (e) => {
                clearTimeout(timer);
                res2(e);
              },
            });
          });
        },
        close: () => {
          req.destroy();
          endResolve();
        },
      });
    });
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}
