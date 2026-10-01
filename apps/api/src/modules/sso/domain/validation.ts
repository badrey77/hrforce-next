/**
 * Validation of the SSO administration bodies (docs/contracts/sso.md › Validation): 422 `validation-error` with
 * `errors[{field, code}]` and the contract's codes (required, too_long, invalid, invalid_uri, insecure_uri, duplicate,
 * too_many, too_short, immutable). Pure: the API layer hands the raw JSON body over, these return the typed input or
 * the issues. Strings are trimmed; URIs are stored exactly as given (trimmed only).
 */
import {
  CLIENT_AUTH_METHODS,
  CLIENT_ID_PATTERN,
  NAME_MAX,
  REASON_MAX,
  REASON_MIN,
  ROLE_CODE_PATTERN,
  uriListIssues,
  type ClientAuthMethod,
  type FieldIssue,
} from './rules.js';

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: FieldIssue[] };

export interface ClientCreateInput {
  clientId: string;
  name: string;
  nameAr: string | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  clientAuthMethod: ClientAuthMethod;
}

export interface ClientPatchInput {
  name?: string;
  nameAr?: string | null;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  clientAuthMethod?: ClientAuthMethod;
}

export interface RoleNames {
  fr: string;
  ar: string;
  en: string;
}

export interface RoleCreateInput {
  code: string;
  names: RoleNames;
}

type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function asObject(body: unknown): Json {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Json) : {};
}

function issue(field: string, code: string, message: string): FieldIssue {
  return { field, code, message };
}

/** A required trimmed text of 1..max characters. */
function text(body: Json, field: string, max: number, issues: FieldIssue[], prefix = field): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    issues.push(issue(prefix, 'required', 'Required.'));
    return undefined;
  }
  if (typeof raw !== 'string') {
    issues.push(issue(prefix, 'invalid', 'Must be a string.'));
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) {
    issues.push(issue(prefix, 'too_long', `At most ${max} characters.`));
    return undefined;
  }
  return value;
}

/** An optional trimmed text (null / blank = none). */
function optionalText(body: Json, field: string, max: number, issues: FieldIssue[]): string | null | undefined {
  const raw = body[field];
  if (raw === undefined) return undefined;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  if (typeof raw !== 'string') {
    issues.push(issue(field, 'invalid', 'Must be a string.'));
    return undefined;
  }
  const value = raw.trim();
  if (value.length > max) {
    issues.push(issue(field, 'too_long', `At most ${max} characters.`));
    return undefined;
  }
  return value;
}

function uriList(body: Json, field: string, required: boolean, issues: FieldIssue[]): string[] | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) issues.push(issue(field, 'required', 'At least one URI is required.'));
    return required ? undefined : [];
  }
  if (!Array.isArray(raw)) {
    issues.push(issue(field, 'invalid', 'Must be a list of URIs.'));
    return undefined;
  }
  const found = uriListIssues(field, raw, { required });
  issues.push(...found);
  return found.length === 0 ? raw.map((u) => String(u).trim()) : undefined;
}

function authMethod(body: Json, issues: FieldIssue[]): ClientAuthMethod | undefined {
  const raw = body['clientAuthMethod'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(CLIENT_AUTH_METHODS as readonly string[]).includes(raw)) {
    issues.push(issue('clientAuthMethod', 'invalid', `One of ${CLIENT_AUTH_METHODS.join(', ')}.`));
    return undefined;
  }
  return raw as ClientAuthMethod;
}

/** POST /sso/clients */
export function validateClientCreate(body: unknown): Validated<ClientCreateInput> {
  const b = asObject(body);
  const issues: FieldIssue[] = [];
  let clientId: string | undefined;
  const rawId = b['clientId'];
  if (rawId === undefined || rawId === null || (typeof rawId === 'string' && rawId.trim() === '')) issues.push(issue('clientId', 'required', 'Required.'));
  else if (typeof rawId !== 'string' || !CLIENT_ID_PATTERN.test(rawId.trim())) {
    issues.push(issue('clientId', 'invalid', 'A lower-case letter, then 2–39 lower-case letters, digits or hyphens.'));
  } else clientId = rawId.trim();
  const name = text(b, 'name', NAME_MAX, issues);
  const nameAr = optionalText(b, 'nameAr', NAME_MAX, issues);
  const redirectUris = uriList(b, 'redirectUris', true, issues);
  const postLogoutRedirectUris = uriList(b, 'postLogoutRedirectUris', false, issues);
  const method = authMethod(b, issues);
  if (issues.length > 0 || clientId === undefined || name === undefined || redirectUris === undefined || postLogoutRedirectUris === undefined) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: { clientId, name, nameAr: nameAr ?? null, redirectUris, postLogoutRedirectUris, clientAuthMethod: method ?? 'client_secret_basic' },
  };
}

/** PATCH /sso/clients/:id — `clientId` is immutable. */
export function validateClientPatch(body: unknown): Validated<ClientPatchInput> {
  const b = asObject(body);
  const issues: FieldIssue[] = [];
  if ('clientId' in b) issues.push(issue('clientId', 'immutable', 'The client id cannot change: register a new app instead.'));
  const value: ClientPatchInput = {};
  if (b['name'] !== undefined) {
    const name = text(b, 'name', NAME_MAX, issues);
    if (name !== undefined) value.name = name;
  }
  const nameAr = optionalText(b, 'nameAr', NAME_MAX, issues);
  if (nameAr !== undefined) value.nameAr = nameAr;
  if (b['redirectUris'] !== undefined) {
    const uris = uriList(b, 'redirectUris', true, issues);
    if (uris) value.redirectUris = uris;
  }
  if (b['postLogoutRedirectUris'] !== undefined) {
    const uris = uriList(b, 'postLogoutRedirectUris', false, issues);
    if (uris) value.postLogoutRedirectUris = uris;
  }
  const method = authMethod(b, issues);
  if (method) value.clientAuthMethod = method;
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function roleNames(body: Json, issues: FieldIssue[]): RoleNames | undefined {
  const raw = body['names'];
  if (raw === undefined || raw === null) {
    issues.push(issue('names.fr', 'required', 'Required.'), issue('names.ar', 'required', 'Required.'), issue('names.en', 'required', 'Required.'));
    return undefined;
  }
  const names = asObject(raw);
  const fr = text(names, 'fr', NAME_MAX, issues, 'names.fr');
  const ar = text(names, 'ar', NAME_MAX, issues, 'names.ar');
  const en = text(names, 'en', NAME_MAX, issues, 'names.en');
  return fr !== undefined && ar !== undefined && en !== undefined ? { fr, ar, en } : undefined;
}

/** POST /sso/clients/:id/roles */
export function validateRoleCreate(body: unknown): Validated<RoleCreateInput> {
  const b = asObject(body);
  const issues: FieldIssue[] = [];
  let code: string | undefined;
  const raw = b['code'];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) issues.push(issue('code', 'required', 'Required.'));
  else if (typeof raw !== 'string' || !ROLE_CODE_PATTERN.test(raw.trim())) {
    issues.push(issue('code', 'invalid', 'A lower-case letter, then 1–39 lower-case letters, digits or underscores.'));
  } else code = raw.trim();
  const names = roleNames(b, issues);
  return issues.length > 0 || code === undefined || names === undefined ? { ok: false, issues } : { ok: true, value: { code, names } };
}

/** PATCH /sso/roles/:roleId — `code` is immutable. */
export function validateRolePatch(body: unknown): Validated<{ names: RoleNames }> {
  const b = asObject(body);
  const issues: FieldIssue[] = [];
  if ('code' in b) issues.push(issue('code', 'immutable', 'The role code cannot change: it travels in the apps’ tokens.'));
  const names = roleNames(b, issues);
  return issues.length > 0 || names === undefined ? { ok: false, issues } : { ok: true, value: { names } };
}

/** POST /sso/clients/:id/disable */
export function validateReason(body: unknown): Validated<string> {
  const b = asObject(body);
  const raw = b['reason'];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return { ok: false, issues: [issue('reason', 'required', 'Required.')] };
  if (typeof raw !== 'string') return { ok: false, issues: [issue('reason', 'invalid', 'Must be a string.')] };
  const value = raw.trim();
  if (value.length < REASON_MIN) return { ok: false, issues: [issue('reason', 'too_short', `At least ${REASON_MIN} characters.`)] };
  if (value.length > REASON_MAX) return { ok: false, issues: [issue('reason', 'too_long', `At most ${REASON_MAX} characters.`)] };
  return { ok: true, value };
}

/** POST /sso/assignments */
export function validateAssignment(body: unknown): Validated<{ userId: string; roleId: string }> {
  const b = asObject(body);
  const issues: FieldIssue[] = [];
  for (const field of ['userId', 'roleId'] as const) {
    const raw = b[field];
    if (raw === undefined || raw === null || raw === '') issues.push(issue(field, 'required', 'Required.'));
    else if (!isUuid(raw)) issues.push(issue(field, 'invalid', 'Must be a UUID.'));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { userId: String(b['userId']).toLowerCase(), roleId: String(b['roleId']).toLowerCase() } };
}

/** GET /sso/assignments?clientId=&userId=&roleId= — optional UUID filters (malformed → 422). */
export function validateAssignmentFilters(query: unknown): Validated<{ clientId?: string; userId?: string; roleId?: string }> {
  const q = asObject(query);
  const issues: FieldIssue[] = [];
  const value: { clientId?: string; userId?: string; roleId?: string } = {};
  for (const field of ['clientId', 'userId', 'roleId'] as const) {
    const raw = q[field];
    if (raw === undefined || raw === '') continue;
    if (!isUuid(raw)) issues.push(issue(field, 'invalid', 'Must be a UUID.'));
    else value[field] = raw.toLowerCase();
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}
