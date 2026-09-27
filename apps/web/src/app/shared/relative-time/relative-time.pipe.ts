/**
 * `{{ iso | relativeTime: lang() : now() }}` — "il y a 5 minutes" / "منذ 5 دقائق" / "5 minutes ago".
 *
 * Angular concepts:
 * - **A pure pipe that depends on time.** A pure pipe (the default) re-runs only when its input or an ARGUMENT changes
 *   (by `===`). "5 minutes ago" goes stale while the input stays the same, so the current time is an explicit
 *   argument: the host passes a `now` signal and sets it when a fresh reading matters (the bell sets it when its
 *   dropdown opens). No timer ticking in every row, no impure pipe re-running on every change detection — the text is
 *   exactly as fresh as the host decides. The language is an argument too, so a language switch re-formats.
 * - **`Intl.RelativeTimeFormat` rather than Angular locale data.** Everywhere else dates go through `DatePipe` and
 *   Angular's registered locale data (core/i18n/date-locale.ts explains why). Angular ships no relative-time data, so
 *   this one uses the browser's `Intl`, with the SAME locale ids (`fr`, `ar-DZ` — Latin digits, as the rest of the
 *   Arabic UI — `en-US`). `numeric: 'auto'` gives "hier" / "أمس" / "yesterday" instead of "il y a 1 jour".
 * - The logic is the exported function `relativeTime()`: plain TypeScript, testable without TestBed.
 */
import { Pipe, type PipeTransform } from '@angular/core';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import type { AppLanguage } from '../../core/i18n/languages';

const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/** `iso` relative to `now`, in `lang`. Under 45 s → "now" ("maintenant", "الآن"). An unparsable date → ''. */
export function relativeTime(iso: string, lang: AppLanguage, now: number | Date = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const format = new Intl.RelativeTimeFormat(dateLocaleOf(lang), { numeric: 'auto' });
  let value = (at - (typeof now === 'number' ? now : now.getTime())) / 1000;
  if (Math.abs(value) < 45) return format.format(0, 'second');
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return '';
}

@Pipe({ name: 'relativeTime' })
export class RelativeTimePipe implements PipeTransform {
  transform(iso: string, lang: AppLanguage, now: number | Date): string {
    return relativeTime(iso, lang, now);
  }
}
