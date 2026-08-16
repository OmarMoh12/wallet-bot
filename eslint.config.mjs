import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `any` defeats the point of a strictly-typed financial codebase.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Never use floating point for money. Use @wallet/shared money helpers.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number'][parent.type!='TSTypeReference']",
          message:
            'Avoid Number() on monetary values. Use BigInt-based helpers from @wallet/shared/money.',
        },
      ],
    },
  },
  {
    // Scripts, tests and tooling are allowed more freedom.
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      'scripts/**/*.mjs',
      '**/vitest.config.ts',
      '**/*.config.{ts,mjs,js}',
    ],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Standalone Node scripts: plain ESM, run directly by node, so they need the Node
    // globals that the TypeScript packages get from @types/node.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    // CLI entrypoints intentionally write to stdout.
    files: ['**/cli/**/*.ts', 'apps/*/src/index.ts', 'packages/*/src/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.tsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
