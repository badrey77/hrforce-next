/**
 * Leaving the template designer with changes not saved yet asks for confirmation. Typed on a small interface so the
 * routes file does not import the designer page (its code stays in its own chunk).
 */
import type { CanDeactivateFn } from '@angular/router';

export interface LeavesWithConfirmation {
  /** True when leaving loses nothing (or the user confirmed). */
  canLeave(): boolean;
}

export const unsavedTemplateGuard: CanDeactivateFn<LeavesWithConfirmation> = (component) => component?.canLeave() ?? true;
