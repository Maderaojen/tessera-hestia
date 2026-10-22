import path from 'node:path';
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import moduleBoundaries from './eslint/module-boundaries.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      // Express recognizes error-handling middleware purely by arity (must
      // have all 4 params, even when some go unused — e.g. (err, req, res,
      // next) with no next() call). A leading underscore is the
      // conventional "deliberately unused" marker.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Which module may import which (eslint/module-boundaries.js).
    files: ['src/**/*.ts', 'test/**/*.ts', 'modules/**/*.ts'],
    plugins: { hestia: { rules: { 'module-boundaries': moduleBoundaries } } },
    rules: {
      'hestia/module-boundaries': ['error', { root }],
    },
  },
  {
    // Which operating system this is gets asked in one place: the
    // registry in src/host-platform/ picks an implementation per platform;
    // everything else calls that.
    files: ['src/**/*.ts', 'modules/**/*.ts'],
    ignores: ['src/host-platform/**'],
    rules: {
      'no-restricted-properties': ['error',
        { object: 'process', property: 'platform', message: 'Platform differences belong behind src/host-platform/ (one implementation per platform).' },
        { object: 'os', property: 'platform', message: 'Platform differences belong behind src/host-platform/ (one implementation per platform).' },
      ],
    },
  },
  {
    ignores: ['dist/**'],
  }
);
