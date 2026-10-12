import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.run/` holds local dev artefacts (env file, logs, PIDs, throwaway test
  // harnesses) and is gitignored, so it is not part of the linted source.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts', '.run/**', '.vercel/**', '.netlify/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    // The service worker runs in its own global scope: `self`, `caches` and
    // `fetch` are the platform it is written against, not undefined variables.
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
