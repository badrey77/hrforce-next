/**
 * `displayName` — a pure pipe that picks the Arabic or the Latin name of a person or an org unit for the UI
 * language (docs/contracts/employment.md › Web: "Names shown in Arabic when the UI is Arabic and an Arabic name
 * exists (else Latin); same for unit names").
 *
 *   {{ employee.person | displayName: lang() }}   → "BENALI Amina"  /  "بن علي أمينة"
 *   {{ unit | displayName: lang() }}              → "Agence Oran"   /  "وكالة وهران"
 *
 * Angular concepts (same pattern as shared/timeline/day-heading.pipe.ts — chapter 13):
 * - **The language is an ARGUMENT, not something the pipe reads.** A pure pipe re-runs only when its value or an
 *   argument changes (`===`). Passing `lang()` means a language switch re-renders every name; a pipe that injected
 *   `LanguageService` and read the signal inside `transform()` would keep its cached result (pipes are not
 *   reactive consumers of signals they read — templates are, but the pure-pipe cache short-circuits the call).
 * - **One pipe, two shapes.** A person (`lastName`/`firstName` + `…Ar`) and a unit (`name`/`nameAr`) are told
 *   apart structurally (`'lastName' in value`), so templates use one name for both.
 * - The pipe body is `displayNameOf()`, a plain function exported for TypeScript callers (the picker's input text,
 *   a `computed()` building a name map): a pipe is for templates, logic stays callable from code and tests.
 *
 * Rule for people: the Arabic name is used only when BOTH Arabic parts exist — mixing an Arabic last name with a
 * Latin first name would read in two directions at once. Format is "LAST First" in both scripts, as on HR records.
 * Pure display: sorting and searching stay on the server (it searches Latin AND Arabic names).
 */
import { Pipe, type PipeTransform } from '@angular/core';
import type { AppLanguage } from '../../core/i18n/languages';

export interface PersonNames {
  readonly lastName: string;
  readonly firstName: string;
  readonly lastNameAr?: string | null;
  readonly firstNameAr?: string | null;
}

export interface UnitNames {
  readonly name: string;
  readonly nameAr?: string | null;
}

export type Named = PersonNames | UnitNames;

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function displayNameOf(value: Named | null | undefined, lang: AppLanguage): string {
  if (!value) return '';
  if ('lastName' in value) {
    if (lang === 'ar' && hasText(value.lastNameAr) && hasText(value.firstNameAr)) {
      return `${value.lastNameAr} ${value.firstNameAr}`;
    }
    return `${value.lastName} ${value.firstName}`;
  }
  return lang === 'ar' && hasText(value.nameAr) ? value.nameAr : value.name;
}

@Pipe({ name: 'displayName', pure: true })
export class DisplayNamePipe implements PipeTransform {
  transform(value: Named | null | undefined, lang: AppLanguage): string {
    return displayNameOf(value, lang);
  }
}
