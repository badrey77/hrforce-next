/**
 * Date formatting per UI language: which Angular locale formats dates for each app language.
 *
 * Angular concepts:
 * - **Locale data.** Angular's date/number pipes (`DatePipe`, `formatDate()`…) do not use the browser's `Intl`
 *   tables; they read Angular's own CLDR "locale data" (month and day names, date patterns such as `fullDate`).
 *   Only `en-US` is built in. Any other locale must be REGISTERED once, with `registerLocaleData(data, id)`,
 *   before a pipe formats with it — otherwise the pipe throws "Missing locale data for the locale 'fr'".
 *   The data files are small (~2.5 kB each) and are plain ES modules, so they end up in whichever bundle chunk
 *   imports this file: the timeline (`@defer`red — downloaded with the History tab, not with the app; see
 *   docs/angular/13-pipes-defer-and-lists.md) and the employee detail page (salaries through `DecimalPipe`, in
 *   the Employees lazy chunk). Number formatting reads the same locale data (group and decimal separators).
 * - **`LOCALE_ID` vs the Transloco language.** `LOCALE_ID` is a DI token (default `'en-US'`) that `DatePipe` reads
 *   ONCE, when the pipe instance is created. It is an application-wide constant: providing it
 *   (`{ provide: LOCALE_ID, useValue: 'fr' }`) fixes it at bootstrap, and there is no supported way to change it
 *   while the app runs (you would have to re-bootstrap, or reload the page). Our language, on the other hand,
 *   switches at runtime (`LanguageService.use()`). So we leave `LOCALE_ID` alone and pass the locale EXPLICITLY on
 *   every call: `DatePipe`'s 4th argument (`{{ at | date: 'shortTime' : undefined : locale }}`) and `formatDate()`'s
 *   3rd both override `LOCALE_ID`. A pure pipe re-runs when an argument changes, so a language switch re-formats.
 *   (The other option, `Intl.DateTimeFormat(lang)`, needs no registration but formats with the browser's tables,
 *   which differ between browsers; Angular's data gives the same output everywhere, tests included.)
 * - **Why `ar-DZ` and not `ar`.** Algeria writes Latin digits and uses the Maghreb month names (جانفي، فيفري…);
 *   generic `ar` would print Arabic-Indic digits and Levantine/Egyptian month names.
 */
import { registerLocaleData } from '@angular/common';
import localeArDz from '@angular/common/locales/ar-DZ';
import localeFr from '@angular/common/locales/fr';
import type { AppLanguage } from './languages';

registerLocaleData(localeFr, 'fr');
registerLocaleData(localeArDz, 'ar-DZ');

/** App language → Angular locale id used to format dates (`en` → the built-in `en-US`). */
export const DATE_LOCALES: Readonly<Record<AppLanguage, string>> = { fr: 'fr', ar: 'ar-DZ', en: 'en-US' };

export function dateLocaleOf(lang: AppLanguage): string {
  return DATE_LOCALES[lang];
}
