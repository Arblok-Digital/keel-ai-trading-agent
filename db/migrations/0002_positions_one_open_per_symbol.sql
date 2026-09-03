-- ============================================================================
-- 0002_positions_one_open_per_symbol.sql
-- Institutional anti-race backstop: max ONE open position per symbol.
-- catched duplicate BUY (burst/parallel manual/worker) → REJECTED at executor.
-- Applied idempotently. Partial index (is_open = true) → close position frees slot.
-- ============================================================================

-- First de-duplicate any pre-fix race leftovers (keep earliest per symbol, close rest)
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY opened_at ASC, id ASC) AS rn
  FROM positions
  WHERE is_open = true
)
UPDATE positions p
SET is_open = false,
    updated_at = now()
FROM ranked r
WHERE p.id = r.id
  AND r.rn > 1;

-- Then create the unique partial index (can now succeed on clean data)
CREATE UNIQUE INDEX IF NOT EXISTS positions_one_open_per_symbol_key
  ON positions (symbol)
  WHERE is_open = true;