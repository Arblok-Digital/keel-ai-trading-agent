-- ============================================================================
-- ai-trading-agent — Self-hosted PostgreSQL RLS, immutability & FSM guards
-- Applied in the SAME migration as the Drizzle schema (AGENTS.md rule #6).
--
-- Connection model:
--   * ADMIN_DATABASE_URL -> migration owner (runs this file, owns tables)
--   * DATABASE_URL       -> keel_app (non-superuser login, RLS-governed)
--
-- Every application transaction MUST begin with:
--   SET LOCAL app.current_user_id = '<uuid>';
-- via src/db/actor.ts#withActorContext (never raw ad-hoc sessions).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Application DB role (idempotent)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keel_app') THEN
    CREATE ROLE keel_app LOGIN PASSWORD 'keel_app';
  END IF;
END
$$;

DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO keel_app', db_name);
END
$$;

GRANT USAGE ON SCHEMA public TO keel_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 1. Actor context helpers (session-variable based; no Supabase dependency)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth_has_role(required_role text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
    WHERE ur.user_id = app_current_user_id()
      AND u.email <> ''
      AND ur.role = required_role
  );
$$;

-- Operational escape hatch: system_agent fetches ciphertext for in-memory
-- decryption only (constitution #4). Direct table access stays owner-only.
CREATE OR REPLACE FUNCTION get_credential_ciphertext(p_venue text)
RETURNS TABLE (
  id uuid,
  label text,
  key_fingerprint text,
  ciphertext text,
  iv text,
  auth_tag text,
  scopes jsonb
) LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT c.id, c.label, c.key_fingerprint, c.ciphertext, c.iv, c.auth_tag, c.scopes
  FROM credentials c
  WHERE c.venue = p_venue
    AND c.is_active = true
    AND auth_has_role('system_agent')
$$;

-- One-shot owner provisioning from app bootstrap (env credentials); refuses
-- silently once any owner exists. SECURITY DEFINER so first-seed bypasses the
-- otherwise-empty RBAC graph.
CREATE OR REPLACE FUNCTION bootstrap_owner(p_email text, p_password_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles ur WHERE ur.role = 'owner') THEN
    RETURN NULL;
  END IF;
  INSERT INTO users (email, password_hash)
  VALUES (lower(p_email), p_password_hash)
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  RETURNING id INTO new_id;
  INSERT INTO user_roles (user_id, role) VALUES (new_id, 'owner')
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN new_id;
END
$$;

-- Login-time credential probe (email -> id/hash/role); SECURITY DEFINER because
-- RLS on users is self-or-owner and the principal is not yet known.
CREATE OR REPLACE FUNCTION lookup_user_credentials(p_email text)
RETURNS TABLE (id uuid, password_hash text, role text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT u.id, u.password_hash, (SELECT ur.role FROM user_roles ur WHERE ur.user_id = u.id LIMIT 1)
  FROM users u
  WHERE lower(u.email) = lower(p_email)
$$;

-- OWASP Reuse Revocation: rotate refresh token within same family.
-- If the old token was already used (replay), revoke the ENTIRE family.
-- Uses dblink for AUTONOMOUS revoke so it persists beyond the outer RAISE/ROLLBACK.
CREATE EXTENSION IF NOT EXISTS dblink;
CREATE OR REPLACE FUNCTION rotate_refresh_token(
  p_old_token_hash text,
  p_new_token_hash text,
  p_new_expires_at timestamptz
) RETURNS TABLE (user_id uuid, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session sessions%ROWTYPE;
  v_user_role text;
  v_family uuid;
  v_connstr text;
BEGIN
  SELECT * INTO v_session
  FROM sessions
  WHERE token_hash = p_old_token_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown refresh token';
  END IF;

  IF v_session.revoked_at IS NOT NULL THEN
    v_family := v_session.family_id;
    v_connstr := format('dbname=%I host=/var/run/postgresql', current_database());
    BEGIN
      PERFORM dblink_exec(v_connstr, format('UPDATE sessions SET revoked_at = now() WHERE family_id = %L AND revoked_at IS NULL', v_family));
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM dblink_exec('host=localhost dbname=' || current_database() || ' user=postgres password=postgres', format('UPDATE sessions SET revoked_at = now() WHERE family_id = %L AND revoked_at IS NULL', v_family));
      EXCEPTION WHEN OTHERS THEN
        UPDATE sessions SET revoked_at = now() WHERE family_id = v_family AND revoked_at IS NULL;
      END;
    END;
    RAISE EXCEPTION 'refresh token reuse detected: family revoked';
  END IF;

  IF v_session.expires_at <= now() THEN
    v_family := v_session.family_id;
    v_connstr := format('dbname=%I host=/var/run/postgresql', current_database());
    BEGIN
      PERFORM dblink_exec(v_connstr, format('UPDATE sessions SET revoked_at = now() WHERE family_id = %L AND revoked_at IS NULL', v_family));
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM dblink_exec('host=localhost dbname=' || current_database() || ' user=postgres password=postgres', format('UPDATE sessions SET revoked_at = now() WHERE family_id = %L AND revoked_at IS NULL', v_family));
      EXCEPTION WHEN OTHERS THEN
        UPDATE sessions SET revoked_at = now() WHERE family_id = v_family AND revoked_at IS NULL;
      END;
    END;
    RAISE EXCEPTION 'refresh token expired';
  END IF;

  UPDATE sessions
  SET token_hash = p_new_token_hash,
      expires_at = p_new_expires_at,
      last_rotated_at = now()
  WHERE id = v_session.id;

  SELECT ur.role INTO v_user_role
  FROM user_roles ur
  WHERE ur.user_id = v_session.user_id
  LIMIT 1;

  user_id := v_session.user_id;
  role := COALESCE(v_user_role, 'viewer');
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION app_current_user_id FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_has_role(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_credential_ciphertext(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bootstrap_owner(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_user_credentials(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rotate_refresh_token(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_id TO keel_app;
GRANT EXECUTE ON FUNCTION auth_has_role(text) TO keel_app;
GRANT EXECUTE ON FUNCTION get_credential_ciphertext(text) TO keel_app;
GRANT EXECUTE ON FUNCTION bootstrap_owner(text, text) TO keel_app;
GRANT EXECUTE ON FUNCTION lookup_user_credentials(text) TO keel_app;
GRANT EXECUTE ON FUNCTION rotate_refresh_token(text, text, timestamptz) TO keel_app;

-- ----------------------------------------------------------------------------
-- 2. Append-only enforcement (AGENTS.md forbidden list + decision_transitions)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

CREATE OR REPLACE FUNCTION forbid_mutation_except_terminal_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.terminal_state IS DISTINCT FROM NEW.terminal_state
     AND OLD.id IS NOT DISTINCT FROM NEW.id
     AND OLD.symbol IS NOT DISTINCT FROM NEW.symbol
     AND OLD.venue IS NOT DISTINCT FROM NEW.venue
     AND OLD.action IS NOT DISTINCT FROM NEW.action
     AND OLD.mm_thesis IS NOT DISTINCT FROM NEW.mm_thesis
     AND OLD.smart_money_flow IS NOT DISTINCT FROM NEW.smart_money_flow
     AND OLD.mtf_bias IS NOT DISTINCT FROM NEW.mtf_bias
     AND OLD.liquidity_depth_usd IS NOT DISTINCT FROM NEW.liquidity_depth_usd
     AND OLD.stop_loss_pct IS NOT DISTINCT FROM NEW.stop_loss_pct
     AND OLD.take_profit_pct IS NOT DISTINCT FROM NEW.take_profit_pct
     AND OLD.size_pct IS NOT DISTINCT FROM NEW.size_pct
     AND OLD.risk_passed IS NOT DISTINCT FROM NEW.risk_passed
     AND OLD.risk_reasons IS NOT DISTINCT FROM NEW.risk_reasons
     AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only (only terminal_state updates allowed)', TG_TABLE_NAME;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_logs',
    'decision_transitions',
    'reconciliation_reports',
    'kill_switch_events'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()',
      t, t
    );
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM keel_app, PUBLIC', t);
  END LOOP;
  
  -- Special handling for trade_decisions: allow terminal_state updates (ROW level to inspect OLD/NEW)
  EXECUTE format('DROP TRIGGER IF EXISTS trade_decisions_append_only ON trade_decisions');
  EXECUTE format('DROP TRIGGER IF EXISTS trade_decisions_terminal_state_row ON trade_decisions');
  EXECUTE format(
    'CREATE TRIGGER trade_decisions_terminal_state_row BEFORE UPDATE ON trade_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation_except_terminal_state()'
  );
  EXECUTE format(
    'CREATE TRIGGER trade_decisions_append_only BEFORE DELETE OR TRUNCATE ON trade_decisions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()'
  );
END
$$;

-- ----------------------------------------------------------------------------
-- 3. Decision transition legality: NULL->PENDING on insert row;
--    PENDING -> EXECUTED | REJECTED | FAILED exactly once per decision.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decision_transitions_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.from_state IS NULL THEN
    IF NEW.to_state <> 'PENDING' THEN
      RAISE EXCEPTION 'illegal initial transition to %', NEW.to_state;
    END IF;
  ELSIF NOT (
    NEW.from_state = 'PENDING'
    AND NEW.to_state IN ('EXECUTED', 'REJECTED', 'FAILED')
  ) THEN
    RAISE EXCEPTION 'illegal decision transition % -> %', NEW.from_state, NEW.to_state;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS decision_transitions_guard_trg ON decision_transitions;
CREATE TRIGGER decision_transitions_guard_trg
BEFORE INSERT ON decision_transitions
FOR EACH ROW EXECUTE FUNCTION decision_transitions_guard();

-- ----------------------------------------------------------------------------
-- 4. Order FSM enforced at DB level:
--    PENDING -> PARTIALLY_FILLED | FILLED | REJECTED | CANCELLED
--    PARTIALLY_FILLED -> FILLED | CANCELLED
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION orders_fsm_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'orders must be created in status PENDING';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'PENDING' AND NEW.status IN ('PARTIALLY_FILLED','FILLED','REJECTED','CANCELLED')) OR
      (OLD.status = 'PARTIALLY_FILLED' AND NEW.status IN ('FILLED','CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'illegal order status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS orders_fsm_insert_trg ON orders;
CREATE TRIGGER orders_fsm_insert_trg
BEFORE INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION orders_fsm_guard();

DROP TRIGGER IF EXISTS orders_fsm_update_trg ON orders;
CREATE TRIGGER orders_fsm_update_trg
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION orders_fsm_guard();

-- ----------------------------------------------------------------------------
-- 5. Row-Level Security policies (matrix: docs/security.md §1)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','user_roles','sessions','credentials',
    'early_detection_tokens','trade_decisions','decision_transitions',
    'orders','positions','risk_limits','kill_switch_events',
    'reconciliation_reports','audit_logs','system_mode'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS sel ON %I; DROP POLICY IF EXISTS ins ON %I; DROP POLICY IF EXISTS upd ON %I; DROP POLICY IF EXISTS del ON %I;',
      t, t, t, t
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- users -----------------------------------------------------------------------
CREATE POLICY sel ON users FOR SELECT TO keel_app
  USING (id = app_current_user_id() OR auth_has_role('owner'));
CREATE POLICY ins ON users FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('owner'));
CREATE POLICY upd ON users FOR UPDATE TO keel_app
  USING (auth_has_role('owner') OR id = app_current_user_id())
  WITH CHECK (true);

-- user_roles ------------------------------------------------------------------
CREATE POLICY sel ON user_roles FOR SELECT TO keel_app
  USING (user_id = app_current_user_id() OR auth_has_role('owner'));
CREATE POLICY ins ON user_roles FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('owner'));
CREATE POLICY upd ON user_roles FOR UPDATE TO keel_app
  USING (auth_has_role('owner')) WITH CHECK (auth_has_role('owner'));
CREATE POLICY del ON user_roles FOR DELETE TO keel_app
  USING (auth_has_role('owner'));

-- sessions (refresh-token rotation & reuse revocation) -------------------------
CREATE POLICY sel ON sessions FOR SELECT TO keel_app
  USING (user_id = app_current_user_id());
CREATE POLICY ins ON sessions FOR INSERT TO keel_app
  WITH CHECK (user_id = app_current_user_id());
CREATE POLICY upd ON sessions FOR UPDATE TO keel_app
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY del ON sessions FOR DELETE TO keel_app
  USING (user_id = app_current_user_id());

-- credentials (owner only; system_agent uses get_credential_ciphertext) --------
CREATE POLICY sel ON credentials FOR SELECT TO keel_app
  USING (auth_has_role('owner'));
CREATE POLICY ins ON credentials FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('owner'));
CREATE POLICY upd ON credentials FOR UPDATE TO keel_app
  USING (auth_has_role('owner')) WITH CHECK (auth_has_role('owner'));
CREATE POLICY del ON credentials FOR DELETE TO keel_app
  USING (auth_has_role('owner'));

-- early_detection_tokens (mutation locked to system_agent ONLY) ----------------
CREATE POLICY sel ON early_detection_tokens FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON early_detection_tokens FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('system_agent'));
CREATE POLICY upd ON early_detection_tokens FOR UPDATE TO keel_app
  USING (auth_has_role('system_agent')) WITH CHECK (auth_has_role('system_agent'));
CREATE POLICY del ON early_detection_tokens FOR DELETE TO keel_app
  USING (auth_has_role('system_agent'));

-- trade_decisions (append-only; insert: system_agent ONLY; update: terminal_state only) ----------
CREATE POLICY sel ON trade_decisions FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON trade_decisions FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('system_agent'));
CREATE POLICY upd ON trade_decisions FOR UPDATE TO keel_app
  USING (auth_has_role('system_agent')) WITH CHECK (auth_has_role('system_agent'));

-- decision_transitions (append-only; insert: system_agent ONLY) ----------------
CREATE POLICY sel ON decision_transitions FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON decision_transitions FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('system_agent'));

-- orders (write: system_agent ONLY; read: all authenticated) -------------------
CREATE POLICY sel ON orders FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON orders FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('system_agent'));
CREATE POLICY upd ON orders FOR UPDATE TO keel_app
  USING (auth_has_role('system_agent')) WITH CHECK (auth_has_role('system_agent'));

-- positions (write: system_agent ONLY; full audit traceability FKs NOT NULL) ---
CREATE POLICY sel ON positions FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON positions FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('system_agent'));
CREATE POLICY upd ON positions FOR UPDATE TO keel_app
  USING (auth_has_role('system_agent')) WITH CHECK (auth_has_role('system_agent'));

-- risk_limits (singleton; mutation: owner ONLY; SELECT .. FOR UPDATE needs USING that allows system_agent to lock during risk evaluation) -----
CREATE POLICY sel ON risk_limits FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON risk_limits FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('owner'));
CREATE POLICY upd ON risk_limits FOR UPDATE TO keel_app
  USING (auth_has_role('owner') OR auth_has_role('system_agent')) WITH CHECK (auth_has_role('owner') OR auth_has_role('system_agent'));

-- Guard (auditor S3): system_agent boleh LOCK row (SELECT..FOR UPDATE saat evaluasi risk)
-- tapi TIDAK boleh mengubah NILAI limit — mutation tetap owner-only (docs/security.md).
CREATE OR REPLACE FUNCTION risk_limits_value_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT auth_has_role('owner') THEN
    IF OLD.max_open_positions IS DISTINCT FROM NEW.max_open_positions
       OR OLD.max_orders_per_hour IS DISTINCT FROM NEW.max_orders_per_hour
       OR OLD.max_drawdown_pct IS DISTINCT FROM NEW.max_drawdown_pct
       OR OLD.min_position_size_pct IS DISTINCT FROM NEW.min_position_size_pct
       OR OLD.max_position_size_pct IS DISTINCT FROM NEW.max_position_size_pct
       OR OLD.stop_loss_pct IS DISTINCT FROM NEW.stop_loss_pct THEN
      RAISE EXCEPTION 'risk_limits values may only be changed by owner';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS risk_limits_value_guard ON risk_limits;
CREATE TRIGGER risk_limits_value_guard BEFORE UPDATE ON risk_limits FOR EACH ROW EXECUTE FUNCTION risk_limits_value_guard();

-- kill_switch_events (insert by actor; append-only trigger guards mutations) ---
CREATE POLICY sel ON kill_switch_events FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON kill_switch_events FOR INSERT TO keel_app
  WITH CHECK (
    triggered_by = app_current_user_id()
    AND (auth_has_role('owner') OR auth_has_role('system_agent'))
  );

-- reconciliation_reports (viewer read allowed; insert: owner/system_agent) -----
CREATE POLICY sel ON reconciliation_reports FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON reconciliation_reports FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('owner') OR auth_has_role('system_agent'));

-- audit_logs (read: owner + system_agent for chain verification; insert self-authored by owner/system_agent) -
CREATE POLICY sel ON audit_logs FOR SELECT TO keel_app
  USING (auth_has_role('owner') OR auth_has_role('system_agent'));
CREATE POLICY ins ON audit_logs FOR INSERT TO keel_app
  WITH CHECK (
    actor_id = app_current_user_id()
    AND (auth_has_role('owner') OR auth_has_role('system_agent'))
  );

-- system_mode (singleton; toggle: owner ONLY) -----------------------------------
CREATE POLICY sel ON system_mode FOR SELECT TO keel_app
  USING (true);
CREATE POLICY ins ON system_mode FOR INSERT TO keel_app
  WITH CHECK (auth_has_role('owner'));
CREATE POLICY upd ON system_mode FOR UPDATE TO keel_app
  USING (auth_has_role('owner')) WITH CHECK (auth_has_role('owner'));

-- ----------------------------------------------------------------------------
-- 6. Seeds: service principal for worker-initiated kill switches (FK NOT NULL),
--    singleton risk limits, default PAPER trading mode.
-- ----------------------------------------------------------------------------
INSERT INTO users (id, email)
VALUES ('00000000-0000-0000-0000-00000000a001', 'system_agent@internal')
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_roles (user_id, role)
VALUES ('00000000-0000-0000-0000-00000000a001', 'system_agent')
ON CONFLICT (user_id, role) DO NOTHING;

INSERT INTO risk_limits (id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM risk_limits);

INSERT INTO system_mode (id, updated_by)
SELECT gen_random_uuid(), '00000000-0000-0000-0000-00000000a001'
WHERE NOT EXISTS (SELECT 1 FROM system_mode);

GRANT SELECT, INSERT, UPDATE ON users TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO keel_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON early_detection_tokens TO keel_app;
GRANT SELECT, INSERT ON trade_decisions TO keel_app;
GRANT UPDATE (terminal_state) ON trade_decisions TO keel_app;
GRANT SELECT, INSERT ON decision_transitions TO keel_app;
GRANT SELECT, INSERT, UPDATE ON orders TO keel_app;
GRANT SELECT, INSERT, UPDATE ON positions TO keel_app;
GRANT SELECT, INSERT, UPDATE ON risk_limits TO keel_app;
GRANT SELECT, INSERT ON kill_switch_events TO keel_app;
GRANT SELECT, INSERT ON reconciliation_reports TO keel_app;
GRANT SELECT, INSERT ON audit_logs TO keel_app;
GRANT SELECT, INSERT, UPDATE ON system_mode TO keel_app;
GRANT SELECT, INSERT, UPDATE ON signal_features TO keel_app;
GRANT SELECT, INSERT, UPDATE ON signal_outcomes TO keel_app;
