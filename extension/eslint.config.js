import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // `_name` marks a binding that is there on purpose: a rest-destructure that drops a field, a
      // parameter a signature requires
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Wire formats of external APIs (model providers, MCP / OAuth servers, SSE payloads) are read
    // loosely on purpose, and tests inspect raw rows and requests; everything else is typed.
    files: ['src/providers/**', 'src/connections/mcp.ts', 'src/connections/oauth.ts', 'src/utils/sse.ts', 'test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
