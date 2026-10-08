/**
 * Employee file (docs/contracts/documents.md › Phase B) — pure rules: content sniffing, file names, the download
 * header, access by category class, the retention date. No Nest, no Kysely.
 */

export const EMPLOYEE_FILE_PERMISSIONS = {
  read: 'employee_file.read',
  upload: 'employee_file.upload',
  delete: 'employee_file.delete',
  medicalRead: 'employee.medical.read',
  medicalUpdate: 'employee.medical.update',
} as const;

export type AccessClass = 'standard' | 'medical';
export type EmployeeFileMime = 'application/pdf' | 'image/jpeg' | 'image/png';

/** Default and hard maximum of EMPLOYEE_FILE_MAX_BYTES (the database allows 20 MB). */
export const EMPLOYEE_FILE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const EMPLOYEE_FILE_HARD_MAX_BYTES = 20 * 1024 * 1024;

/** The seeded categories of every company (migrations 0015 and 0019 for existing ones, seedDocumentDefaults for new ones). */
export const SYSTEM_FILE_CATEGORIES: readonly {
  code: string;
  names: { fr: string; ar: string; en: string };
  accessClass: AccessClass;
  sortOrder: number;
}[] = [
  { code: 'diploma', names: { fr: 'Diplômes', ar: 'الشهادات', en: 'Diplomas' }, accessClass: 'standard', sortOrder: 10 },
  { code: 'contract', names: { fr: 'Contrats et avenants', ar: 'العقود والملاحق', en: 'Contracts and amendments' }, accessClass: 'standard', sortOrder: 20 },
  { code: 'id_document', names: { fr: "Pièces d'identité", ar: 'وثائق الهوية', en: 'Identity documents' }, accessClass: 'standard', sortOrder: 30 },
  { code: 'medical', names: { fr: 'Médical', ar: 'طبي', en: 'Medical' }, accessClass: 'medical', sortOrder: 40 },
  { code: 'other', names: { fr: 'Autres', ar: 'أخرى', en: 'Other' }, accessClass: 'standard', sortOrder: 50 },
  // the candidate files a hire copies into the employee file (docs/contracts/recruitment.md › assumption 19, migration 0019)
  { code: 'recruitment', names: { fr: 'Recrutement', ar: 'التوظيف', en: 'Recruitment' }, accessClass: 'standard', sortOrder: 60 },
];

/** Category codes created through the API (lower snake case, 2–40). */
export const CATEGORY_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

const PDF_HEAD = Buffer.from('%PDF-', 'latin1');
const PDF_EOF = Buffer.from('%%EOF', 'latin1');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The file's type from its bytes only (the declared Content-Type and the name are ignored):
 *  - PDF: starts with `%PDF-<digit>.<digit>` and has `%%EOF` within its last 1 KB;
 *  - JPEG: starts with FF D8 FF;
 *  - PNG: the 8-byte signature followed by the IHDR chunk.
 * Anything else (HTML, SVG, Office, a PDF header without an end, text) → null.
 */
export function sniffFileType(bytes: Buffer): EmployeeFileMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 5).equals(PDF_HEAD) && isDigit(bytes[5]) && bytes[6] === 0x2e && isDigit(bytes[7])) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 1024));
    return tail.includes(PDF_EOF) ? 'application/pdf' : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 16 && PNG_SIGNATURE.every((b, i) => bytes[i] === b) && bytes.subarray(12, 16).toString('latin1') === 'IHDR') return 'image/png';
  return null;
}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

/** C0/C1 controls, DEL, bidi embeddings/overrides/isolates (U+202A–U+202E, U+2066–U+2069) and marks (U+200E/F, U+061C). */
// oxlint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏؜‪-‮⁦-⁩]/g;

/**
 * The name shown in the file list: the last path part (`/` or `\`) of what the browser sent, NFC, without control and
 * bidi characters (an RLO could disguise `rapport‮fdp.exe`), trimmed, at most 200 characters; `fichier` when nothing
 * is left.
 */
export function sanitizeFilename(raw: string | undefined): string {
  const last = (raw ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = last.normalize('NFC').replace(UNSAFE_CHARS, '').trim();
  const clipped = Array.from(cleaned).slice(0, 200).join('').trim();
  return clipped === '' || clipped === '.' || clipped === '..' ? 'fichier' : clipped;
}

const EXTENSIONS: Record<EmployeeFileMime, { canonical: string; accepted: readonly string[] }> = {
  'application/pdf': { canonical: 'pdf', accepted: ['pdf'] },
  'image/jpeg': { canonical: 'jpg', accepted: ['jpg', 'jpeg'] },
  'image/png': { canonical: 'png', accepted: ['png'] },
};

/**
 * The name a download is saved under: the stored name with an extension that matches the sniffed type — a PDF sent as
 * `page.html` downloads as `page.html.pdf`, so the saved copy never opens as something else.
 */
export function downloadFilename(stored: string, mime: EmployeeFileMime): string {
  const { canonical, accepted } = EXTENSIONS[mime];
  const dot = stored.lastIndexOf('.');
  const ext = dot > 0 ? stored.slice(dot + 1).toLowerCase() : '';
  return accepted.includes(ext) ? stored : `${stored}.${canonical}`;
}

/**
 * `Content-Disposition` of a download (RFC 6266 / RFC 8187): always `attachment`, an ASCII fallback `filename="…"`
 * (only letters, digits, `.`, `_`, `-`; everything else — quotes, CR/LF, Arabic — becomes `_`) and the exact name in
 * `filename*=UTF-8''<percent-encoded>`.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 150) || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Permissions a category class needs, per action (all over the employee's unit). */
export function permissionsFor(action: 'read' | 'upload' | 'delete', accessClass: AccessClass): string[] {
  const P = EMPLOYEE_FILE_PERMISSIONS;
  const base = action === 'read' ? P.read : action === 'upload' ? P.upload : P.delete;
  if (accessClass === 'standard') return [base];
  return [base, action === 'read' ? P.medicalRead : P.medicalUpdate];
}

/** ISO date + whole years (29 Feb → 28 Feb in a non-leap year). */
export function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, 1));
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Retention (docs/contracts/documents.md › Audit, retention, worker): the bytes of a file are purged when its category
 * keeps files N years after the end, every employment of the person has ended, and the latest end + N years is before
 * today. A rehired person's files are therefore kept while they work here.
 */
export function isPurgeDue(input: { retentionYears: number | null; endDates: readonly (string | null)[]; today: string }): boolean {
  if (input.retentionYears === null || input.endDates.length === 0) return false;
  if (input.endDates.some((d) => d === null)) return false;
  const last = (input.endDates as string[]).toSorted().at(-1) ?? '';
  return addYears(last, input.retentionYears) < input.today;
}
