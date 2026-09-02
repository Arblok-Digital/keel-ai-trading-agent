import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: optionalString,
  ADMIN_DATABASE_URL: optionalString,
  REDIS_URL: optionalString,
  VAULT_MASTER_KEY: optionalString,
  JWT_PRIVATE_KEY: optionalString,
  JWT_PUBLIC_KEY: optionalString,
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(604800),
  MFA_SECRET: optionalString,
  INTERNAL_HMAC_SECRET: optionalString,
  OWNER_EMAIL: optionalString,
  OWNER_PASSWORD: optionalString,
  BINANCE_API_URL: z.string().url().default('https://api.binance.com'),
  BINANCE_API_KEY: optionalString,
  BINANCE_API_SECRET: optionalString,
  EVM_RPC_URL: optionalString,
  EVM_CHAIN_ID: z.coerce.number().int().positive().default(1),
  UNISWAP_ROUTER_ADDRESS: optionalString,
  UNISWAP_QUOTER_ADDRESS: optionalString,
  SOLANA_RPC_URL: optionalString,
  RAYDIUM_AMM_V4_PROGRAM: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  ARCHIVE_DIR: z.string().default('./data/archive'),
  ENABLE_COINBASE: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
