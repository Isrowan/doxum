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
              group: ['doxum/src/*', '../core/*', '../../core/*'],
              message: 'doxum/react must depend on doxum public exports.',
            },
          ],
        },
      ],
    },
  }
);
