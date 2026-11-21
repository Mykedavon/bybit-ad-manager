// src/managers/replenishment.js
// Reads completed sell orders, maintains the uncounted pool,
// and fires 50-USDC increments. This is the quantity side of the bot.
// Price is handled by buyManager.js — this file only decides WHEN
// quantities should increase, not at what price.

const db = require('../db/db');
const config = require('../config');
const { processCompletedSells } = require('../bybit/orders');

// ── Sync ledger: fetch new completed sells into DB ──────────
// Returns array of newly added orders (not yet counted).
async function syncCompletedSells() {
  const newOrders = await processCompletedSells();
  return newOrders;
}

// ── Update the uncounted pool ───────────────────────────────
// Adds all uncounted completed sales to the pool, then marks them counted.
// Called every 5-minute cycle before increment evaluation.
function fillPoolFromLedger() {
  const uncounted = db.completedSells.uncounted();

  if (uncounted.length === 0) return 0;

  let totalAdded = 0;
  for (const order of uncounted) {
    db.pool.add(order.usdc_amount);
    db.completedSells.markCounted(order.order_id);
    totalAdded += order.usdc_amount;
  }

  return totalAdded;
}

// ── Evaluate and fire increments ────────────────────────────
// Checks whether pool_usdc >= threshold. For every full threshold,
// creates one increment record and subtracts threshold from pool.
// Returns array of newly created increment IDs.
function evaluateIncrements() {
  const pool = db.pool.get();
  const threshold = config.replenish.thresholdUsdc;

  const incrementsCreated = [];
  let remaining = pool.pool_usdc;

  while (remaining >= threshold) {
    const incrementId = db.increments.create({
      usdtStep: config.replenish.usdtStep,
      usdcSmallStep: config.replenish.usdcSmallStep,
      usdcLargeStep: config.replenish.usdcLargeStep,
      status: 'pending',
      gateReason: null,
      expiresAt: null,
    });

    incrementsCreated.push(incrementId);
    remaining -= threshold;
  }

  // Persist the reduced pool (remaining holds any partial amount)
  if (incrementsCreated.length > 0) {
    db.pool.set(remaining);
  }

  return incrementsCreated;
}

// ── Main cycle entry point ──────────────────────────────────
// Called by scheduler every 5 minutes.
// 1. Fetch new completed sells from Bybit
// 2. Add uncounted sales to pool
// 3. Fire increments if pool crosses threshold
// Returns summary for logging.
async function runReplenishmentCycle() {
  const newOrders = await syncCompletedSells();
  const addedToPool = fillPoolFromLedger();
  const newIncrements = evaluateIncrements();

  return {
    newOrdersCount: newOrders.length,
    usdcAddedToPool: addedToPool,
    incrementsFired: newIncrements.length,
    incrementIds: newIncrements,
    poolRemaining: db.pool.get().pool_usdc,
  };
}

// ── Resolve an increment (posted, confirmed, or expired) ────
function resolveIncrement(incrementId, status) {
  db.increments.resolve(incrementId, status);
}

// ── Get pending increments for buyManager to process ────────
function getPendingIncrements() {
  return db.increments.pending();
}

// ── Expire stale increments ─────────────────────────────────
// Called by scheduler. Finds pending increments past expires_at
// and resolves them as expired. The sales that triggered them
// have already been removed from the pool — they do NOT return.
// Per owner's decision: expire-and-replace means the NEXT cycle
// creates a fresh increment from fresh sales, not from the expired one.
function expireStaleIncrements() {
  const stale = db.increments.expiredPending();
  for (const inc of stale) {
    db.increments.resolve(inc.id, 'expired');
  }
  return stale.length;
}

module.exports = {
  syncCompletedSells,
  fillPoolFromLedger,
  evaluateIncrements,
  runReplenishmentCycle,
  resolveIncrement,
  getPendingIncrements,
  expireStaleIncrements,
};