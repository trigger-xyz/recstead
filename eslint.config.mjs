import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

export default ts.config(
  { ignores: ['node_modules/**', 'dist/**', '.artifacts/**', '.private/**'] },
  { files: ['src/**/*.ts', 'examples/**/*.{ts,tsx}', 'tests/browser/**/*.ts', 'playwright.config.ts'],
    extends: [js.configs.recommended, ...ts.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } },
  { files: ['scripts/**/*.mjs', 'examples/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }] } },
  { files: ['examples/**/*.{ts,tsx}', 'tests/browser/**/*.ts', 'playwright.config.ts'],
    languageOptions: { parserOptions: { project: './tsconfig.examples.json', tsconfigRootDir: import.meta.dirname } },
    rules: { '@typescript-eslint/no-floating-promises': 'error', '@typescript-eslint/no-misused-promises': 'error' } },
);
