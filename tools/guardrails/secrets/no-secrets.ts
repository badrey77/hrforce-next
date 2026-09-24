/**
 * Guardrail: no-secrets-in-payload (CONVENTIONS.md › Security).
 * Response payloads never contain keys matching /(password|hash|token|secret)/i. Statically, in apps/api/src
 * (not *.spec.ts), no such property may be declared by:
 *   - DTO / payload types: classes, interfaces and type aliases named *Dto|*Request|*Response|*Payload|*View|*Body,
 *     classes extending createZodDto(...) (their zod shape keys), and every class/interface/type literal in
 *     files under an `api/` directory or named *.dto.ts / *.controller.ts;
 *   - controller handlers: object literals returned by @Get/@Post/… methods and their declared return types
 *     (same-file interfaces / type aliases are resolved).
 * Request DTOs that legitimately take a secret as INPUT (e.g. a login password) are allowlisted with a reason in
 * tools/guardrails/secret-fields-allow.json → [{ file, symbol, property, reason }]; stale entries fail.
 * Also asserts the e2e helper `assertNoSecrets` exists with the same key pattern.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type AstNode, decoratorCall, importBindings, isNode, nameOf, parseTs, prop, propList, walk } from '../lib/ast.ts';
import { listFiles } from '../lib/files.ts';
import { type GuardResult, isMain, REPO_ROOT, relativeTo, runCli, type Violation } from '../lib/report.ts';
import { HTTP_DECORATORS } from '../route-scan/route-scan.ts';

export const SECRET_KEY_PATTERN = /(password|hash|token|secret)/i;
export const ALLOW_FILE = 'tools/guardrails/secret-fields-allow.json';
export const ASSERT_HELPER = 'apps/api/test/support/assert-no-secrets.ts';
const DTO_NAME = /(Dto|Request|Response|Payload|View|Body)$/;
/** API-layer files: an `api/` directory below src/ (not the `apps/api` app folder), DTO and controller files. */
const API_FILE = /(^|\/)src\/(.+\/)?api\/|\.dto\.ts$|\.controller\.ts$/;

export interface AllowEntry {
  file: string;
  symbol: string;
  property: string;
  reason: string;
}

interface Finding {
  file: string;
  line: number;
  column: number;
  symbol: string;
  property: string;
  kind: string;
}

function memberKey(member: AstNode): AstNode | undefined {
  return prop(member, 'key');
}

/** Property names declared by a type node (type literal / interface body), recursing into nested literals. */
function typeMembers(node: AstNode | undefined, visit: (key: AstNode) => void): void {
  if (!node) return;
  walk(node, (n) => {
    if (n.type === 'TSPropertySignature' || n.type === 'TSMethodSignature') {
      const key = memberKey(n);
      if (key) visit(key);
    }
  });
}

export function scanSource(file: string, text: string): Finding[] {
  const parsed = parseTs(file, text);
  const findings: Finding[] = [];
  const bindings = importBindings(parsed.program);
  const isApiFile = API_FILE.test(file);
  const typeDecls = new Map<string, AstNode>();
  const add = (symbol: string, key: AstNode, kind: string) => {
    const name = nameOf(key);
    if (name && SECRET_KEY_PATTERN.test(name)) {
      findings.push({ file, ...parsed.lines.position(key.start), symbol, property: name, kind });
    }
  };
  const objectKeys = (node: AstNode | undefined, symbol: string, kind: string) => {
    if (!node) return;
    walk(node, (n) => {
      if (n.type === 'Property' && !n['computed']) {
        const key = memberKey(n);
        if (key) add(symbol, key, kind);
      }
      // do not descend into nested functions of returned literals
      return !/Function/.test(n.type) || n === node;
    });
  };

  walk(parsed.program, (node) => {
    if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') {
      const name = nameOf(prop(node, 'id'));
      if (name) typeDecls.set(name, node);
    }
  });

  walk(parsed.program, (node) => {
    if (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') {
      const name = nameOf(prop(node, 'id')) ?? '<anonymous>';
      if (isApiFile || DTO_NAME.test(name)) typeMembers(node, (key) => add(name, key, 'type'));
      return false;
    }
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return true;
    const className = nameOf(prop(node, 'id')) ?? '<anonymous>';
    const superClass = prop(node, 'superClass');
    let zodDto = false;
    if (superClass) {
      walk(superClass, (n) => {
        if (n.type === 'CallExpression' && nameOf(prop(n, 'callee')) === 'createZodDto') zodDto = true;
      });
    }
    const body = propList(prop(node, 'body') ?? node, 'body');
    if (zodDto && superClass) objectKeys(superClass, className, 'zod DTO');
    if (zodDto || isApiFile || DTO_NAME.test(className)) {
      for (const member of body) {
        if (member.type === 'PropertyDefinition' || member.type === 'TSAbstractPropertyDefinition') {
          const key = memberKey(member);
          if (key && !member['static']) add(className, key, 'DTO property');
        }
        // constructor parameter properties (`constructor(public token: string)`)
        if (member.type === 'MethodDefinition' && nameOf(memberKey(member)) === 'constructor') {
          for (const param of propList(prop(member, 'value') ?? member, 'params')) {
            if (param.type === 'TSParameterProperty') {
              const inner = prop(param, 'parameter');
              const id = inner?.type === 'AssignmentPattern' ? prop(inner, 'left') : inner;
              if (id) add(className, id, 'DTO property');
            }
          }
        }
      }
    }

    // Controller handlers: returned object literals + declared return types.
    const isController = propList(node, 'decorators').some((d) => {
      const name = decoratorCall(d).name;
      return name !== undefined && (bindings.get(name)?.imported ?? name) === 'Controller';
    });
    if (!isController) return true;
    for (const member of body) {
      if (member.type !== 'MethodDefinition') continue;
      const handler = propList(member, 'decorators').some((d) => {
        const name = decoratorCall(d).name;
        return name !== undefined && (HTTP_DECORATORS as readonly string[]).includes(bindings.get(name)?.imported ?? name);
      });
      if (!handler) continue;
      const symbol = `${className}.${nameOf(memberKey(member)) ?? '<computed>'}`;
      const fn = prop(member, 'value');
      if (!fn) continue;
      const returnType = prop(fn, 'returnType');
      typeMembers(returnType, (key) => add(symbol, key, 'handler return type'));
      if (returnType) {
        walk(returnType, (n) => {
          if (n.type === 'TSTypeReference') {
            const ref = nameOf(prop(n, 'typeName'));
            const decl = ref ? typeDecls.get(ref) : undefined;
            if (ref && decl && !DTO_NAME.test(ref) && !isApiFile) typeMembers(decl, (key) => add(ref, key, 'handler return type'));
          }
        });
      }
      const fnBody = prop(fn, 'body');
      if (!fnBody) continue;
      walk(fnBody, (n) => {
        if (n !== fnBody && /Function/.test(n.type)) return false;
        if (n.type === 'ReturnStatement') {
          const argument = prop(n, 'argument');
          if (argument && isNode(argument)) objectKeys(argument, symbol, 'handler return value');
        }
        return true;
      });
    }
    return true;
  });
  return dedupe(findings);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const id = `${f.file}:${f.line}:${f.column}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function loadAllowlist(root: string): { entries: AllowEntry[]; violations: Violation[] } {
  const violations: Violation[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(root, ALLOW_FILE), 'utf8'));
  } catch (error) {
    return { entries: [], violations: [{ file: ALLOW_FILE, rule: 'secrets/allowlist', message: `cannot read allowlist: ${(error as Error).message}` }] };
  }
  const entries: AllowEntry[] = [];
  const list = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) violations.push({ file: ALLOW_FILE, rule: 'secrets/allowlist', message: 'must be a JSON array' });
  list.forEach((item: unknown, index) => {
    const e = item as Partial<AllowEntry>;
    if (typeof e.file !== 'string' || typeof e.symbol !== 'string' || typeof e.property !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) {
      violations.push({ file: ALLOW_FILE, rule: 'secrets/allowlist', message: `entry ${index} needs non-empty string file, symbol, property and reason` });
      return;
    }
    if (!/(Request|Input|Body|Command)(Dto)?$/.test(e.symbol) && !/^(Login|SignIn|ChangePassword|ResetPassword)/.test(e.symbol)) {
      violations.push({ file: ALLOW_FILE, rule: 'secrets/allowlist', message: `entry ${index} (${e.symbol}): only request/input DTOs may be allowlisted (name must end with Request|Input|Body|Command[Dto])` });
      return;
    }
    entries.push(e as AllowEntry);
  });
  return { entries, violations };
}

export function checkAssertHelper(root: string): Violation[] {
  let text: string;
  try {
    text = readFileSync(path.join(root, ASSERT_HELPER), 'utf8');
  } catch {
    return [{ file: ASSERT_HELPER, rule: 'secrets/assert-helper', message: 'e2e helper assertNoSecrets(body) is missing' }];
  }
  const parsed = parseTs(ASSERT_HELPER, text);
  let exported = false;
  let pattern: { pattern: string; flags: string } | undefined;
  for (const statement of propList(parsed.program, 'body')) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const decl = prop(statement, 'declaration');
    if (decl?.type === 'FunctionDeclaration' && nameOf(prop(decl, 'id')) === 'assertNoSecrets') exported = true;
    if (decl?.type === 'VariableDeclaration') {
      for (const d of propList(decl, 'declarations')) {
        const init = prop(d, 'init');
        if (nameOf(prop(d, 'id')) === 'SECRET_KEY_PATTERN' && init?.type === 'Literal') {
          pattern = init['regex'] as { pattern: string; flags: string };
        }
      }
    }
  }
  const violations: Violation[] = [];
  if (!exported) violations.push({ file: ASSERT_HELPER, rule: 'secrets/assert-helper', message: 'must export function assertNoSecrets(body)' });
  if (!pattern || pattern.pattern !== SECRET_KEY_PATTERN.source || !pattern.flags.includes('i')) {
    violations.push({ file: ASSERT_HELPER, rule: 'secrets/assert-helper', message: `must export SECRET_KEY_PATTERN = ${SECRET_KEY_PATTERN}` });
  }
  return violations;
}

export function checkNoSecrets(root: string = REPO_ROOT, srcDir = 'apps/api/src'): GuardResult {
  const { entries, violations } = loadAllowlist(root);
  violations.push(...checkAssertHelper(root));
  const used = new Set<AllowEntry>();
  const files = listFiles(path.join(root, srcDir), (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'));
  for (const abs of files) {
    const file = relativeTo(root, abs);
    for (const f of scanSource(file, readFileSync(abs, 'utf8'))) {
      const allow = entries.find((e) => e.file === f.file && e.symbol === f.symbol && e.property === f.property);
      if (allow) {
        used.add(allow);
        continue;
      }
      violations.push({
        file: f.file,
        line: f.line,
        column: f.column,
        rule: 'secrets/payload-key',
        message: `${f.kind} ${f.symbol} declares "${f.property}" (matches ${SECRET_KEY_PATTERN}); never expose secrets — or allowlist a request DTO in ${ALLOW_FILE}`,
      });
    }
  }
  for (const e of entries) {
    if (!used.has(e)) {
      violations.push({ file: ALLOW_FILE, rule: 'secrets/allowlist', message: `stale entry: ${e.file} ${e.symbol}.${e.property} no longer exists` });
    }
  }
  return { name: 'no-secrets-in-payload', violations };
}

if (isMain(import.meta.url)) await runCli(() => checkNoSecrets());
