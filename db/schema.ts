import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const VENUES = ['BINANCE_SPOT', 'UNISWAP_V3', 'RAYDIUM'] as const;
export type Venue = (typeof VENUES)[number];

export const ROLES = ['owner', 'viewer', 'system_agent'] as const;
export type Role = (typeof ROLES)[number];

export const SMART_MONEY_FLOWS = ['ACCUMULATION', 'DISTRIBUTION', 'NEUTRAL'] as const;
export type SmartMoneyFlow = (typeof SMART_MONEY_FLOWS)[number];

export const MTF_BIASES = ['BULLISH', 'BEARISH', 'NEUTRAL'] as const;
export type MtfBiasValue = (typeof MTF_BIASES)[number];

export type MtfBias = {
  m15: MtfBiasValue;
  h1: MtfBiasValue;
  h4: MtfBiasValue;
  d1: MtfBiasValue;
};

export const DECISION_TERMINAL_STATES = ['PENDING', 'EXECUTED', 'REJECTED', 'FAILED'] as const;
export type DecisionTerminalState = (typeof DECISION_TERMINAL_STATES)[number];

export const ORDER_STATUSES = [
  'PENDING',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TRADING_MODES = ['PAPER', 'LIVE'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const SYSTEM_PRINCIPAL_ID = '00000000-0000-0000-0000-00000000a001';
export const SYSTEM_PRINCIPAL_EMAIL = 'system_agent@internal';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('user_roles_user_id_role_key').on(t.userId, t.role)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastRotatedAt: timestamp('last_rotated_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('sessions_family_active_key').on(t.familyId, t.tokenHash)],
);

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venue: text('venue', { enum: VENUES }).notNull(),
    label: text('label').notNull(),
    keyFingerprint: text('key_fingerprint').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    probePassed: boolean('probe_passed').default(false).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    createdBy: uuid('created_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('credentials_venue_label_key').on(t.venue, t.label)],
);

export const earlyDetectionTokens = pgTable('early_detection_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull(),
  venue: text('venue', { enum: VENUES }).notNull(),
  compositeScore: numeric('composite_score').notNull(),
  smartMoneyFlow: text('smart_money_flow', { enum: SMART_MONEY_FLOWS }).notNull(),
  liquidityDepthUsd: numeric('liquidity_depth_usd').notNull(),
  narrativeVelocity: numeric('narrative_velocity').default('0').notNull(),
  mtfAlignment: boolean('mtf_alignment').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
});

export const tradeDecisions = pgTable('trade_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull(),
  venue: text('venue', { enum: VENUES }).notNull(),
  action: text('action', { enum: ['BUY', 'SELL', 'HOLD'] }).notNull(),
  mmThesis: text('mm_thesis').notNull(),
  smartMoneyFlow: text('smart_money_flow', { enum: SMART_MONEY_FLOWS }).notNull(),
  mtfBias: jsonb('mtf_bias').$type<MtfBias>().notNull(),
  liquidityDepthUsd: numeric('liquidity_depth_usd').notNull(),
  stopLossPct: numeric('stop_loss_pct').notNull(),
  takeProfitPct: numeric('take_profit_pct').notNull(),
  sizePct: numeric('size_pct').notNull(),
  riskPassed: boolean('risk_passed').notNull(),
  riskReasons: jsonb('risk_reasons').$type<string[]>().notNull(),
  terminalState: text('terminal_state', { enum: DECISION_TERMINAL_STATES })
    .default('PENDING')
    .notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const decisionTransitions = pgTable(
  'decision_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    decisionId: uuid('decision_id')
      .references(() => tradeDecisions.id)
      .notNull(),
    fromState: text('from_state', { enum: DECISION_TERMINAL_STATES }),
    toState: text('to_state', { enum: DECISION_TERMINAL_STATES }).notNull(),
    reason: text('reason'),
    actorId: uuid('actor_id')
      .references(() => users.id)
      .notNull(),
    serverTime: bigint('server_time', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('decision_transitions_decision_id_to_state_key').on(t.decisionId, t.toState)],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientOrderId: text('client_order_id').notNull().unique(),
    decisionId: uuid('decision_id')
      .references(() => tradeDecisions.id)
      .notNull(),
    venue: text('venue', { enum: VENUES }).notNull(),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
    requestedQty: numeric('requested_qty').notNull(),
    executedQty: numeric('executed_qty').default('0').notNull(),
    avgFillPrice: numeric('avg_fill_price'),
    externalRef: text('external_ref'),
    status: text('status', { enum: ORDER_STATUSES }).notNull(),
    serverTime: bigint('server_time', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('orders_decision_id_key').on(t.decisionId)],
);

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    symbol: text('symbol').notNull(),
    venue: text('venue', { enum: VENUES }).notNull(),
    decisionId: uuid('decision_id')
      .references(() => tradeDecisions.id)
      .notNull(),
    orderId: uuid('order_id')
      .references(() => orders.id)
      .notNull(),
    sizePct: numeric('size_pct').notNull(),
    entryPrice: numeric('entry_price').notNull(),
    stopLossPrice: numeric('stop_loss_price').notNull(),
    takeProfitPrice: numeric('take_profit_price').notNull(),
    currentPnlPct: numeric('current_pnl_pct').default('0').notNull(),
    isOpen: boolean('is_open').default(true).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('positions_decision_id_key').on(t.decisionId),
    uniqueIndex('positions_order_id_key').on(t.orderId),
    uniqueIndex('positions_one_open_per_symbol_key').on(t.symbol).where(sql`is_open = true`),
  ],
);

export const riskLimits = pgTable(
  'risk_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    maxOpenPositions: integer('max_open_positions').default(5).notNull(),
    maxOrdersPerHour: integer('max_orders_per_hour').default(10).notNull(),
    maxDrawdownPct: numeric('max_drawdown_pct').default('3.0').notNull(),
    minPositionSizePct: numeric('min_position_size_pct').default('2.0').notNull(),
    maxPositionSizePct: numeric('max_position_size_pct').default('5.0').notNull(),
    stopLossPct: numeric('stop_loss_pct').default('-2.0').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (_t) => [uniqueIndex('risk_limits_singleton_key').on(sql`true`)],
);

export const killSwitchEvents = pgTable('kill_switch_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggeredBy: uuid('triggered_by')
    .references(() => users.id)
    .notNull(),
  reason: text('reason').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const reconciliationReports = pgTable('reconciliation_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  isSynced: boolean('is_synced').notNull(),
  localBalanceUsd: numeric('local_balance_usd').notNull(),
  exchangeBalanceUsd: numeric('exchange_balance_usd').notNull(),
  discrepancyUsd: numeric('discrepancy_usd').notNull(),
  breakdown: jsonb('breakdown').$type<Record<string, { localUsd: number; exchangeUsd: number }>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id')
    .references(() => users.id)
    .notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  diff: jsonb('diff'),
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const systemMode = pgTable(
  'system_mode',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mode: text('mode', { enum: TRADING_MODES }).default('PAPER').notNull(),
    updatedBy: uuid('updated_by')
      .references(() => users.id)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (_t) => [uniqueIndex('system_mode_singleton_key').on(sql`true`)],
);

export const signalFeatures = pgTable('signal_features', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').references(() => tradeDecisions.id),
  symbol: text('symbol').notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
  source: text('source').notNull(),
  compositeScore: numeric('composite_score'),
  liquidityDepthUsd: numeric('liquidity_depth_usd'),
  narrativeVelocity: numeric('narrative_velocity'),
  mtf: jsonb('mtf').$type<MtfBias>(),
  imbalance: numeric('imbalance'),
  bidDepth1pctUsd: numeric('bid_depth_1pct_usd'),
  askDepth1pctUsd: numeric('ask_depth_1pct_usd'),
  spreadPct: numeric('spread_pct'),
  atr1h: numeric('atr_1h'),
  entryPrice: numeric('entry_price'),
  stopLossPct: numeric('stop_loss_pct'),
  takeProfitPct: numeric('take_profit_pct'),
  sizePct: numeric('size_pct'),
  planReason: text('plan_reason'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const signalOutcomes = pgTable('signal_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').references(() => tradeDecisions.id).notNull(),
  symbol: text('symbol').notNull(),
  entryPrice: numeric('entry_price').notNull(),
  exitPrice: numeric('exit_price'),
  side: text('side', { enum: ['BUY','SELL'] }).notNull(),
  pnlPct: numeric('pnl_pct'),
  rMultiple: numeric('r_multiple'),
  outcome: text('outcome', { enum: ['TP','SL','TIMEOUT','KILL','OPEN'] }).default('OPEN').notNull(),
  barsHeld: integer('bars_held'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
