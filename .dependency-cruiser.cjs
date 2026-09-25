// Boundary rules — CONVENTIONS.md › "Module layout and boundaries" (API) and the web feature isolation rules.
// Run: npm run guard:boundaries   (tests: tools/guardrails/boundaries/boundaries.spec.ts)
// Paths are matched relative to the directory depcruise runs in (the repo root; fixtures mirror that layout).

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'api-platform-not-to-modules',
      comment: 'platform/** is cross-cutting infrastructure and must not import feature modules (rule 1).',
      severity: 'error',
      from: { path: '^apps/api/src/platform/' },
      to: { path: '^apps/api/src/modules/' },
    },
    {
      name: 'api-cross-module-via-index',
      comment: 'A module may import another module only through modules/<other>/index.ts (rule 2).',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'api-domain-is-pure',
      comment: 'domain/** must not import @nestjs/*, kysely, infra/** or api/** (rule 3).',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/domain/' },
      to: {
        path: [
          '(^|/)node_modules/@nestjs/',
          '(^|/)node_modules/kysely/',
          '^@nestjs/',
          '^kysely$',
          '^apps/api/src/modules/[^/]+/(infra|api)/',
        ],
      },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies (rule 4).',
      severity: 'error',
      from: { path: '^apps/(api|web)/src/' },
      to: { circular: true },
    },
    {
      name: 'web-feature-isolation',
      comment: "A web feature must not import another feature's files (share through core/ or shared/).",
      severity: 'error',
      from: { path: '^apps/web/src/app/features/([^/]+)/' },
      to: { path: '^apps/web/src/app/features/', pathNot: '^apps/web/src/app/features/$1/' },
    },
    {
      name: 'web-core-not-to-features',
      comment: 'core/** is app-wide infrastructure and must not depend on features.',
      severity: 'error',
      from: { path: '^apps/web/src/app/core/' },
      to: { path: '^apps/web/src/app/features/' },
    },
    {
      name: 'web-shared-not-to-features',
      comment: 'shared/** is reusable UI; it may use core/ but must not depend on features.',
      severity: 'error',
      from: { path: '^apps/web/src/app/shared/' },
      to: { path: '^apps/web/src/app/features/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'Relative imports must resolve (otherwise the rules above cannot see them).',
      severity: 'error',
      from: { path: '^apps/(api|web)/src/' },
      to: { couldNotResolve: true, path: '^\\.' },
    },
  ],
  options: {
    // TypeScript 7 has no JS compiler API; @swc/core (already used by the API tests) parses TS + decorators.
    parser: 'swc',
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    // Only exclude build output of our own apps: excluded paths vanish from the graph, so excluding node_modules
    // (or any `dist/`, e.g. node_modules/kysely/dist) would hide exactly what the domain rule must see.
    exclude: { path: ['^apps/[^/]+/(dist|coverage|\\.angular)/'] },
    enhancedResolveOptions: {
      extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      exportsFields: ['exports'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
