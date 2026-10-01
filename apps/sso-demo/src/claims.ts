/**
 * The ID-token claims HRForce sends (docs/contracts/sso.md › Claims), read defensively: the demo must render
 * whatever arrives without trusting its shape. `roles` is the only authorization claim; `company`, `employee` and
 * `unit` are display data.
 */
export interface DemoUser {
  name: string;
  email: string | null;
  company: string | null;
  employee: { matricule: string; unit: { name: string; nameAr: string | null } | null } | null;
  roles: string[];
  locale: string | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function readUser(claims: Json): DemoUser {
  const email = str(claims['email']);
  const company = isObject(claims['company']) ? str(claims['company']['name']) : null;
  let employee: DemoUser['employee'] = null;
  const e = claims['employee'];
  if (isObject(e) && str(e['matricule'])) {
    const u = e['unit'];
    employee = {
      matricule: str(e['matricule']) ?? '',
      unit: isObject(u) && str(u['name']) ? { name: str(u['name']) ?? '', nameAr: str(u['nameAr']) } : null,
    };
  }
  const roles = Array.isArray(claims['roles']) ? claims['roles'].filter((r): r is string => typeof r === 'string') : [];
  return {
    name: str(claims['name']) ?? email ?? str(claims['sub']) ?? '?',
    email,
    company,
    employee,
    roles,
    locale: str(claims['locale']),
  };
}
