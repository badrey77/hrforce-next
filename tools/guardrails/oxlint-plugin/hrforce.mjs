// oxlint JS plugin with HRForce-specific rules (enabled in .oxlintrc.json → "jsPlugins").
// Mirrors the `migrations/no-sql-raw` guardrail so editors / `npm run lint` flag it too.

/** @param {any} node */
function propertyName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal') return node.property.value;
  return undefined;
}

const noSqlRaw = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow kysely `sql.raw` (CONVENTIONS.md › Database)' },
    messages: {
      banned: '`sql.raw` is banned — use Kysely builders or the `sql` tagged template (sql.ref / sql.id / sql.lit).',
    },
  },
  /** @param {any} context */
  create(context) {
    const sqlNames = new Set(['sql']);
    return {
      /** @param {any} node */
      ImportDeclaration(node) {
        if (node.source.value !== 'kysely') return;
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === 'sql') sqlNames.add(s.local.name);
        }
      },
      /** @param {any} node */
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && sqlNames.has(node.object.name) && propertyName(node) === 'raw') {
          context.report({ node, messageId: 'banned' });
        }
      },
      /** @param {any} node */
      VariableDeclarator(node) {
        if (node.id.type !== 'ObjectPattern' || node.init?.type !== 'Identifier' || !sqlNames.has(node.init.name)) return;
        for (const p of node.id.properties) {
          if (p.type === 'Property' && (p.key.name ?? p.key.value) === 'raw') context.report({ node: p, messageId: 'banned' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'hrforce' },
  rules: { 'no-sql-raw': noSqlRaw },
};
