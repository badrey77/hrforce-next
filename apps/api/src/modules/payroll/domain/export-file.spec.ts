import { describe, expect, it } from 'vitest';
import { buildExportFile, encodeText, encodeWindows1252, exportContentType, exportFilename, exportText, formatPeriod, formatValue, type ExportFormat, type ExportLine, type ExportRubrique } from './export-file.js';
import { columnsValid, DEFAULT_PAYROLL_SETTINGS } from './settings.js';

const FORMAT: ExportFormat = { ...DEFAULT_PAYROLL_SETTINGS };

const RUBRIQUES: ExportRubrique[] = [
  { id: 'r-annual', exportCode: 'CG_ANNUEL', sortOrder: 10, active: true },
  { id: 'r-abs', exportCode: 'ABS_NJ', sortOrder: 500, active: true },
  { id: 'r-prime', exportCode: 'PRIME_REND', sortOrder: 600, active: true },
  { id: 'r-late', exportCode: 'RETARD', sortOrder: 520, active: false },
];

function line(over: Partial<ExportLine> = {}): ExportLine {
  return {
    employeeId: 'e1', matricule: 'EMP-0002', lastName: 'Benali', firstName: 'Amine', unitCode: 'AG-CNE',
    rubriqueId: 'r-annual', exportCode: 'CG_ANNUEL', label: 'Congé annuel', unit: 'days', sortOrder: 10, originMonth: '2026-10', value: 3,
    ...over,
  };
}

const decode1252 = (bytes: Uint8Array) => Array.from(bytes);

describe('formatValue', () => {
  it('trims two decimals and uses the decimal separator', () => {
    expect(formatValue(2, 'comma')).toBe('2');
    expect(formatValue(2.5, 'comma')).toBe('2,5');
    expect(formatValue(12.25, 'comma')).toBe('12,25');
    expect(formatValue(12.25, 'dot')).toBe('12.25');
    expect(formatValue(100, 'dot')).toBe('100');
    expect(formatValue(1234567.8, 'comma')).toBe('1234567,8');
  });

  it('writes a minus sign for negatives and rounds to two decimals', () => {
    expect(formatValue(-1, 'comma')).toBe('-1');
    expect(formatValue(-0.5, 'dot')).toBe('-0.5');
    expect(formatValue(1.006, 'dot')).toBe('1.01');
    expect(formatValue(-0.001, 'dot')).toBe('0');
    expect(formatValue(0, 'comma')).toBe('0');
  });
});

describe('formatPeriod', () => {
  it('writes the three formats', () => {
    expect(formatPeriod('2026-10', 'mm_yyyy')).toBe('10/2026');
    expect(formatPeriod('2026-10', 'yyyymm')).toBe('202610');
    expect(formatPeriod('2026-03', 'yyyy_mm')).toBe('2026-03');
  });
});

describe('per_line layout', () => {
  it('writes the header and one row per line, CRLF after every row', () => {
    const text = exportText(FORMAT, '2026-10', [line()], RUBRIQUES);
    expect(text).toBe('matricule;rubrique;valeur;periode\r\nEMP-0002;CG_ANNUEL;3;10/2026\r\n');
  });

  it('sorts by matricule, rubrique order, then origin month, and drops zero values', () => {
    const lines = [
      line({ matricule: 'EMP-0010', employeeId: 'e2' }),
      line({ rubriqueId: 'r-abs', exportCode: 'ABS_NJ', sortOrder: 500, value: 1 }),
      line({ rubriqueId: 'r-abs', exportCode: 'ABS_NJ', sortOrder: 500, originMonth: '2026-09', value: -1 }),
      line({ value: 2.5 }),
      line({ rubriqueId: 'r-prime', exportCode: 'PRIME_REND', sortOrder: 600, value: 0, unit: 'amount' }),
    ];
    const format: ExportFormat = { ...FORMAT, columns: ['matricule', 'rubrique', 'value', 'period', 'origin_period'], headerRow: false };
    expect(exportText(format, '2026-10', lines, RUBRIQUES).split('\r\n')).toEqual([
      'EMP-0002;CG_ANNUEL;2,5;10/2026;10/2026',
      'EMP-0002;ABS_NJ;-1;10/2026;09/2026',
      'EMP-0002;ABS_NJ;1;10/2026;10/2026',
      'EMP-0010;CG_ANNUEL;3;10/2026;10/2026',
      '',
    ]);
  });

  it('prints every column key with its French header, units J / H / DA', () => {
    const format: ExportFormat = { ...FORMAT, columns: ['matricule', 'last_name', 'first_name', 'rubrique', 'label', 'value', 'unit', 'period', 'origin_period', 'unit_code'], separator: 'pipe', decimalSeparator: 'dot', periodFormat: 'yyyymm' };
    const text = exportText(format, '2026-10', [line({ unit: 'hours', value: 1.75 }), line({ matricule: 'EMP-0003', unit: 'amount', value: 15000, unitCode: null })], RUBRIQUES);
    expect(text).toBe(
      'matricule|nom|prenom|rubrique|libelle|valeur|unite|periode|periode_origine|code_unite\r\n' +
        'EMP-0002|Benali|Amine|CG_ANNUEL|Congé annuel|1.75|H|202610|202610|AG-CNE\r\n' +
        'EMP-0003|Benali|Amine|CG_ANNUEL|Congé annuel|15000|DA|202610|202610|\r\n',
    );
  });

  it('quotes a cell holding the separator, a quote or a line break, doubling quotes', () => {
    const format: ExportFormat = { ...FORMAT, separator: 'comma', columns: ['matricule', 'last_name', 'rubrique', 'value'], headerRow: false };
    const text = exportText(format, '2026-10', [line({ lastName: 'Ben "Ali", fils', value: 2.5 }), line({ matricule: 'B', lastName: 'a\nb' })], RUBRIQUES);
    expect(text).toBe('B,"a\nb",CG_ANNUEL,3\r\nEMP-0002,"Ben ""Ali"", fils",CG_ANNUEL,"2,5"\r\n');
  });

  it('guards text cells against formulas, never numbers', () => {
    const format: ExportFormat = { ...FORMAT, columns: ['matricule', 'last_name', 'rubrique', 'value'], headerRow: false };
    const text = exportText(format, '2026-10', [
      line({ lastName: '=HYPERLINK("x")', value: -2 }),
      line({ matricule: 'M2', lastName: '+1', value: 1 }),
      line({ matricule: 'M3', lastName: '@cmd', value: 1 }),
      line({ matricule: 'M4', lastName: '-x', value: 1 }),
      line({ matricule: 'M5', lastName: '\tx', value: 1 }),
    ], RUBRIQUES);
    expect(text.split('\r\n')).toEqual([
      `EMP-0002;"'=HYPERLINK(""x"")";CG_ANNUEL;-2`,
      "M2;'+1;CG_ANNUEL;1",
      "M3;'@cmd;CG_ANNUEL;1",
      "M4;'-x;CG_ANNUEL;1",
      "M5;'\tx;CG_ANNUEL;1",
      '',
    ]);
  });

  it('quotes a cell holding a tab when the separator is a tab', () => {
    const format: ExportFormat = { ...FORMAT, separator: 'tab', columns: ['matricule', 'last_name', 'value'], headerRow: false };
    expect(exportText(format, '2026-10', [line({ lastName: 'a\tb' })], RUBRIQUES)).toBe('EMP-0002\t"a\tb"\t3\r\n');
  });
});

describe('per_employee layout', () => {
  it('writes one row per employee and origin month, one column per active rubrique (or with a line), empty cells', () => {
    const format: ExportFormat = { ...FORMAT, layout: 'per_employee', columns: ['matricule', 'origin_period'] };
    const lines = [
      line({ value: 3 }),
      line({ rubriqueId: 'r-prime', exportCode: 'PRIME_REND', sortOrder: 600, unit: 'amount', value: 12000.5 }),
      line({ rubriqueId: 'r-abs', exportCode: 'ABS_NJ', sortOrder: 500, originMonth: '2026-09', value: -1 }),
      line({ rubriqueId: 'r-late', exportCode: 'RETARD', sortOrder: 520, unit: 'hours', originMonth: '2026-09', value: 0.5 }),
      line({ employeeId: 'e2', matricule: 'EMP-0001', value: 1 }),
    ];
    expect(exportText(format, '2026-10', lines, RUBRIQUES).split('\r\n')).toEqual([
      'matricule;periode_origine;CG_ANNUEL;ABS_NJ;RETARD;PRIME_REND',
      'EMP-0001;10/2026;1;;;',
      'EMP-0002;09/2026;;-1;0,5;',
      'EMP-0002;10/2026;3;;;12000,5',
      '',
    ]);
  });

  it('leaves out an inactive rubrique without lines', () => {
    const format: ExportFormat = { ...FORMAT, layout: 'per_employee', columns: ['matricule'], headerRow: true };
    expect(exportText(format, '2026-10', [], RUBRIQUES)).toBe('matricule;CG_ANNUEL;ABS_NJ;PRIME_REND\r\n');
  });
});

describe('encoding', () => {
  it('encodes Windows-1252 with an explicit table (not ISO-8859-1)', () => {
    expect(decode1252(encodeWindows1252('€œŒ’‘“”…–—'))).toEqual([0x80, 0x9c, 0x8c, 0x92, 0x91, 0x93, 0x94, 0x85, 0x96, 0x97]);
    expect(decode1252(encodeWindows1252('éèàçÉ ÿ'))).toEqual([0xe9, 0xe8, 0xe0, 0xe7, 0xc9, 0xa0, 0xff]);
    expect(decode1252(encodeWindows1252('A;\r\n'))).toEqual([0x41, 0x3b, 0x0d, 0x0a]);
  });

  it('writes ? for what it cannot encode (Arabic, emoji, C1 controls, unassigned bytes)', () => {
    expect(decode1252(encodeWindows1252('بن'))).toEqual([0x3f, 0x3f]);
    expect(decode1252(encodeWindows1252('a😀b'))).toEqual([0x61, 0x3f, 0x62]);
    expect(decode1252(encodeWindows1252('\u0081\u008d'))).toEqual([0x3f, 0x3f]);
  });

  it('normalises to NFC first (a decomposed é is one byte)', () => {
    expect(decode1252(encodeWindows1252('é'))).toEqual([0xe9]);
  });

  it('writes UTF-8 with or without a byte-order mark', () => {
    expect(Array.from(encodeText('é', 'utf8'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(encodeText('é', 'utf8_bom'))).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa9]);
  });

  it('gives identical bytes for the same input in any line order', () => {
    const lines = [line(), line({ matricule: 'EMP-0001', employeeId: 'e2', lastName: 'Œuvre', value: 1.5 })];
    const a = buildExportFile(FORMAT, '2026-10', lines, RUBRIQUES);
    const b = buildExportFile(FORMAT, '2026-10', lines.toReversed(), RUBRIQUES.toReversed());
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.text).toContain('EMP-0001;CG_ANNUEL;1,5;10/2026');
  });
});

describe('filename and content type', () => {
  it('names the file by month, unit and draft', () => {
    expect(exportFilename('2026-10', null, false, 'csv')).toBe('variables-paie-2026-10.csv');
    expect(exportFilename('2026-10', 'DR-EST', true, 'txt')).toBe('variables-paie-2026-10-DR-EST-brouillon.txt');
    expect(exportFilename('2026-10', 'a b/é', false, 'csv')).toBe('variables-paie-2026-10-a_b__.csv');
    expect(exportContentType('windows1252')).toBe('text/csv; charset=windows-1252');
    expect(exportContentType('utf8_bom')).toBe('text/csv; charset=utf-8');
  });
});

describe('columnsValid', () => {
  it('needs matricule, and rubrique + value per line; distinct allowed keys, 1–10', () => {
    expect(columnsValid('per_line', ['matricule', 'rubrique', 'value'])).toBe(true);
    expect(columnsValid('per_line', ['matricule', 'value'])).toBe(false);
    expect(columnsValid('per_line', ['matricule', 'rubrique', 'value', 'value'])).toBe(false);
    expect(columnsValid('per_line', ['matricule', 'rubrique', 'value', 'salary'])).toBe(false);
    expect(columnsValid('per_employee', ['matricule'])).toBe(true);
    expect(columnsValid('per_employee', ['matricule', 'rubrique'])).toBe(false);
    expect(columnsValid('per_employee', ['last_name'])).toBe(false);
    expect(columnsValid('per_line', [])).toBe(false);
  });
});
