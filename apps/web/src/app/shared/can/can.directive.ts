/**
 * `*appCan` — render a piece of template only when the signed-in user holds a permission (anywhere):
 *
 *   <a *appCan="'site.read'" routerLink="/organization/sites">Sites</a>
 *   <button *appCan="'access.manage_roles'; else readOnly" …>New role</button>
 *   <ng-template #readOnly><p>…read only…</p></ng-template>
 *
 * Angular concepts:
 * - **Attribute vs structural directive.** An attribute directive (`routerLinkActive`, `[formControl]`) changes
 *   the element it sits on. A STRUCTURAL directive decides whether — and how many times — a piece of template is
 *   put in the DOM at all. It never touches "its" element directly: it receives the element as a template.
 * - **The `*` microsyntax is sugar for `<ng-template>`.** The compiler rewrites
 *     <button *appCan="'x'; else readOnly">…</button>
 *   into
 *     <ng-template [appCan]="'x'" [appCanElse]="readOnly"><button>…</button></ng-template>
 *   The part before the first `;` binds the input named like the selector (`appCan`); each following `key expr`
 *   binds the input `appCan` + capitalised key (`else` → `appCanElse`). That is why the input names are fixed.
 *   An `<ng-template>` renders nothing by itself: it is a blueprint.
 * - **`TemplateRef` and `ViewContainerRef`.** Injected in a directive on an `<ng-template>`, `TemplateRef` IS that
 *   blueprint, and `ViewContainerRef` is the anchor (a comment node) where views made from it are inserted.
 *   `vcr.createEmbeddedView(templateRef)` stamps a live copy (bindings and all) in place; `vcr.clear()` destroys it.
 * - **Signal-driven re-render.** The `effect()` reads three signals: the `appCan` and `appCanElse` inputs and,
 *   through `session.can()`, the session's `permissions`. When any of them changes, it re-runs and swaps the view.
 *   It remembers which template is shown, so an unchanged answer does not recreate the view (that would lose
 *   focus, form state and child component state). No `ngOnChanges`, no subscription to clean up.
 * - **`@if (session.can('x'))` does the same job**, and reads better where the condition mixes permissions with
 *   other state or needs an `@else` block written inline. The directive earns its place when the SAME check is
 *   sprinkled over many small elements (nav links, one-off buttons) and in templates that should not have to
 *   inject `Session` just for that. Both re-render only when `permissions` changes.
 *
 * What it is NOT: security. It hides UI; the API still checks every request. And it answers "held anywhere" —
 * for a button about ONE record (end this grant, edit this unit), use the record's `_actions` from the server.
 */
import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import { Session } from '../../core/auth/session';

@Directive({ selector: '[appCan]' })
export class CanDirective {
  private readonly session = inject(Session);
  private readonly thenTemplate = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);

  /** Permission code, e.g. `'access.read'` (the expression before the first `;`). */
  readonly appCan = input.required<string>();
  /** Template shown instead when the permission is missing (`; else ref`). */
  readonly appCanElse = input<TemplateRef<unknown> | null>(null);

  /** The template currently stamped in the container (`null` = nothing). */
  private shown: TemplateRef<unknown> | null = null;

  constructor() {
    effect(() => {
      const wanted = this.session.can(this.appCan()) ? this.thenTemplate : this.appCanElse();
      if (wanted === this.shown) return;
      this.viewContainer.clear();
      if (wanted) this.viewContainer.createEmbeddedView(wanted);
      this.shown = wanted;
    });
  }
}
