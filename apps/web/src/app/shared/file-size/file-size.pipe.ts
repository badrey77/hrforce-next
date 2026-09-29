/**
 * `{{ file.sizeBytes | fileSize: lang() }}` — "240 ko" / "2,4 Mo" in French, "240 kB" / "2.4 MB" in English, the
 * Arabic unit names in Arabic (Latin digits, as the rest of the Arabic UI).
 *
 * Angular concepts:
 * - **A pure pipe with the language as an argument** (the `relativeTime` pipe's pattern): Angular re-runs a pure pipe
 *   only when its input or an argument changes, so passing `lang()` re-formats every size on a language switch and
 *   costs nothing otherwise.
 * - **`Intl.NumberFormat` with `style: 'unit'`** rather than Angular's `DecimalPipe`: Angular's locale data has no unit
 *   names ("ko", "Mo", "كيلوبايت"), the browser's `Intl` has them for every language. The locale ids are the same as
 *   for dates (`fr`, `ar-DZ`, `en-US` — core/i18n/date-locale.ts).
 * - **Plurals come from `Intl` too.** With `unitDisplay: 'long'` the browser picks the plural form of the unit from
 *   the language's CLDR plural rules (French, English and Arabic each have their own; Arabic has six categories), so
 *   there is no "(s)" to write by hand. Only bytes use the long form — see the comment inside.
 * - Binary steps (1 024), as file managers show them. The logic is the exported function, testable without TestBed.
 */
import { Pipe, type PipeTransform } from '@angular/core';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import type { AppLanguage } from '../../core/i18n/languages';

export function formatFileSize(bytes: number, lang: AppLanguage): string {
  const [value, unit] =
    bytes < 1024 ? [bytes, 'byte'] : bytes < 1024 * 1024 ? [bytes / 1024, 'kilobyte'] : [bytes / (1024 * 1024), 'megabyte'];
  return new Intl.NumberFormat(dateLocaleOf(lang), {
    style: 'unit',
    unit,
    // Bytes in full words: the short English unit has no plural ("800 byte"), the long one follows the language's
    // plural rules ("1 byte" / "800 bytes", "1 octet" / "800 octets"). kB/MB stay short ("244 kB", "2,5 Mo").
    unitDisplay: unit === 'byte' ? 'long' : 'short',
    maximumFractionDigits: value < 10 && unit !== 'byte' ? 1 : 0,
  }).format(value);
}

@Pipe({ name: 'fileSize' })
export class FileSizePipe implements PipeTransform {
  transform(bytes: number | null | undefined, lang: AppLanguage): string {
    return typeof bytes === 'number' ? formatFileSize(bytes, lang) : '';
  }
}
