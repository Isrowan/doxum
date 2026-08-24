import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'core/src/index.ts',
    integration: 'core/src/integration.ts',
    react: 'react/src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'neutral',
  deps: {
    neverBundle: ['doxum', 'react'],
  },
});
