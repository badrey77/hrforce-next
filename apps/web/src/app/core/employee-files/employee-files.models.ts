/**
 * Employee file (Phase B of the Documents slice) — API types from the binding contract `docs/contracts/documents.md`
 * › Phase B, plus the small pure helpers the screens share: the client-side COURTESY check of a chosen file, a title
 * proposed from its name, and grouping files by category. Plain TypeScript, no Angular.
 *
 * The client-side check is a convenience, never a control: the browser's `File.type` is guessed from the file NAME
 * (rename `virus.exe` to `cv.pdf` and it says `application/pdf`), and a user can bypass any check in the page. The API
 * reads the first bytes of the content (magic numbers) and alone decides (422 `unsupported_type` / `too_large` /
 * `empty`). The check only spares a 10 MB upload that would be refused anyway.
 */
import type { Labels } from '../leave/leave.models';

export type FileAccessClass = 'standard' | 'medical';

/** `GET /employee-files/categories` item. */
export interface EmployeeFileCategory {
  readonly id: string;
  readonly code: string;
  readonly labels: Labels;
  readonly accessClass: FileAccessClass;
  /** Years after the end of employment before the content is purged; `null` = keep. */
  readonly retentionYearsAfterEnd: number | null;
  readonly active: boolean;
  readonly isSystem: boolean;
}

export interface EmployeeFileCategoryList {
  readonly items: readonly EmployeeFileCategory[];
}

/** `POST /employee-files/categories` (standard categories only). */
export interface NewEmployeeFileCategory {
  readonly code: string;
  readonly labels: Labels;
  readonly retentionYearsAfterEnd?: number | null;
}

/** `PUT /employee-files/categories/:id`. */
export interface EmployeeFileCategoryPatch {
  readonly labels?: Labels;
  readonly retentionYearsAfterEnd?: number | null;
  readonly active?: boolean;
}

export interface UserRef {
  readonly id: string;
  readonly displayName: string;
}

export type EmployeeFileAction = 'delete';

export interface EmployeeFileView {
  readonly id: string;
  /** The employment the file was added to (a rehired person's list spans every employment). */
  readonly employmentId: string;
  readonly category: { readonly id: string; readonly code: string; readonly labels: Labels; readonly accessClass: FileAccessClass };
  readonly title: string;
  readonly originalFilename: string;
  /** Sniffed by the API from the content: `application/pdf`, `image/jpeg` or `image/png`. */
  readonly mime: string;
  readonly sizeBytes: number;
  /** Hex. */
  readonly sha256: string;
  readonly documentDate: string | null;
  readonly expiresOn: string | null;
  readonly uploadedAt: string;
  readonly uploadedBy: UserRef | null;
  /** Tombstone (listed only with `includeDeleted`, for holders of `employee_file.delete`). */
  readonly deleted: { readonly at: string; readonly by: UserRef | null; readonly reason: string } | null;
  /** The content was removed by the retention job; the metadata stays. */
  readonly purgedAt: string | null;
  readonly _actions: readonly EmployeeFileAction[];
}

export type EmployeeFileListAction = 'upload' | 'upload_medical';

/** `GET /employees/:id/files`. */
export interface EmployeeFileList {
  readonly items: readonly EmployeeFileView[];
  /** `['medical']` when medical files exist that the caller may not see (they are absent from `items`). */
  readonly _redacted: readonly 'medical'[];
  readonly _actions: readonly EmployeeFileListAction[];
}

/** The text fields of `POST /employees/:id/files` (multipart, next to `file`). Dates are `YYYY-MM-DD`. */
export interface NewEmployeeFile {
  readonly categoryId: string;
  readonly title: string;
  readonly documentDate: string | null;
  readonly expiresOn: string | null;
}

/** What an upload Observable emits: progress while the body is sent, then the created file. */
export type UploadEvent =
  | { readonly kind: 'progress'; readonly loaded: number; readonly total: number | null }
  | { readonly kind: 'done'; readonly file: EmployeeFileView };

// --- Client-side courtesy checks ---------------------------------------------------------------------------------

/** The contract's default limit (`EMPLOYEE_FILE_MAX_BYTES`, 10 MB). The API may be configured higher; it decides. */
export const EMPLOYEE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const EMPLOYEE_FILE_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png'];
/** For `<input type="file" accept>`: the file picker offers only these (users can still pick "all files"). */
export const EMPLOYEE_FILE_ACCEPT = EMPLOYEE_FILE_TYPES.join(',');
export const TITLE_MAX = 120;
const EXTENSIONS = /\.(pdf|jpe?g|png)$/i;

export type FileCheck = 'empty' | 'type' | 'size';

/**
 * Why `file` would be refused, or `null`. `File.type` is the browser's guess from the extension; some systems give ''
 * for a known extension, so the extension alone is accepted then (the API sniffs the bytes either way).
 */
export function checkFile(file: Pick<File, 'name' | 'size' | 'type'>, maxBytes = EMPLOYEE_FILE_MAX_BYTES): FileCheck | null {
  if (file.size === 0) return 'empty';
  const typeOk = file.type ? EMPLOYEE_FILE_TYPES.includes(file.type) : EXTENSIONS.test(file.name);
  if (!typeOk) return 'type';
  if (file.size > maxBytes) return 'size';
  return null;
}

/** A title proposed from a file name: no folders, no extension, `_`/`-` runs as spaces, at most `TITLE_MAX`. */
export function titleFromFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const noExt = base.replace(/\.[^.]{1,5}$/, '');
  return noExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
}

/** `pdf` or `image`, for the icon of a file (from the SNIFFED type the API returns). */
export function fileKind(mime: string): 'pdf' | 'image' | 'other' {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'other';
}

/** The short badge text of a type (`PDF`, `JPG`, `PNG`). */
export function fileBadge(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  return mime.split('/').pop()?.toUpperCase() ?? '?';
}

/** Extensions a saved copy may keep, per sniffed type; the first one is added when the name has none of them. */
const SAVE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
};

/**
 * The name a download is saved under — the API's rule (contract › Settled by the build, Phase B): the stored name,
 * plus the extension of the SNIFFED type when its own extension does not match. A PDF uploaded as `page.html` is saved
 * as `page.html.pdf`, so the copy on disk never opens as HTML (a PDF/HTML polyglot would otherwise run its script in
 * the browser from the disk). The API's `Content-Disposition` already says so, but a `<a download>` of a Blob uses the
 * name the app gives, so the app must apply the same rule.
 */
export function downloadFileName(originalFilename: string, mime: string): string {
  const accepted = SAVE_EXTENSIONS[mime];
  if (!accepted) return originalFilename;
  const dot = originalFilename.lastIndexOf('.');
  const ext = dot > 0 ? originalFilename.slice(dot + 1).toLowerCase() : '';
  return accepted.includes(ext) ? originalFilename : `${originalFilename}.${accepted[0]}`;
}

export interface FileGroup {
  readonly category: EmployeeFileView['category'];
  readonly files: readonly EmployeeFileView[];
}

/**
 * Files grouped by category, in the order of `categories` (the API's order); a category missing from that list (the
 * list failed, or a category became inactive) follows, in order of appearance. Empty categories are left out; files
 * keep their order (newest first, as the API sends them).
 */
export function groupByCategory(
  files: readonly EmployeeFileView[],
  categories: readonly Pick<EmployeeFileCategory, 'id'>[],
): FileGroup[] {
  const byId = new Map<string, { category: EmployeeFileView['category']; files: EmployeeFileView[] }>();
  for (const file of files) {
    const group = byId.get(file.category.id);
    if (group) group.files.push(file);
    else byId.set(file.category.id, { category: file.category, files: [file] });
  }
  const order = new Map(categories.map((c, index) => [c.id, index]));
  return [...byId.values()].toSorted(
    (a, b) => (order.get(a.category.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.category.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Categories offered in the upload form: active ones, medical only with `upload_medical`. */
export function uploadableCategories(
  categories: readonly EmployeeFileCategory[],
  actions: readonly EmployeeFileListAction[],
): EmployeeFileCategory[] {
  return categories.filter(
    (c) => c.active && (c.accessClass === 'medical' ? actions.includes('upload_medical') : actions.includes('upload')),
  );
}

// --- `_actions` / `_redacted` without lint exceptions elsewhere (the field names are the contract's) ---------------

export function fileActions(file: Pick<EmployeeFileView, '_actions'>): readonly EmployeeFileAction[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return file._actions ?? [];
}

export function listActions(list: Pick<EmployeeFileList, '_actions'>): readonly EmployeeFileListAction[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return list._actions ?? [];
}

export function listRedacted(list: Pick<EmployeeFileList, '_redacted'>): readonly 'medical'[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return list._redacted ?? [];
}
