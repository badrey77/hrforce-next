import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits legacy decorators + decorator metadata, which Nest's DI needs (esbuild/oxc do not emit metadata).
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2023',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true, useDefineForClassFields: false },
  },
});

export default defineConfig({
  oxc: false,
  plugins: [swcPlugin],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
