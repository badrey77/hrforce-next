/**
 * `NOT_FOUND_ROUTE` — the app's 404 page as a route entry, used LAST in app.routes.ts and in the child tables of the
 * features whose landing page has its own permission (features/leave/leave.routes.ts, features/documents/documents.routes.ts).
 *
 * Angular concepts:
 * - **Why a feature needs its own `**`.** The router matches a URL segment by segment. `/leave` is consumed entirely
 *   by the parent route `path: 'leave'`; what is left for the children is NOTHING (zero segments). When no child
 *   matches an empty remainder — here because the `''` child's `canMatch` said no — the router does not go back
 *   and try the app's next routes: it accepts the parent with an EMPTY outlet (the recogniser treats "no segments
 *   left" as a successful match). The page was blank. A non-empty remainder (`/leave/settings`) that no child
 *   matches is different: those segments are "left over", the parent match fails, and the app-level `**` shows the
 *   404. A `**` at the end of the child table catches both cases inside the feature, so every refused URL renders
 *   the same page.
 * - **`path: '**'` matches any remainder, including an empty one**, so it must come after every other child.
 * - The page stays a `loadComponent`: one small chunk, shared by every table that lists this entry.
 * - It lives in shared/ (not features/) because features may not import one another (.dependency-cruiser.cjs,
 *   `web-feature-isolation`).
 */
import type { Route } from '@angular/router';

export const NOT_FOUND_ROUTE: Route = {
  path: '**',
  loadComponent: () => import('./not-found.page').then((m) => m.NotFoundPage),
};
