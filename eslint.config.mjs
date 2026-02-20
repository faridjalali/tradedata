import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/',
      'dist/',
      'analysis/',
      'analysis-*.js',
      'playwright-report/',
      'bin/',
      'public/*.js',
      'test-*.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-undef': 'off', // TypeScript compiler handles this; ESLint no-undef doesn't understand TS globals
      'no-useless-assignment': 'off', // TypeScript handles this; false positives on try/catch and default-init patterns
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
    },
  },
  {
    files: ['index.ts', 'server/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['server/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../routes/*', '../routes/**'],
              message: 'Services must not import routes. Keep business logic route-agnostic.',
            },
            {
              group: ['../../src/*', '../../src/**'],
              message: 'Server services must not import frontend modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['server/orchestrators/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../routes/*', '../routes/**'],
              message: 'Orchestrators must not import routes. Keep orchestration independent of HTTP transport.',
            },
            {
              group: ['../../src/*', '../../src/**'],
              message: 'Orchestrators must not import frontend modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../server/*', '../server/**'],
              message: 'Frontend code must not import server modules. Use shared contracts or API clients.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
      'no-console': 'off',
    },
  },
  prettier,
];
