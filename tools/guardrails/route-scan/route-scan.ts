/**
 * Guardrail: route-scan (CONVENTIONS.md › Routes).
 * Every handler of an @Controller class (method with @Get/@Post/@Put/@Patch/@Delete/@All/@Options/@Head)
 * must carry exactly one of @RequirePermission('<resource>.<action>'), @Authenticated() (signed-in caller, no
 * permission) or @Public() — on the method or on the class (the method's declaration wins).
 * Scans apps/api/src (not test/, not *.spec.ts: test-only routes are deliberately undecorated).
 *
 *   npm run guard:route-scan            # violations + route → permission table
 *   npm run guard:route-scan -- --json  # machine-readable table
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type AstNode,
  decoratorCall,
  importBindings,
  nameOf,
  parseTs,
  prop,
  propList,
  stringValue,
  walk,
} from '../lib/ast.ts';
import { listFiles } from '../lib/files.ts';
import { type GuardResult, isMain, printResult, REPO_ROOT, relativeTo, runCli, type Violation } from '../lib/report.ts';

/** `resource.action`, or `resource.field.action` for field-level permissions (e.g. `employee.salary.update`). */
export const PERMISSION_CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;
export const HTTP_DECORATORS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Options', 'Head'] as const;
export const GLOBAL_PREFIX = 'api';
const NEST_COMMON = '@nestjs/common';

export interface RouteEntry {
  method: string;
  path: string;
  access: string; // permission code, "public", "authenticated", or "UNGUARDED"
  controller: string;
  handler: string;
  file: string;
  line: number;
}

export interface RouteScanResult extends GuardResult {
  routes: RouteEntry[];
}

type Resolver = (name: string | undefined) => string | undefined;

/** Resolves a decorator's local name to its canonical name (handles `import { Get as G }` and `common.Get`). */
function makeResolver(program: AstNode): Resolver {
  const bindings = importBindings(program);
  return (name) => {
    if (!name) return undefined;
    const [head, member] = name.split('.', 2);
    if (member !== undefined) {
      return head && bindings.get(head)?.imported === '*' ? member : undefined;
    }
    const binding = bindings.get(name);
    if (!binding) return name;
    // Nest decorators must come from @nestjs/common; RequirePermission/Public/Authenticated from our authz module (any path).
    if ((HTTP_DECORATORS as readonly string[]).includes(binding.imported) || binding.imported === 'Controller') {
      return binding.source === NEST_COMMON ? binding.imported : `${binding.source}:${binding.imported}`;
    }
    return binding.imported;
  };
}

function joinPath(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => p !== undefined && p !== '')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/** Path strings of a @Controller()/@Get() argument: 'x' | ['a','b'] | { path: 'x' } → string[] */
function pathsOf(arg: AstNode | undefined): string[] {
  if (!arg) return [''];
  const literal = stringValue(arg);
  if (literal !== undefined) return [literal];
  if (arg.type === 'ArrayExpression') {
    const values = propList(arg, 'elements').map((e) => stringValue(e) ?? '<dynamic>');
    return values.length ? values : [''];
  }
  if (arg.type === 'ObjectExpression') {
    const pathProp = propList(arg, 'properties').find((p) => nameOf(prop(p, 'key')) === 'path');
    return pathProp ? pathsOf(prop(pathProp, 'value')) : [''];
  }
  return ['<dynamic>'];
}

interface AccessInfo {
  permission?: string;
  isPublic: boolean;
  isAuthenticated: boolean;
  problems: { node: AstNode; message: string }[];
}

function accessOf(decorators: AstNode[], resolve: Resolver): AccessInfo {
  const info: AccessInfo = { isPublic: false, isAuthenticated: false, problems: [] };
  for (const decorator of decorators) {
    const call = decoratorCall(decorator);
    const name = resolve(call.name);
    if (name === 'Public') {
      info.isPublic = true;
    } else if (name === 'Authenticated') {
      info.isAuthenticated = true;
    } else if (name === 'RequirePermission') {
      const code = stringValue(call.args[0]);
      if (info.permission !== undefined) {
        info.problems.push({ node: decorator, message: 'more than one @RequirePermission() on the same target' });
      }
      if (code === undefined) {
        info.problems.push({
          node: decorator,
          message: '@RequirePermission() argument must be a string literal so the permission can be checked statically',
        });
        info.permission = '<dynamic>';
      } else {
        if (!PERMISSION_CODE_PATTERN.test(code)) {
          info.problems.push({
            node: decorator,
            message: `invalid permission code "${code}" (expected lowercase resource.action or resource.field.action, ${PERMISSION_CODE_PATTERN})`,
          });
        }
        info.permission = code;
      }
    }
  }
  if (info.isPublic && info.permission !== undefined) {
    const node = decorators[0];
    if (node) info.problems.push({ node, message: 'both @Public() and @RequirePermission() on the same target' });
  }
  if (info.isAuthenticated && (info.isPublic || info.permission !== undefined)) {
    const node = decorators[0];
    if (node) info.problems.push({ node, message: '@Authenticated() combined with @Public() or @RequirePermission() on the same target' });
  }
  return info;
}

function declaredAccess(info: AccessInfo): string | undefined {
  if (info.isPublic) return 'public';
  if (info.isAuthenticated) return 'authenticated';
  return info.permission;
}

export function scanSource(file: string, text: string): { routes: RouteEntry[]; violations: Violation[] } {
  const parsed = parseTs(file, text);
  const resolve = makeResolver(parsed.program);
  const routes: RouteEntry[] = [];
  const violations: Violation[] = [];
  const at = (node: AstNode) => parsed.lines.position(node.start);

  walk(parsed.program, (node) => {
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return;
    const classDecorators = propList(node, 'decorators');
    const controller = classDecorators.map(decoratorCall).find((c) => resolve(c.name) === 'Controller');
    if (!controller) return;
    const className = nameOf(prop(node, 'id')) ?? '<anonymous>';
    const classAccess = accessOf(classDecorators, resolve);
    for (const problem of classAccess.problems) {
      violations.push({ file, ...at(problem.node), rule: 'route-scan', message: `${className}: ${problem.message}` });
    }
    const prefixes = pathsOf(controller.args[0]);

    for (const member of propList(prop(node, 'body') ?? node, 'body')) {
      if (member.type !== 'MethodDefinition' && member.type !== 'TSAbstractMethodDefinition') continue;
      const decorators = propList(member, 'decorators');
      const httpDecorators = decorators
        .map(decoratorCall)
        .filter((c) => (HTTP_DECORATORS as readonly string[]).includes(resolve(c.name) ?? ''));
      if (httpDecorators.length === 0) continue;
      const handler = nameOf(prop(member, 'key')) ?? '<computed>';
      const methodAccess = accessOf(decorators, resolve);
      const position = at(prop(member, 'key') ?? member);
      for (const problem of methodAccess.problems) {
        violations.push({ file, ...at(problem.node), rule: 'route-scan', message: `${className}.${handler}: ${problem.message}` });
      }

      // Method-level declarations override class-level ones (platform/authz/access-policy.ts does the same).
      const access = declaredAccess(methodAccess) ?? declaredAccess(classAccess) ?? 'UNGUARDED';
      if (access === 'UNGUARDED') {
        violations.push({
          file,
          ...position,
          rule: 'route-scan',
          message: `${className}.${handler} has no @RequirePermission('<resource>.<action>'), @Authenticated() or @Public() (on the method or the class)`,
        });
      }
      for (const http of httpDecorators) {
        for (const prefix of prefixes) {
          for (const sub of pathsOf(http.args[0])) {
            routes.push({
              method: (resolve(http.name) ?? '').toUpperCase(),
              path: joinPath(GLOBAL_PREFIX, prefix, sub),
              access,
              controller: className,
              handler,
              file,
              line: position.line,
            });
          }
        }
      }
    }
  });
  return { routes, violations };
}

export function scanRoutes(root: string = REPO_ROOT, srcDir = 'apps/api/src'): RouteScanResult {
  const files = listFiles(path.join(root, srcDir), (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'));
  const routes: RouteEntry[] = [];
  const violations: Violation[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('@')) continue;
    const result = scanSource(relativeTo(root, file), text);
    routes.push(...result.routes);
    violations.push(...result.violations);
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { name: 'route-scan', routes, violations, info: formatTable(routes) };
}

export function formatTable(routes: RouteEntry[]): string {
  if (routes.length === 0) return '(no routes found)';
  const rows = [['METHOD', 'PATH', 'ACCESS', 'HANDLER'], ...routes.map((r) => [r.method, r.path, r.access, `${r.controller}.${r.handler} (${r.file}:${r.line})`])];
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i] ?? 0) : cell)).join('  ')).join('\n');
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--json')) {
    const result = scanRoutes();
    process.stdout.write(`${JSON.stringify({ routes: result.routes, violations: result.violations }, null, 2)}\n`);
    if (result.violations.length) {
      printResult({ name: result.name, violations: result.violations }, process.stderr);
      process.exitCode = 1;
    }
  } else {
    await runCli(() => scanRoutes());
  }
}
