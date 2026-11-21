// src/bybit/orders.js
// Fetches P2P orders, classifies completed sales/buys, and feeds the
// replenishment ledger. Only counts an order as completed when both
// status = 50 AND the asset has actually been released.

const { client, BybitError } = require('./client');
const db = require('../db/db');
const config = require('../config');

// Order status codes from Bybit docs
const STATUS = {
  WAITING_CHAIN: 5,
  WAITING_BUYER_PAY: 10,
  WAITING_SELLER_RELEASE: 20,
  APPEALING: 30,
  CANCELLED: 40,
  FINISHED: 50,
};

// ── Fetch orders by side and status ─────────────────────────
// side: 0 = buy, 1 = sell
// Returns array of order objects.
async function fetchOrders(side, status, page = 1, size = 30) {
  const result = await client.getMyOrders({ side, status, page, size });
  return result.items || [];
}

// ── Fetch recent completed orders ───────────────────────────
// Pulls finished orders (status 50) for a given side.
// Bybit returns newest first by default.
async function fetchCompletedOrders(side, maxPages = 2) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchOrders(side, STATUS.FINISHED, page, 30);
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 30) break; // last page
  }
  return all;
}

// ── Verify a sell order actually released USDC ──────────────
// Status 50 alone is not enough per owner's A5 decision.
// We check the order detail for release confirmation signals.
// Returns true if we can confirm USDC left the account.
async function verifySellReleased(orderId) {
  const detail = await client.getOrderInfo(orderId);

  // Bybit order detail includes notifyTokenQuantity when seller
  // released crypto. If present and non-zero, release happened.
  // This field behavior must be verified live — if Bybit returns
  // it for all orders, we need a different signal.
  if (detail.notifyTokenQuantity && Number(detail.notifyTokenQuantity) > 0) {
    return true;
  }

  // Fallback: check if status is finished AND there is a release
  // timestamp or quantity field. Adjust once live API behavior is known.
  // For now, if status is 50 and notifyTokenQuantity is absent/zero,
  // we treat it as unverified and skip counting.
  return false;
}

// ── Process new completed sell orders ───────────────────────
// Fetches recent finished sell orders, filters to USDC only,
// verifies release, and adds new ones to the ledger.
// Returns array of newly added orders.
async function processCompletedSells() {
  const orders = await fetchCompletedOrders(1); // side 1 = sell
  const newOrders = [];

  for (const order of orders) {
    // Only USDC sells
    if (order.tokenId !== config.tokens.sell) continue;

    // Skip if already in ledger
    if (db.completedSells.exists(order.id)) continue;

    // Verify release (A5 decision)
    const released = await verifySellReleased(order.id);
    if (!released) {
      // Not confirmed released — skip, try again next cycle
      continue;
    }

    const usdcAmount = Number(order.amount);
    const priceNgn = Number(order.price);
    const feeNgn = Number(order.fee) || 0;
    const completedAt = Number(order.createDate) || Date.now();

    const isNew = db.completedSells.add({
      orderId: order.id,
      usdcAmount,
      priceNgn,
      feeNgn,
      completedAt,
    });

    if (isNew) {
      newOrders.push({ orderId: order.id, usdcAmount, priceNgn, feeNgn });
    }
  }

  return newOrders;
}

// ── Process new completed buy orders ────────────────────────
// Fetches finished buy orders, filters to USDC buys,
// and adds them to the buy history table for weighted average.
async function processCompletedBuys() {
  const orders = await fetchCompletedOrders(0); // side 0 = buy
  const newOrders = [];

  for (const order of orders) {
    // Only USDC buys (both small and large ads)
    if (order.tokenId !== config.tokens.buy2 && order.tokenId !== config.tokens.buy3) continue;

    // Check if already recorded
    const existing = db.completedBuys.lastN(1);
    // Simple dedupe: try insert, if changes = 0 it existed
    const usdcAmount = Number(order.amount);
    const priceNgn = Number(order.price);
    const ngnSpent = usdcAmount * priceNgn;
    const fee = Number(order.fee) || 0;

    // Fee classification: Bybit's order list returns one fee field.
    // We need to determine if it's NGN or token-denominated.
    // Per owner's decision, assume NGN fee unless proven otherwise.
    const feeNgn = fee;
    const feeUsdc = 0;

    const isNew = db.completedBuys.add({
      orderId: order.id,
      usdcAmount,
      ngnSpent,
      feeNgn,
      feeUsdc,
      priceNgn,
      completedAt: Number(order.createDate) || Date.now(),
    });

    if (isNew) {
      newOrders.push({ orderId: order.id, usdcAmount, ngnSpent, feeNgn });
    }
  }

  return newOrders;
}

// ── Compute weighted average buy price ──────────────────────
// For sell floor calculation. Per owner's correction:
// (Σ NGN spent + Σ NGN fees) ÷ Σ USDC received
// Fees deducted from USDC are already in denominator, not added again.
function weightedAvgBuyPrice(window = config.sell.avgWindow) {
  const buys = db.completedBuys.lastN(window);
  if (buys.length === 0) return null;

  let totalNgn = 0;
  let totalUsdc = 0;

  for (const b of buys) {
    totalNgn += b.ngn_spent + b.fee_ngn; // NGN fees added to numerator
    totalUsdc += b.usdc_amount - b.fee_usdc; // USDC-deducted fees reduce denominator
  }

  if (totalUsdc <= 0) return null;
  return totalNgn / totalUsdc;
}

// ── Last buy price ──────────────────────────────────────────
// Used for the price gate (P_last).
function lastBuyPrice() {
  const latest = db.completedBuys.latest();
  return latest ? latest.price_ngn : null;
}

module.exports = {
  STATUS,
  fetchOrders,
  fetchCompletedOrders,
  verifySellReleased,
  processCompletedSells,
  processCompletedBuys,
  weightedAvgBuyPrice,
  lastBuyPrice,
};