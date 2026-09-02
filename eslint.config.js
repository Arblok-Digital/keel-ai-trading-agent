// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'db/migrations/**', 'dist/**', 'opendesign/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'Date.now() is forbidden: use TimeService.now() (AGENTS.md rule #8).',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'new Date() without arguments is forbidden: use TimeService.now().',
        },
      ],
    },
  },
  {
    files: ['src/services/ingestion/time-sync.ts', 'src/services/ingestion/feed-manager.ts', 'src/services/ingestion/gate-ws-stream.ts', 'src/services/ingestion/coinbase-stream.ts', 'src/services/ingestion/binance-vision-rest.ts', 'src/services/execution/executor.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
