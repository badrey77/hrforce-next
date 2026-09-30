/**
 * `{{ day.workedMinutes | minutes: lang() }}` → "7 h 45" / "7 س 45 د" / "45 min" (docs/contracts/attendance.md › Web:
 * "Minutes are formatted `1 h 05` / `1 س 05 د`"). The arithmetic is `formatMinutes()` (core, unit-tested).
 *
 * Angular concepts: a pure pipe with an argument (chapter 13). Pure = Angular calls `transform()` again only when the
 * value OR an argument changes by identity; passing `lang()` as the argument is what makes a language switch
 * re-format, while ordinary re-renders reuse the last result.
 */
import { Pipe, type PipeTransform } from '@angular/core';
import { formatMinutes } from '../../core/attendance/attendance.models';
import type { AppLanguage } from '../../core/i18n/languages';

@Pipe({ name: 'minutes', pure: true })
export class MinutesPipe implements PipeTransform {
  transform(minutes: number | null | undefined, lang: AppLanguage): string {
    return minutes === null || minutes === undefined ? '—' : formatMinutes(minutes, lang);
  }
}
