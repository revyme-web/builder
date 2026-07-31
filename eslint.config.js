import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import reactHooks from 'eslint-plugin-react-hooks';

// Minimal config focused on dead-code cleanup (unused imports/vars). Not a full style gate.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'unused-imports': unusedImports, 'react-hooks': reactHooks },
    rules: {
      // Defer to the plugin so it can auto-remove unused imports.
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
      // The canvas/codegen layers legitimately traffic in dynamic shapes
      // (bridge RPC payloads, parsed JSX fragments) — `any` is tracked as a
      // warning, not an error, so `npm run lint` gates only real dead code.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Hook-deps are hand-tuned in the 60fps canvas paths (deliberately
      // omitted deps are documented at each site) — advisory only.
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'no-empty': 'warn',
      'no-control-regex': 'warn',
      'preserve-caught-error': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-useless-assignment': 'warn',
      'no-irregular-whitespace': ['warn', { skipComments: true, skipStrings: true, skipTemplates: true }],
    },
  },
);
