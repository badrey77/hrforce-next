import { parseSync } from 'oxc-parser';
import { LineIndex } from './files.ts';

/**
 * Minimal, loosely typed view of the ESTree-compatible AST produced by oxc-parser.
 * (TypeScript 7 ships no JS compiler API, so the guardrails parse with oxc — the same parser family as oxlint.)
 */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface ParsedFile {
  program: AstNode;
  lines: LineIndex;
  text: string;
}

export class ParseError extends Error {}

export function parseTs(file: string, text: string): ParsedFile {
  const result = parseSync(file, text, { sourceType: 'module', lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const first = result.errors[0];
  if (first) {
    throw new ParseError(`${file}: cannot parse (${first.message})`);
  }
  return { program: result.program as unknown as AstNode, lines: new LineIndex(text), text };
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function children(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/** Depth-first walk; return false from `visit` to skip a node's children. */
export function walk(node: AstNode, visit: (node: AstNode, ancestors: readonly AstNode[]) => boolean | void): void {
  const stack: AstNode[] = [];
  const recurse = (current: AstNode): void => {
    if (visit(current, stack) === false) return;
    stack.push(current);
    for (const child of children(current)) recurse(child);
    stack.pop();
  };
  recurse(node);
}

export function prop(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

export function propList(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** `foo` → "foo", `'foo'` → "foo" (property keys / identifiers / string literals). */
export function nameOf(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') return node['name'] as string;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  return undefined;
}

/** Static string value of a string literal or a template literal without expressions. */
export function stringValue(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value'];
  if (node.type === 'TemplateLiteral' && propList(node, 'expressions').length === 0) {
    const quasi = propList(node, 'quasis')[0];
    const value = quasi?.['value'] as { cooked?: string; raw?: string } | undefined;
    return value?.cooked ?? value?.raw ?? '';
  }
  return undefined;
}

/** A decorator's name and call arguments: `@Get('x')` → {name: 'Get', args: [...]}, `@Foo` → {name:'Foo', args: []}. */
export function decoratorCall(decorator: AstNode): { name: string | undefined; args: AstNode[]; node: AstNode } {
  const expression = prop(decorator, 'expression');
  if (!expression) return { name: undefined, args: [], node: decorator };
  if (expression.type === 'CallExpression') {
    return { name: calleeName(prop(expression, 'callee')), args: propList(expression, 'arguments'), node: expression };
  }
  return { name: calleeName(expression), args: [], node: expression };
}

function calleeName(callee: AstNode | undefined): string | undefined {
  if (!callee) return undefined;
  if (callee.type === 'Identifier') return callee['name'] as string;
  // `ns.Get` → "ns.Get"
  if (callee.type === 'MemberExpression' && !callee['computed']) {
    const object = calleeName(prop(callee, 'object'));
    const property = nameOf(prop(callee, 'property'));
    return object && property ? `${object}.${property}` : undefined;
  }
  return undefined;
}

export interface ImportBinding {
  /** Imported name (`default` / `*` for default / namespace imports). */
  imported: string;
  source: string;
}

/** Local name → import binding for every import declaration in the program. */
export function importBindings(program: AstNode): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const statement of propList(program, 'body')) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = stringValue(prop(statement, 'source')) ?? '';
    for (const specifier of propList(statement, 'specifiers')) {
      const local = nameOf(prop(specifier, 'local'));
      if (!local) continue;
      const imported =
        specifier.type === 'ImportDefaultSpecifier'
          ? 'default'
          : specifier.type === 'ImportNamespaceSpecifier'
            ? '*'
            : (nameOf(prop(specifier, 'imported')) ?? local);
      map.set(local, { imported, source });
    }
  }
  return map;
}
