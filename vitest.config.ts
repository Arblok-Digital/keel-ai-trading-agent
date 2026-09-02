import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      VAULT_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      JWT_PRIVATE_KEY: '',
      JWT_PUBLIC_KEY: '',
      MFA_SECRET: 'JBSWY3DPEHPK3PXP',
      INTERNAL_HMAC_SECRET: 'test-hmac-secret',
    },
  },
});
