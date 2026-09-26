/**
 * `dayHeading` — a custom PURE pipe: a local day (`YYYY-MM-DD`) → its full date in the UI language,
 * e.g. `'2026-09-24' | dayHeading: 'fr'` → "jeudi 24 septembre 2026", `: 'ar'` → "الخميس، 24 سبتمبر 2026".
 *
 * Angular concepts:
 * - **A pipe is a class with `@Pipe` and a `transform()` method.** In a template, `value | name: arg1 : arg2` calls
 *   `transform(value, arg1, arg2)`. A component lists the pipe in `imports` like a component or directive.
 * - **`pure: true` (the default, written out here to teach it).** Angular calls a pure pipe's `transform()` again
 *   ONLY when the value or one of the arguments changes — compared by reference (`===`) — and otherwise reuses the
 *   previous result. That is why the language is an ARGUMENT: a language switch changes the argument, so every
 *   heading is re-formatted; a pipe that read the language internally would keep its stale cached result.
 *   An impure pipe (`pure: false`) runs on every change detection of the template instead — only needed when the
 *   output depends on something that is not an argument (Angular's `async` pipe is the classic example).
 * - **Why a pipe and not a method call in the template** (`{{ heading(day) }}`)? A method call is re-evaluated each
 *   time the view is checked, and a new `formatDate()` for every heading, every time, adds up in a long list. A pure
 *   pipe is memoised per binding. (With signals there is a third way — a `computed()` — which is what the timeline
 *   uses for GROUPING; see timeline.ts for when to choose which.)
 * - **`formatDate()`** is the function behind Angular's `DatePipe`; its third argument is the locale id, which
 *   overrides `LOCALE_ID` (see core/i18n/date-locale.ts for why we never switch `LOCALE_ID`). A date-only ISO
 *   string is parsed as a LOCAL date (no UTC shift), which is what a day key needs.
 */
import { formatDate } from '@angular/common';
import { Pipe, type PipeTransform } from '@angular/core';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import type { AppLanguage } from '../../core/i18n/languages';

@Pipe({ name: 'dayHeading', pure: true })
export class DayHeadingPipe implements PipeTransform {
  transform(day: string, lang: AppLanguage): string {
    return formatDate(day, 'fullDate', dateLocaleOf(lang));
  }
}
