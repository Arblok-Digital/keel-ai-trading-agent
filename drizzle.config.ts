import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/drizzle-diff',
  dialect: 'postgresql',
});
