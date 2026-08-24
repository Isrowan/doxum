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
              message: '@doxa/core must remain framework-neutral.',
            },
            {
              name: 'react-dom',
              message: '@doxa/core must remain framework-neutral.',
            },
          ],
          patterns: [
            {
              group: ['react/*', 'react-dom/*'],
              message: '@doxa/core must remain framework-neutral.',
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
              group: ['@doxa/core/src/*', '../core/*', '../../core/*'],
              message: '@doxa/react must depend on @doxa/core public exports.',
            },
          ],
        },
      ],
    },
  }
);
