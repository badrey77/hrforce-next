/**
 * AccessCatalog — the permission catalogue and the company's roles, as app-wide signals, with labels in the active
 * language. Same pattern as core/org/kind-catalog.ts (read its header): a root service holds `httpResource`s and
 * exposes `computed()` views; `permissionLabel()` / `roleName()` read `LanguageService.current()`, so templates
 * calling them re-render on a language switch.
 *
 * What is new compared with KindCatalog:
 * - **Resources that wait for a condition.** The kind catalogue is fetched unconditionally. These endpoints need
 *   `access.read`, and roles belong to a company. So the request functions read signals from `Session`:
 *   `canRead` (a per-code `computed` from `session.allows()`) and `companyId`. Signed out or without the
 *   permission → `undefined` → no request (status `idle`), instead of a 403. Signing in as someone else (another
 *   company) changes `companyId` and the roles are fetched again — no manual cache invalidation.
 * - **Why `companyId` is a string computed, not `session.company()`.** `session.company()` is a new object every time
 *   `/api/me` is set, even for the same company. A `computed()` returning the id string only notifies when the
 *   STRING changes (computeds compare with `Object.is`), so a session refresh does not re-fetch the roles.
 * - **A catalogue that changes.** Roles are edited in the Access screens; after a successful write the editor calls
 *   `reloadRoles()`, and every screen reading `roles()` (the list, the grant form's select) follows.
 */
import { computed, Injectable, inject } from '@angular/core';
import { Session } from '../auth/session';
import { LanguageService } from '../i18n/language.service';
import { AccessApi } from './access-api';
import type { LocalizedText, Permission, PermissionGroup, Role } from './access.models';

/** Permissions of one catalogue group, in catalogue order. */
export interface PermissionGroupView {
  readonly group: PermissionGroup;
  readonly permissions: readonly Permission[];
}

@Injectable({ providedIn: 'root' })
export class AccessCatalog {
  private readonly language = inject(LanguageService);
  private readonly session = inject(Session);
  private readonly api = inject(AccessApi);

  private readonly canRead = this.session.allows('access.read');
  private readonly companyId = computed(() => (this.canRead() ? this.session.company()?.id : undefined));

  private readonly permissionsResource = this.api.permissionsResource(this.canRead);
  private readonly rolesResource = this.api.rolesResource(this.companyId);

  /** The catalogue as the API sorts it (group, then sortOrder); empty until loaded. */
  readonly permissions = computed<readonly Permission[]>(() =>
    this.permissionsResource.hasValue() ? this.permissionsResource.value().items : [],
  );
  readonly permissionsLoaded = computed(() => this.permissionsResource.hasValue());
  readonly permissionsError = computed(() => this.permissionsResource.error());

  readonly roles = computed<readonly Role[]>(() => (this.rolesResource.hasValue() ? this.rolesResource.value().items : []));
  readonly rolesLoaded = computed(() => this.rolesResource.hasValue());
  /** True while a (re)load is in flight — during a reload the previous list stays in `roles()`. */
  readonly rolesLoading = computed(() => this.rolesResource.isLoading());
  readonly rolesError = computed(() => this.rolesResource.error());

  /** Groups in first-appearance order (the API already sorts by group). */
  readonly groups = computed<readonly PermissionGroupView[]>(() => {
    const byGroup = new Map<PermissionGroup, Permission[]>();
    for (const permission of this.permissions()) {
      const list = byGroup.get(permission.group) ?? [];
      list.push(permission);
      byGroup.set(permission.group, list);
    }
    return [...byGroup].map(([group, permissions]) => ({ group, permissions }));
  });

  private readonly permissionLabels = computed(() => {
    const lang = this.language.current();
    return new Map(this.permissions().map((p) => [p.code, p.labels[lang] || p.labels.fr]));
  });
  private readonly sensitiveCodes = computed(() => new Set(this.permissions().filter((p) => p.sensitive).map((p) => p.code)));
  private readonly rolesById = computed(() => new Map(this.roles().map((role) => [role.id, role])));

  /** Business text in the active language (falls back to French, the default language). */
  text(value: LocalizedText): string {
    return value[this.language.current()] || value.fr;
  }

  /** Label of a permission in the active language; the code itself until loaded (or for an unknown code). */
  permissionLabel(code: string): string {
    return this.permissionLabels().get(code) || code;
  }

  isSensitive(code: string): boolean {
    return this.sensitiveCodes().has(code);
  }

  /** A role's name in the active language, else its code. Accepts a Role or a GrantView's `role`. */
  roleName(role: { readonly code: string; readonly names: LocalizedText }): string {
    return this.text(role.names) || role.code;
  }

  roleById(id: string): Role | undefined {
    return this.rolesById().get(id);
  }

  reloadPermissions(): void {
    this.permissionsResource.reload();
  }

  reloadRoles(): void {
    this.rolesResource.reload();
  }
}
