import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ['core/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message: 'Doxum core must remain framework-neutral.',
            },
            {
              name: 'react-dom',
              message: 'Doxum core must remain framework-neutral.',
            },
          ],
          patterns: [
            {
              group: ['react/*', 'react-dom/*'],
              message: 'Doxum core must remain framework-neutral.',
            },
            {
              group: ['doxum', 'doxum/*'],
              message: 'Doxum core must import internal modules through ./ or @/.',
            },
            {
              group: ['../*', '../**'],
              message: 'Cross-directory core imports must use the @/ alias.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['react/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', 'doxum/src/*', '../core/*', '../../core/*'],
              message: 'doxum/react must depend on doxum public exports.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['core/test/**/*.{ts,tsx}', 'core/bench/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../src', '../src/*', '../src/**'],
              message: 'Use doxum public exports or @/ for internal core imports.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['react/test/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', '../src', '../src/*', '../src/**'],
              message: 'React adapter tests must use doxum/react public exports.',
            },
          ],
        },
      ],
    },
  }
);
