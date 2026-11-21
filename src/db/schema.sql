-- src/db/schema.sql
-- SQLite schema. All state that must survive restarts lives here.

-- ── Ad registry ─────────────────────────────────────────────
-- Maps role (usdt_buy, usdc_small_buy, usdc_large_buy, usdc_sell) to Bybit ad_id.
-- Refreshed on every startup so recreated ads are picked up automatically.
CREATE TABLE IF NOT EXISTS ads (
  role        TEXT PRIMARY KEY,          -- 'usdt_buy' | 'usdc_small_buy' | 'usdc_large_buy' | 'usdc_sell'
  ad_id       TEXT NOT NULL,
  token       TEXT NOT NULL,
  side        INTEGER NOT NULL,          -- 0 = buy, 1 = sell
  last_price  REAL,
  last_qty    REAL,
  updated_at  INTEGER NOT NULL
);

-- ── Completed sell orders ledger ────────────────────────────
-- One row per completed USDC sell order. order_id is the dedupe key.
-- Presence here = already counted toward replenishment.
CREATE TABLE IF NOT EXISTS completed_sell_orders (
  order_id    TEXT PRIMARY KEY,
  usdc_amount REAL NOT NULL,
  price_ngn   REAL NOT NULL,
  fee_ngn     REAL NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL,
  counted_at  INTEGER                    -- when it was applied to replenishment pool
);

-- ── Replenishment pool ──────────────────────────────────────
-- Single-row table. 'pool_usdc' = sum of completed sales not yet converted into increments.
-- Every time pool_usdc crosses 50, one increment fires and pool_usdc drops by 50.
CREATE TABLE IF NOT EXISTS replenish_pool (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  pool_usdc   REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO replenish_pool (id, pool_usdc, updated_at) VALUES (1, 0, 0);

-- ── Replenishment increments ────────────────────────────────
-- One row per 50-USDC increment. Tracks whether it was posted, gated, expired.
CREATE TABLE IF NOT EXISTS replenish_increments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,
  usdt_step     REAL NOT NULL,
  usdc_small_step REAL NOT NULL,
  usdc_large_step REAL NOT NULL,
  status        TEXT NOT NULL,           -- 'pending' | 'posted' | 'expired' | 'confirmed'
  gate_reason   TEXT,                    -- null | 'price_gate'
  telegram_msg_id INTEGER,               -- id of the Confirm message, if gated
  expires_at    INTEGER,
  resolved_at   INTEGER
);

-- ── Buy history ─────────────────────────────────────────────
-- Every completed USDC buy. Used to compute weighted avg (floor price).
CREATE TABLE IF NOT EXISTS completed_buy_orders (
  order_id     TEXT PRIMARY KEY,
  usdc_amount  REAL NOT NULL,
  ngn_spent    REAL NOT NULL,            -- total NGN paid
  fee_ngn      REAL NOT NULL DEFAULT 0,  -- fee charged in NGN (added to numerator)
  fee_usdc     REAL NOT NULL DEFAULT 0,  -- fee deducted from USDC (already in denominator)
  price_ngn    REAL NOT NULL,            -- effective price per USDC incl. fees
  completed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buy_completed ON completed_buy_orders(completed_at DESC);

-- ── Price gate offers ───────────────────────────────────────
-- When a buy edit is gated, we store the intended edit here so Confirm knows what to post.
CREATE TABLE IF NOT EXISTS price_gate_offers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL,           -- usdt_buy | usdc_small_buy | usdc_large_buy
  intended_price REAL NOT NULL,
  intended_qty  REAL NOT NULL,
  market_avg_price REAL NOT NULL,
  last_buy_price REAL NOT NULL,
  telegram_msg_id INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'  -- pending | confirmed | expired
);

-- ── Manual override ─────────────────────────────────────────
-- Two rows: 'buy' (covers all three buy ads) and 'sell' (covers the one sell ad).
CREATE TABLE IF NOT EXISTS override_state (
  scope       TEXT PRIMARY KEY,          -- 'buy' | 'sell'
  manual      INTEGER NOT NULL DEFAULT 0, -- 0 = auto, 1 = manual (price locked)
  updated_at  INTEGER NOT NULL
);
INSERT OR IGNORE INTO override_state (scope, manual, updated_at) VALUES ('buy', 0, 0);
INSERT OR IGNORE INTO override_state (scope, manual, updated_at) VALUES ('sell', 0, 0);

-- ── Ad edit throttle ────────────────────────────────────────
-- Tracks edit timestamps per ad so we never breach Bybit's 10-edits/5min limit.
CREATE TABLE IF NOT EXISTS ad_edit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,
  edited_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_log ON ad_edit_log(role, edited_at DESC);

-- ── Chat message log ────────────────────────────────────────
-- Prevents sending the "I'm online" and reminder messages more than once per order.
CREATE TABLE IF NOT EXISTS chat_message_log (
  order_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,              -- 'sell_online' | 'buy_reminder'
  sent_at    INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, kind)
);

-- ── Emergency stop flag ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO system_flags (key, value) VALUES ('emergency_stop', 'false');

-- ── Balance reconciliation log ──────────────────────────────
CREATE TABLE IF NOT EXISTS reconcile_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at  INTEGER NOT NULL,
  token       TEXT NOT NULL,
  expected    REAL NOT NULL,
  actual      REAL NOT NULL,
  diff        REAL NOT NULL,
  ok          INTEGER NOT NULL
);