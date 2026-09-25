import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'core/src/index.ts',
    'local-sync': 'core/src/local-sync/index.ts',
    react: 'react/src/index.ts',
    advanced: 'core/src/projection/advanced.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  // Published JavaScript remains readable; source maps belong to the debug build.
  sourcemap: false,
  clean: true,
  platform: 'neutral',
  deps: {
    neverBundle: ['doxum', 'react'],
  },
});
