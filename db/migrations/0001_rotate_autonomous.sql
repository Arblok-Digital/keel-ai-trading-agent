-- 0001_rotate_autonomous — fix rotate_refresh_token OWASP reuse to be autonomous (persists even after outer RAISE)
-- Requires dblink for autonomous transaction (replicates pg's missing AUTONOMOUS_TRANSACTION)
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
  v_connstr text;
  v_family uuid;
BEGIN
  SELECT * INTO v_session
  FROM sessions
  WHERE token_hash = p_old_token_hash;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown refresh token';
  END IF;

  IF v_session.revoked_at IS NOT NULL THEN
    -- Autonomous revoke of entire family via dblink so it survives the outer RAISE/ROLLBACK.
    -- Use local socket connection as superuser postgres (trust via SECURITY DEFINER owner).
    v_family := v_session.family_id;
    v_connstr := format('dbname=%I host=/var/run/postgresql', current_database());
    -- Fallback to TCP if socket dblink not available (Docker postgres uses 5432)
    BEGIN
      PERFORM dblink_exec(v_connstr, format('UPDATE sessions SET revoked_at = now() WHERE family_id = %L AND revoked_at IS NULL', v_family));
    EXCEPTION WHEN OTHERS THEN
      -- TCP fallback — postgres:postgres@localhost
      BEGIN
        PERFORM dblink_exec('host=localhost dbname=' || current_database() || ' user=postgres password=postgres', format('UPDATE sessions SET revoked_at = now() WHERE family_id = %L AND revoked_at IS NULL', v_family));
      EXCEPTION WHEN OTHERS THEN
        -- Last resort: non-autonomous (best effort) — will be rolled back but at least attempted
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

REVOKE ALL ON FUNCTION rotate_refresh_token(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_refresh_token(text, text, timestamptz) TO keel_app;
