import { defineConfig } from 'vitest/config';

// Unit tests of the CI guardrails (tools/guardrails/**/*.spec.ts). The apps have their own Vitest configs.
export default defineConfig({
  test: {
    name: 'tools',
    root: import.meta.dirname,
    include: ['tools/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/__fixtures__/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
