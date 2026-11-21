// src/db/db.js
// SQLite connection + typed query helpers for every table.
// Opens (or creates) C:\David\data\bot.db, runs schema.sql on first run.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'bot.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schemaSql);

// ── Helpers ──────────────────────────────────────────────────
const now = () => Date.now();

// ── Ads registry ────────────────────────────────────────────
const ads = {
  upsert(role, adId, token, side, price, qty) {
    db.prepare(`
      INSERT INTO ads (role, ad_id, token, side, last_price, last_qty, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET
        ad_id = excluded.ad_id,
        token = excluded.token,
        side = excluded.side,
        last_price = excluded.last_price,
        last_qty = excluded.last_qty,
        updated_at = excluded.updated_at
    `).run(role, adId, token, side, price, qty, now());
  },
  get(role) {
    return db.prepare('SELECT * FROM ads WHERE role = ?').get(role);
  },
  all() {
    return db.prepare('SELECT * FROM ads').all();
  },
  updateState(role, price, qty) {
    db.prepare('UPDATE ads SET last_price = ?, last_qty = ?, updated_at = ? WHERE role = ?')
      .run(price, qty, now(), role);
  },
};

// ── Completed sell orders (replenishment ledger) ────────────
const completedSells = {
  add({ orderId, usdcAmount, priceNgn, feeNgn, completedAt }) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO completed_sell_orders
        (order_id, usdc_amount, price_ngn, fee_ngn, completed_at, counted_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `);
    const info = stmt.run(orderId, usdcAmount, priceNgn, feeNgn, completedAt);
    return info.changes > 0; // true if it was new
  },
  markCounted(orderId) {
    db.prepare('UPDATE completed_sell_orders SET counted_at = ? WHERE order_id = ?')
      .run(now(), orderId);
  },
  uncounted() {
    return db.prepare('SELECT * FROM completed_sell_orders WHERE counted_at IS NULL').all();
  },
  exists(orderId) {
    return !!db.prepare('SELECT 1 FROM completed_sell_orders WHERE order_id = ?').get(orderId);
  },
};

// ── Replenishment pool ──────────────────────────────────────
const pool = {
  get() {
    return db.prepare('SELECT * FROM replenish_pool WHERE id = 1').get();
  },
  set(usdcAmount) {
    db.prepare('UPDATE replenish_pool SET pool_usdc = ?, updated_at = ? WHERE id = 1')
      .run(usdcAmount, now());
  },
  add(usdcAmount) {
    db.prepare('UPDATE replenish_pool SET pool_usdc = pool_usdc + ?, updated_at = ? WHERE id = 1')
      .run(usdcAmount, now());
  },
  subtract(usdcAmount) {
    db.prepare('UPDATE replenish_pool SET pool_usdc = MAX(0, pool_usdc - ?), updated_at = ? WHERE id = 1')
      .run(usdcAmount, now());
  },
};

// ── Replenishment increments ────────────────────────────────
const increments = {
  create({ usdtStep, usdcSmallStep, usdcLargeStep, status, gateReason, expiresAt }) {
    const info = db.prepare(`
      INSERT INTO replenish_increments
        (created_at, usdt_step, usdc_small_step, usdc_large_step, status, gate_reason, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(now(), usdtStep, usdcSmallStep, usdcLargeStep, status, gateReason, expiresAt);
    return info.lastInsertRowid;
  },
  setTelegramMsg(id, msgId) {
    db.prepare('UPDATE replenish_increments SET telegram_msg_id = ? WHERE id = ?').run(msgId, id);
  },
  resolve(id, status) {
    db.prepare('UPDATE replenish_increments SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, now(), id);
  },
  pending() {
    return db.prepare("SELECT * FROM replenish_increments WHERE status = 'pending'").all();
  },
  expiredPending() {
    return db.prepare("SELECT * FROM replenish_increments WHERE status = 'pending' AND expires_at < ?")
      .all(now());
  },
};

// ── Completed buy orders (weighted avg source) ──────────────
const completedBuys = {
  add({ orderId, usdcAmount, ngnSpent, feeNgn, feeUsdc, priceNgn, completedAt }) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO completed_buy_orders
        (order_id, usdc_amount, ngn_spent, fee_ngn, fee_usdc, price_ngn, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(orderId, usdcAmount, ngnSpent, feeNgn, feeUsdc, priceNgn, completedAt);
    return info.changes > 0;
  },
  lastN(n) {
    return db.prepare('SELECT * FROM completed_buy_orders ORDER BY completed_at DESC LIMIT ?').all(n);
  },
  latest() {
    return db.prepare('SELECT * FROM completed_buy_orders ORDER BY completed_at DESC LIMIT 1').get();
  },
};

// ── Price gate offers ───────────────────────────────────────
const gateOffers = {
  create({ role, intendedPrice, intendedQty, marketAvgPrice, lastBuyPrice, expiresAt }) {
    const info = db.prepare(`
      INSERT INTO price_gate_offers
        (role, intended_price, intended_qty, market_avg_price, last_buy_price, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(role, intendedPrice, intendedQty, marketAvgPrice, lastBuyPrice, now(), expiresAt);
    return info.lastInsertRowid;
  },
  setTelegramMsg(id, msgId) {
    db.prepare('UPDATE price_gate_offers SET telegram_msg_id = ? WHERE id = ?').run(msgId, id);
  },
  resolve(id, status) {
    db.prepare('UPDATE price_gate_offers SET status = ? WHERE id = ?').run(status, id);
  },
  get(id) {
    return db.prepare('SELECT * FROM price_gate_offers WHERE id = ?').get(id);
  },
  expiredPending() {
    return db.prepare("SELECT * FROM price_gate_offers WHERE status = 'pending' AND expires_at < ?")
      .all(now());
  },
};

// ── Override state ──────────────────────────────────────────
const override = {
  get(scope) {
    const row = db.prepare('SELECT * FROM override_state WHERE scope = ?').get(scope);
    return row ? row.manual === 1 : false;
  },
  set(scope, manual) {
    db.prepare('UPDATE override_state SET manual = ?, updated_at = ? WHERE scope = ?')
      .run(manual ? 1 : 0, now(), scope);
  },
};

// ── Ad edit throttle log ────────────────────────────────────
const editLog = {
  record(role) {
    db.prepare('INSERT INTO ad_edit_log (role, edited_at) VALUES (?, ?)').run(role, now());
  },
  countInLastWindow(role, windowMs) {
    return db.prepare('SELECT COUNT(*) as c FROM ad_edit_log WHERE role = ? AND edited_at > ?')
      .get(role, now() - windowMs).c;
  },
  lastEditAt(role) {
    const row = db.prepare('SELECT edited_at FROM ad_edit_log WHERE role = ? ORDER BY edited_at DESC LIMIT 1').get(role);
    return row ? row.edited_at : 0;
  },
};

// ── Chat message log ────────────────────────────────────────
const chatLog = {
  get(orderId, kind) {
    return db.prepare('SELECT * FROM chat_message_log WHERE order_id = ? AND kind = ?').get(orderId, kind);
  },
  record(orderId, kind) {
    const existing = chatLog.get(orderId, kind);
    if (existing) {
      db.prepare('UPDATE chat_message_log SET count = count + 1, sent_at = ? WHERE order_id = ? AND kind = ?')
        .run(now(), orderId, kind);
    } else {
      db.prepare('INSERT INTO chat_message_log (order_id, kind, sent_at, count) VALUES (?, ?, ?, 1)')
        .run(orderId, kind, now());
    }
  },
};

// ── System flags ────────────────────────────────────────────
const flags = {
  get(key) {
    const row = db.prepare('SELECT value FROM system_flags WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db.prepare(`
      INSERT INTO system_flags (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  },
};

// ── Reconciliation log ──────────────────────────────────────
const reconcile = {
  record({ token, expected, actual, diff, ok }) {
    db.prepare(`
      INSERT INTO reconcile_log (checked_at, token, expected, actual, diff, ok)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(now(), token, expected, actual, diff, ok ? 1 : 0);
  },
  recent(n = 20) {
    return db.prepare('SELECT * FROM reconcile_log ORDER BY checked_at DESC LIMIT ?').all(n);
  },
};

module.exports = {
  db,
  ads,
  completedSells,
  pool,
  increments,
  completedBuys,
  gateOffers,
  override,
  editLog,
  chatLog,
  flags,
  reconcile,
};