-- ============================================================================
-- 0000_init — Full domain schema (mirrors db/schema.ts exactly)
-- The [RLS] marker below is substituted by src/db/migrate.ts with the full
-- contents of db/rls.sql so policies, triggers, and seeds are applied inside
-- THIS SAME migration transaction (AGENTS.md hard rule #6).
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_id_role_key ON user_roles (user_id, role);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_rotated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_family_active_key ON sessions (family_id, token_hash);

CREATE TABLE IF NOT EXISTS credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue text NOT NULL,
  label text NOT NULL,
  key_fingerprint text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  scopes jsonb NOT NULL,
  probe_passed boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_venue_label_key ON credentials (venue, label);

CREATE TABLE IF NOT EXISTS early_detection_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  venue text NOT NULL,
  composite_score numeric NOT NULL,
  smart_money_flow text NOT NULL,
  liquidity_depth_usd numeric NOT NULL,
  narrative_velocity numeric NOT NULL DEFAULT 0,
  mtf_alignment boolean NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  venue text NOT NULL,
  action text NOT NULL,
  mm_thesis text NOT NULL,
  smart_money_flow text NOT NULL,
  mtf_bias jsonb NOT NULL,
  liquidity_depth_usd numeric NOT NULL,
  stop_loss_pct numeric NOT NULL,
  take_profit_pct numeric NOT NULL,
  size_pct numeric NOT NULL,
  risk_passed boolean NOT NULL,
  risk_reasons jsonb NOT NULL,
  terminal_state text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decision_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES trade_decisions(id),
  from_state text,
  to_state text NOT NULL,
  reason text,
  actor_id uuid NOT NULL REFERENCES users(id),
  server_time bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS decision_transitions_decision_id_key; CREATE UNIQUE INDEX IF NOT EXISTS decision_transitions_decision_id_to_state_key ON decision_transitions (decision_id, to_state);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id text NOT NULL UNIQUE,
  decision_id uuid NOT NULL REFERENCES trade_decisions(id),
  venue text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  requested_qty numeric NOT NULL,
  executed_qty numeric NOT NULL DEFAULT 0,
  avg_fill_price numeric,
  external_ref text,
  status text NOT NULL,
  server_time bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_decision_id_key ON orders (decision_id);

CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  venue text NOT NULL,
  decision_id uuid NOT NULL REFERENCES trade_decisions(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  size_pct numeric NOT NULL,
  entry_price numeric NOT NULL,
  stop_loss_price numeric NOT NULL,
  take_profit_price numeric NOT NULL,
  current_pnl_pct numeric NOT NULL DEFAULT 0,
  is_open boolean NOT NULL DEFAULT true,
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS positions_decision_id_key ON positions (decision_id);
CREATE UNIQUE INDEX IF NOT EXISTS positions_order_id_key ON positions (order_id);

CREATE TABLE IF NOT EXISTS risk_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  max_open_positions integer NOT NULL DEFAULT 5,
  max_orders_per_hour integer NOT NULL DEFAULT 10,
  max_drawdown_pct numeric NOT NULL DEFAULT 3.0,
  min_position_size_pct numeric NOT NULL DEFAULT 2.0,
  max_position_size_pct numeric NOT NULL DEFAULT 5.0,
  stop_loss_pct numeric NOT NULL DEFAULT -2.0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS risk_limits_singleton_key ON risk_limits ((true));

CREATE TABLE IF NOT EXISTS kill_switch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp bigint NOT NULL,
  is_synced boolean NOT NULL,
  local_balance_usd numeric NOT NULL,
  exchange_balance_usd numeric NOT NULL,
  discrepancy_usd numeric NOT NULL,
  breakdown jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  diff jsonb,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_mode (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL DEFAULT 'PAPER',
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS system_mode_singleton_key ON system_mode ((true));

CREATE TABLE IF NOT EXISTS signal_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid REFERENCES trade_decisions(id),
  symbol text NOT NULL,
  ts bigint NOT NULL,
  source text NOT NULL,
  composite_score numeric,
  liquidity_depth_usd numeric,
  narrative_velocity numeric,
  mtf jsonb,
  imbalance numeric,
  bid_depth_1pct_usd numeric,
  ask_depth_1pct_usd numeric,
  spread_pct numeric,
  atr_1h numeric,
  entry_price numeric,
  stop_loss_pct numeric,
  take_profit_pct numeric,
  size_pct numeric,
  plan_reason text,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id uuid NOT NULL REFERENCES trade_decisions(id),
  symbol text NOT NULL,
  entry_price numeric NOT NULL,
  exit_price numeric,
  side text NOT NULL,
  pnl_pct numeric,
  r_multiple numeric,
  outcome text NOT NULL DEFAULT 'OPEN',
  bars_held integer,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- [RLS]
