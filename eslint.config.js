import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'agentapps/main.mjs', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.ts', 'scripts/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // stdout is the MCP stdio channel. A single stray write corrupts JSON-RPC.
      'no-console': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNever: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    // The entrypoint and the operator scripts are the only places allowed to touch
    // process streams directly. The scripts are diagnostic tools that print MCP tool
    // results, which are untyped JSON by design.
    files: ['src/index.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    /**
     * The Google Ads response boundary.
     *
     * A GAQL row's shape is determined by the SELECT clause at runtime, so
     * `GoogleAdsRow` is genuinely `Record<string, any>` - there is no compile-time
     * type to check against. These modules map those rows into the typed structures
     * the tools return, and every access is written defensively (optional chaining,
     * `?? null`, explicit String()/Number() conversion) precisely because the value
     * may be absent or of an unexpected type.
     *
     * The `any`-family rules cannot distinguish that defensive mapping from careless
     * access, and `no-unnecessary-condition` actively misreads the defensive checks
     * as redundant because it sees `any`. They are disabled here and nowhere else;
     * the rest of the codebase is checked at full strictness.
     */
    files: [
      'src/mcp/tools/read/**/*.ts',
      'src/mcp/tools/mutations/**/*.ts',
      'src/mcp/tools/shared/performance.ts',
      'src/google-ads/queries/**/*.ts',
      'src/google-ads/errors.ts',
      'src/google-ads/types.ts',
      'src/mcp/register-tools.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
