import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: [
      'core/test/**/*.test.ts',
      'core/test/**/*.test.tsx',
      'react/test/**/*.test.ts',
      'react/test/**/*.test.tsx',
    ],
  },
});
