import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBoundaries } from './boundaries.ts';

const fixture = (name: string) => path.join(import.meta.dirname, '__fixtures__', name);

describe('boundaries (dependency-cruiser rules)', () => {
  it('reports every rule violated by the "bad" fixture tree', async () => {
    const result = await checkBoundaries(fixture('bad'));
    const found = result.violations.map((v) => `${v.rule} ${v.file} ${v.message}`);

    expect(found).toEqual(
      expect.arrayContaining([
        // 1. platform ↛ modules
        expect.stringMatching(/api-platform-not-to-modules apps\/api\/src\/platform\/db\/leak\.ts .*employee\/infra/),
        // 2. cross-module only through index.ts (value AND type-only imports)
        expect.stringMatching(/api-cross-module-via-index .*payroll\/application\/run-payroll\.ts .*employee\/infra\/employee\.repository\.ts/),
        expect.stringMatching(/api-cross-module-via-index .*payroll\/application\/run-payroll\.ts .*employee\/domain\/employee\.ts/),
        // 3. domain is pure: no @nestjs, no kysely (even `import type`), no infra/api
        expect.stringMatching(/api-domain-is-pure .*domain\/employee\.ts .*node_modules\/@nestjs\/common/),
        expect.stringMatching(/api-domain-is-pure .*domain\/employee\.ts .*node_modules\/kysely/),
        expect.stringMatching(/api-domain-is-pure .*domain\/employee\.ts .*infra\/employee\.repository\.ts/),
        // 4. no cycles
        expect.stringMatching(/no-circular .*application\/a\.ts circular dependency: .*a\.ts → .*b\.ts → .*a\.ts/),
        // web
        expect.stringMatching(/web-feature-isolation apps\/web\/src\/app\/features\/a\/a\.page\.ts .*features\/b\/b\.service\.ts/),
        expect.stringMatching(/web-core-not-to-features apps\/web\/src\/app\/core\/menu\.ts .*features\/a\/a\.page\.ts/),
        // the SSO demo app stays separate from the API and the web
        expect.stringMatching(/sso-demo-standalone apps\/sso-demo\/src\/reach-into-api\.ts .*apps\/api\/src\/platform\/db\/leak\.ts/),
      ]),
    );
    // importing another module through its index.ts is allowed
    expect(found.some((m) => /via-index .*employee\/index\.ts/.test(m))).toBe(false);
    expect(result.violations).toHaveLength(10);
  });

  it('accepts the "good" fixture tree (index imports, pure domain, shared/core use from features)', async () => {
    const result = await checkBoundaries(fixture('good'));
    expect(result.violations).toEqual([]);
    expect(result.info).toMatch(/cruised/);
  });
});
