import { FormControl, FormGroup } from '@angular/forms';
import { ApiProblemError } from '../../../core/http/api-problem';
import {
  applyWriteProblem,
  cleanDraft,
  draftLength,
  frRequired,
  LEVEL_FIELDS,
  logoPrecheck,
  logoUploadError,
  textErrorKey,
  textLimit,
  toLang3,
  writeMessage,
} from './branding-forms';

function problem(status: number, slug: string, errors?: { field: string; code: string; message: string }[]): ApiProblemError {
  return new ApiProblemError({ type: `urn:hrforce:problem:${slug}`, title: 'x', status, errors });
}

function langGroup(max = 10, multiline = false) {
  const limit = textLimit(() => max, multiline);
  return new FormGroup(
    { fr: new FormControl('', { nonNullable: true, validators: limit }), ar: new FormControl('', { nonNullable: true, validators: limit }), en: new FormControl('', { nonNullable: true, validators: limit }) },
    { validators: frRequired },
  );
}

const file = (type: string, size: number) => new File([new Uint8Array(size)], 'logo', { type });

describe('branding forms (docs/contracts/branding.md › Settings section)', () => {
  it('each level has the contract’s fields: no welcome texts on the installation, no sign-in message on a company', () => {
    expect(LEVEL_FIELDS.installation).toEqual(['appTitle', 'signInMessage', 'footer']);
    expect(LEVEL_FIELDS.company).toEqual(['appTitle', 'welcomeTitle', 'welcomeMessage', 'footer']);
  });

  describe('cleanDraft / draftLength mirror the server’s text rules', () => {
    it('single line: line breaks and tabs become spaces, runs of spaces collapse, trimmed', () => {
      expect(cleanDraft('  Portail\tRH \r\n  Groupe  ', false)).toBe('Portail RH Groupe');
    });

    it('multi-line: one kind of line break, at most one empty line in a row', () => {
      expect(cleanDraft('a\r\nb\rc\n\n\n\nd', true)).toBe('a\nb\nc\n\nd');
      // Spaces next to a line break go, then the breaks collapse; leading and trailing breaks are trimmed.
      expect(cleanDraft('\n a  \n \n \n b \n', true)).toBe('a\n\nb');
    });

    it('counts Unicode code points after cleaning (NFC), and keeps markup characters as typed', () => {
      expect(draftLength('  abc  ', false)).toBe(3);
      expect(draftLength('é', false)).toBe(1); // e + combining acute → é
      expect(draftLength('😀😀', false)).toBe(2);
      expect(cleanDraft('<b>&"x"</b>', false)).toBe('<b>&"x"</b>');
    });
  });

  describe('validation', () => {
    it('too long, by code points of the cleaned text', () => {
      const group = langGroup(5);
      group.controls.fr.setValue('  12345  ');
      expect(group.controls.fr.valid).toBe(true);
      group.controls.fr.setValue('123456');
      expect(group.controls.fr.hasError('tooLong')).toBe(true);
      expect(textErrorKey(group, 'fr')).toBe('branding.errors.tooLong');
    });

    it('too many lines on a multi-line field only (6 at most)', () => {
      const group = langGroup(500, true);
      group.controls.fr.setValue('1\n2\n3\n4\n5\n6');
      expect(group.controls.fr.valid).toBe(true);
      group.controls.fr.setValue('1\n2\n3\n4\n5\n6\n7');
      expect(textErrorKey(group, 'fr')).toBe('branding.errors.tooManyLines');
    });

    it('French is required as soon as Arabic or English is filled; all empty is fine', () => {
      const group = langGroup();
      expect(group.valid).toBe(true);
      group.controls.ar.setValue('مرحبا');
      expect(group.hasError('frRequired')).toBe(true);
      expect(textErrorKey(group, 'fr')).toBe('branding.errors.frRequired');
      expect(textErrorKey(group, 'ar')).toBeNull();
      group.controls.fr.setValue('   ');
      expect(group.hasError('frRequired')).toBe(true);
      group.controls.fr.setValue('Bonjour');
      expect(group.valid).toBe(true);
    });

    it('toLang3: cleaned texts, empty → null', () => {
      expect(toLang3({ fr: '  Bonjour  ', ar: '', en: '   ' }, false)).toEqual({ fr: 'Bonjour', ar: null, en: null });
    });
  });

  describe('server refusals', () => {
    it('422: each error lands on its input by `<name>.<lang>`, the colour on the palette', () => {
      const form = new FormGroup({ appTitle: langGroup(), footer: langGroup() });
      const result = applyWriteProblem(
        form,
        problem(422, 'validation', [
          { field: 'appTitle.ar', code: 'too_long', message: 'x' },
          { field: 'footer.fr', code: 'fr_required', message: 'x' },
          { field: 'color', code: 'invalid_color', message: 'x' },
        ]),
      );
      expect(result).toEqual({ message: null, colorInvalid: true });
      expect(textErrorKey(form.controls.appTitle, 'ar')).toBe('branding.errors.tooLong');
      expect(textErrorKey(form.controls.footer, 'fr')).toBe('branding.errors.frRequired');
      expect(form.controls.appTitle.controls.ar.touched).toBe(true);
      // Typing again clears the server's refusal.
      form.controls.appTitle.controls.ar.setValue('ok');
      expect(textErrorKey(form.controls.appTitle, 'ar')).toBeNull();
    });

    it('422: an unknown code is still shown on its input; an unknown field becomes the form message', () => {
      const form = new FormGroup({ appTitle: langGroup() });
      const result = applyWriteProblem(
        form,
        problem(422, 'validation', [
          { field: 'appTitle.fr', code: 'invalid_type', message: 'x' },
          { field: 'nope', code: 'unrecognized_keys', message: 'x' },
        ]),
      );
      expect(textErrorKey(form.controls.appTitle, 'fr')).toBe('branding.errors.invalid');
      expect(result.message).toEqual({ key: 'branding.errors.refused' });
    });

    it('422: too_big reads as too long; an error on a whole text or on the body goes above the form', () => {
      const form = new FormGroup({ appTitle: langGroup() });
      const result = applyWriteProblem(
        form,
        problem(422, 'validation', [
          { field: 'appTitle.en', code: 'too_big', message: 'x' },
          { field: 'appTitle', code: 'invalid_type', message: 'x' },
          { field: '', code: 'unrecognized_keys', message: 'x' },
        ]),
      );
      expect(textErrorKey(form.controls.appTitle, 'en')).toBe('branding.errors.tooLong');
      expect(form.controls.appTitle.hasError('serverCode')).toBe(false);
      expect(result.message).toEqual({ key: 'branding.errors.refused' });
    });

    it('other failures become one sentence', () => {
      expect(writeMessage(problem(403, 'forbidden-scope'))).toEqual({ key: 'branding.errors.companyWide' });
      expect(writeMessage(problem(403, 'forbidden'))).toEqual({ key: 'errors.forbidden' });
      expect(writeMessage(problem(404, 'not-found'))).toEqual({ key: 'branding.errors.unavailable' });
      expect(writeMessage(problem(0, 'network'))).toEqual({ key: 'errors.network' });
      expect(writeMessage(problem(500, 'internal'))).toEqual({ key: 'errors.generic' });
      expect(writeMessage(new Error('boom'))).toEqual({ key: 'errors.generic' });
    });
  });

  describe('logo checks', () => {
    it('client pre-check: PNG or JPEG only, at most the limit, not empty', () => {
      expect(logoPrecheck(file('image/png', 100), 262144)).toBeNull();
      expect(logoPrecheck(file('image/jpeg', 262144), 262144)).toBeNull();
      expect(logoPrecheck(file('image/svg+xml', 100), 262144)).toBe('type');
      expect(logoPrecheck(file('image/gif', 100), 262144)).toBe('type');
      expect(logoPrecheck(file('image/webp', 100), 262144)).toBe('type');
      expect(logoPrecheck(file('', 100), 262144)).toBe('type');
      expect(logoPrecheck(file('image/png', 262145), 262144)).toBe('size');
      expect(logoPrecheck(file('image/png', 0), 262144)).toBe('required');
    });

    it('server codes of an upload', () => {
      const refused = (code: string) => logoUploadError(problem(422, 'validation', [{ field: 'file', code, message: 'x' }]));
      expect(refused('unsupported_type')).toBe('type');
      expect(refused('too_large')).toBe('size');
      expect(refused('dimensions_too_large')).toBe('dimensions');
      expect(refused('required')).toBe('required');
      expect(refused('something_else')).toBeNull();
      expect(logoUploadError(problem(403, 'forbidden-scope'))).toBeNull();
    });
  });
});
