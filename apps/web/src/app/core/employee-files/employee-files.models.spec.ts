import {
  CAT_CONTRACT,
  CAT_DIPLOMA,
  CAT_ID,
  CAT_MEDICAL,
  FILE_CATEGORIES,
  FILE_ID_CARD,
  categoryRef,
  employeeFile,
} from '../../../testing/employee-file-fixtures';
import {
  checkFile,
  downloadFileName,
  EMPLOYEE_FILE_MAX_BYTES,
  fileBadge,
  fileKind,
  groupByCategory,
  titleFromFileName,
  uploadableCategories,
} from './employee-files.models';

describe('employee file helpers', () => {
  it('checks a chosen file as a courtesy: empty, type (by type, else by extension), size', () => {
    expect(checkFile({ name: 'a.pdf', type: 'application/pdf', size: 0 })).toBe('empty');
    expect(checkFile({ name: 'a.pdf', type: 'application/pdf', size: 10 })).toBeNull();
    expect(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: 10 })).toBeNull();
    expect(checkFile({ name: 'a.png', type: 'image/png', size: 10 })).toBeNull();
    expect(checkFile({ name: 'a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 10 })).toBe('type');
    expect(checkFile({ name: 'a.heic', type: 'image/heic', size: 10 })).toBe('type');
    expect(checkFile({ name: 'scan.JPEG', type: '', size: 10 })).toBeNull();
    expect(checkFile({ name: 'setup.exe', type: '', size: 10 })).toBe('type');
    expect(checkFile({ name: 'big.pdf', type: 'application/pdf', size: EMPLOYEE_FILE_MAX_BYTES })).toBeNull();
    expect(checkFile({ name: 'big.pdf', type: 'application/pdf', size: EMPLOYEE_FILE_MAX_BYTES + 1 })).toBe('size');
  });

  it('proposes a title from the file name', () => {
    expect(titleFromFileName('licence_droit-2012.pdf')).toBe('licence droit 2012');
    expect(titleFromFileName('C:\\fakepath\\Carte  nationale.JPG')).toBe('Carte nationale');
    expect(titleFromFileName('شهادة_الميلاد.png')).toBe('شهادة الميلاد');
    expect(titleFromFileName(`${'x'.repeat(200)}.pdf`)).toHaveLength(120);
  });

  it('names the type of a file from its sniffed MIME type', () => {
    expect([fileKind('application/pdf'), fileBadge('application/pdf')]).toEqual(['pdf', 'PDF']);
    expect([fileKind('image/jpeg'), fileBadge('image/jpeg')]).toEqual(['image', 'JPG']);
    expect([fileKind('image/png'), fileBadge('image/png')]).toEqual(['image', 'PNG']);
  });

  it('groups files by category in the categories order, unknown categories last, empty ones left out', () => {
    const contract = employeeFile({ id: 'f-3', category: categoryRef(CAT_CONTRACT) });
    const unknown = employeeFile({ id: 'f-4', category: { ...categoryRef(CAT_CONTRACT), id: 'c-gone', code: 'gone' } });
    const second = employeeFile({ id: 'f-5' });
    const groups = groupByCategory([FILE_ID_CARD, unknown, employeeFile(), contract, second], FILE_CATEGORIES);
    expect(groups.map((g) => g.category.id)).toEqual(['c-diploma', 'c-contract', 'c-id', 'c-gone']);
    expect(groups[0]?.files.map((f) => f.id)).toEqual(['f-1', 'f-5']);
  });

  it('offers active categories only, medical ones only with upload_medical', () => {
    const inactive = { ...CAT_ID, active: false };
    const categories = [CAT_DIPLOMA, inactive, CAT_MEDICAL];
    expect(uploadableCategories(categories, ['upload']).map((c) => c.code)).toEqual(['diploma']);
    expect(uploadableCategories(categories, ['upload', 'upload_medical']).map((c) => c.code)).toEqual(['diploma', 'medical']);
    expect(uploadableCategories(categories, [])).toEqual([]);
  });

  it('saves a download with an extension that matches the sniffed type (the API rule)', () => {
    expect(downloadFileName('licence.pdf', 'application/pdf')).toBe('licence.pdf');
    expect(downloadFileName('SCAN.JPEG', 'image/jpeg')).toBe('SCAN.JPEG');
    expect(downloadFileName('photo.jpg', 'image/jpeg')).toBe('photo.jpg');
    expect(downloadFileName('cni.png', 'image/png')).toBe('cni.png');
    expect(downloadFileName('page.html', 'application/pdf')).toBe('page.html.pdf');
    expect(downloadFileName('image.png', 'image/jpeg')).toBe('image.png.jpg');
    expect(downloadFileName('fichier', 'image/png')).toBe('fichier.png');
    expect(downloadFileName('.pdf', 'application/pdf')).toBe('.pdf.pdf');
  });
});
