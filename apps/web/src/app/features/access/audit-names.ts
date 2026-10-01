/**
 * Names for ids in an audit timeline shown on an Access page (`resolver` input of `<app-history-tabs>` /
 * `<app-timeline>`): roles and permissions from the app-wide `AccessCatalog`, plus whatever the page knows (units and
 * users of the grants it shows, the roles of a connected app). Plain function — no Angular of its own — but the lookups
 * READ SIGNALS (the catalogue, the page's resources), so the timeline's `computed()` re-runs when they load or when the
 * language changes.
 */
import type { AccessCatalog } from '../../core/access/access-catalog';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';

export function accessAuditNames(
  catalog: AccessCatalog,
  known: {
    units?: () => ReadonlyMap<string, string>;
    users?: () => ReadonlyMap<string, string>;
    /** Connected-app role id → a label (its code, or "App — code"). */
    appRoles?: () => ReadonlyMap<string, string>;
  } = {},
): AuditNameResolver {
  return (kind, value) => {
    switch (kind) {
      case 'role': {
        const role = catalog.roleById(value);
        return role ? catalog.roleName(role) : undefined;
      }
      case 'roleCode': {
        const role = catalog.roles().find((r) => r.code === value);
        return role ? catalog.roleName(role) : undefined;
      }
      case 'permission':
        return catalog.permissionLabel(value);
      case 'unit':
        return known.units?.().get(value);
      case 'user':
        return known.users?.().get(value);
      case 'appRole':
        return known.appRoles?.().get(value);
      default:
        return undefined;
    }
  };
}
