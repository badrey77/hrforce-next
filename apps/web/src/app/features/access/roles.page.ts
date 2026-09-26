/**
 * /access/roles — the company's roles: name (active language), code, system/custom, permission count, and how many
 * of them are sensitive. "New role" only for `access.manage_roles`.
 *
 * Angular concepts:
 * - **`*appCan` with an `else` template** (shared/can/can.directive.ts): the "New role" link, or — for users who
 *   may only read — a note saying so. `<ng-template #readOnlyNote>` is a blueprint that renders nothing on its own;
 *   the directive stamps it when the permission is missing.
 * - The list comes from `AccessCatalog.roles()` (a root cache): the grant form's role select reads the same signal,
 *   so a role saved in the editor (`reloadRoles()`) shows up everywhere without re-fetching per page.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessCatalog } from '../../core/access/access-catalog';
import type { Role } from '../../core/access/access.models';
import { CanDirective } from '../../shared/can/can.directive';
import { AccessNav } from './access-nav';

@Component({
  selector: 'app-access-roles-page',
  imports: [TranslocoDirective, RouterLink, AccessNav, CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './access.css',
  template: `
    <ng-container *transloco="let t">
      <app-access-nav />
      <div class="toolbar">
        <h2>{{ t('access.roles.title') }}</h2>
        <a *appCan="'access.manage_roles'; else readOnlyNote" class="btn" routerLink="/access/roles/new" data-action="new-role">
          {{ t('access.roles.create') }}
        </a>
        <ng-template #readOnlyNote>
          <p class="muted" data-note="read-only">{{ t('access.roles.readOnlyNote') }}</p>
        </ng-template>
      </div>

      @if (catalog.rolesError()) {
        <div class="form-error" role="alert">
          <p>{{ t('access.roles.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="catalog.reloadRoles()">{{ t('common.retry') }}</button>
        </div>
      } @else if (catalog.rolesLoaded()) {
        <div class="table-scroll">
          <table class="data">
            <thead>
              <tr>
                <th scope="col">{{ t('access.roles.name') }}</th>
                <th scope="col">{{ t('access.roles.code') }}</th>
                <th scope="col">{{ t('access.roles.kind') }}</th>
                <th scope="col">{{ t('access.roles.permissionCount') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (role of catalog.roles(); track role.id) {
                <tr [attr.data-role]="role.code">
                  <td><a [routerLink]="['/access/roles', role.id]">{{ catalog.roleName(role) }}</a></td>
                  <td class="code">{{ role.code }}</td>
                  <td>{{ role.isSystem ? t('access.roles.system') : t('access.roles.custom') }}</td>
                  <td>
                    {{ role.permissions.length }}
                    @if (sensitiveCount(role); as count) {
                      &ngsp;<span class="badge sensitive">{{ t('access.roles.sensitiveCount', { count }) }}</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="4">{{ t('access.roles.empty') }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
})
export class RolesPage {
  protected readonly catalog = inject(AccessCatalog);

  protected sensitiveCount(role: Role): number {
    return role.permissions.filter((code) => this.catalog.isSensitive(code)).length;
  }
}
