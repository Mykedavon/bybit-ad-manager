// src/managers/sellManager.js
// 1-minute sell loop. Manages one USDC sell ad:
//   - price = max(cheapest_genuine_competitor - 0.05, weighted_avg_buy + 10)
//   - quantity = actual available USDC (transferBalance, excludes frozen)
//   - edit fires if price changed OR quantity changed
//   - manual override locks price only; quantity still managed
//   - respects 60-sec throttle and 10-edits/5min cap

const { client } = require('../bybit/client');
const ads = require('../bybit/ads');
const inventory = require('./inventory');
const override = require('./override');
const orders = require('../bybit/orders');
const db = require('../db/db');
const config = require('../config');
const { ROLES } = ads;

// ── Fetch cheapest genuine competitor sell ad ───────────────
// Pulls competitor sell ads for USDC/NGN, filters by quality,
// returns the lowest price among genuine advertisers.
async function fetchCheapestGenuineSellPrice() {
  const result = await client.getAdsOnline({
    token: config.tokens.sell,
    side: 1, // sell
    currencyId: 'NGN',
    limit: config.competitors.fetchLimit * 3, // fetch extra to survive filtering
  });

  const items = result.items || [];

  // Compute market average of the last N buy prices for the
  // "₦5 above average = fake" filter (owner A3 decision).
  const recentBuys = db.completedBuys.lastN(10);
  let rollingAvgBuy = null;
  if (recentBuys.length > 0) {
    const totalNgn = recentBuys.reduce((s, b) => s + b.ngn_spent + b.fee_ngn, 0);
    const totalUsdc = recentBuys.reduce((s, b) => s + b.usdc_amount - b.fee_usdc, 0);
    if (totalUsdc > 0) rollingAvgBuy = totalNgn / totalUsdc;
  }

  const genuine = items.filter((ad) => {
    // Completion rate filter
    const completionRate = Number(ad.completionRate) || 0;
    if (completionRate < config.competitors.minCompletionRate) return false;

    // 30-day order count filter
    const recentOrders = Number(ad.recentOrders) || 0;
    if (recentOrders < config.competitors.minOrders30d) return false;

    // Price anomaly filter: if price is more than ₦5 above rolling avg buy,
    // treat as fake (owner A3: "5N above the average 10 buy is fake")
    if (rollingAvgBuy !== null) {
      const price = Number(ad.price);
      if (price > rollingAvgBuy + config.competitors.maxPremiumNgn) return false;
    }

    return true;
  });

  if (genuine.length === 0) return null;

  // Sort ascending by price, return the cheapest
  genuine.sort((a, b) => Number(a.price) - Number(b.price));
  return Number(genuine[0].price);
}

// ── Compute target sell price ───────────────────────────────
// target = cheapest_genuine - undercut
// floor  = weighted_avg_buy + min_profit
// final  = max(target, floor)
async function computeTargetPrice() {
  const cheapest = await fetchCheapestGenuineSellPrice();
  const avgBuy = orders.weightedAvgBuyPrice();

  if (cheapest === null) {
    return { price: null, reason: 'no_genuine_competitor' };
  }

  if (avgBuy === null) {
    return { price: null, reason: 'no_buy_history' };
  }

  const target = cheapest - config.sell.undercutNgn;
  const floor = avgBuy + config.sell.minProfitNgn;
  const final = Math.max(target, floor);

  return {
    price: Number(final.toFixed(2)),
    cheapest,
    avgBuy: Number(avgBuy.toFixed(2)),
    floor: Number(floor.toFixed(2)),
    target: Number(target.toFixed(2)),
    clampedToFloor: final === floor,
  };
}

// ── Main sell cycle ─────────────────────────────────────────
async function runSellCycle() {
  const log = {};

  // 1. Fetch current ad state
  let currentAd;
  try {
    currentAd = await ads.fetchAdInfo(ROLES.USDC_SELL);
    log.currentPrice = Number(currentAd.price);
    log.currentQty = Number(currentAd.quantity);
    log.currentLastQty = Number(currentAd.lastQuantity);
  } catch (err) {
    return { ok: false, reason: 'ad_fetch_failed', error: err.message };
  }

  // 2. Compute desired quantity from actual available USDC
  let available;
  try {
    available = await inventory.availableUsdcForSell();
    log.availableUsdc = available;
  } catch (err) {
    return { ok: false, reason: 'balance_fetch_failed', error: err.message };
  }

  // 3. Compute desired price
  const priceResult = await computeTargetPrice();
  log.priceCalc = priceResult;

  if (priceResult.price === null) {
    // Can't price — skip price edit but still sync quantity if needed
    log.skipReason = priceResult.reason;
  }

  // 4. Decide what to edit
  const priceChanged =
    priceResult.price !== null &&
    Math.abs(Number(currentAd.price) - priceResult.price) > 0.001;

  const qtyChanged =
    Math.abs(Number(currentAd.quantity) - available) > 0.01;

  if (!priceChanged && !qtyChanged) {
    return { ok: true, action: 'none', log };
  }

  // 5. Rate-limit / throttle check
  const canEdit = ads.canEditAd(ROLES.USDC_SELL);
  if (!canEdit.allowed) {
    return { ok: true, action: 'throttled', reason: canEdit.reason, log };
  }

  // 6. Override check — price locked in manual mode
  const priceGate = override.canEditPrice(override.SCOPES.SELL);
  const willEditPrice = priceChanged && priceGate.allowed;
  const willEditQty = qtyChanged; // always allowed

  if (!willEditPrice && !willEditQty) {
    return { ok: true, action: 'manual_price_locked', log };
  }

  // 7. Build the edit parameters
  // If price is locked (manual), keep current price; only update quantity.
  const newPrice = willEditPrice ? priceResult.price : Number(currentAd.price);
  const newQty = available;

  // 8. Submit read-modify-write with verify
  try {
    const updated = await ads.updateAd(ROLES.USDC_SELL, {
      price: newPrice,
      quantity: newQty,
    });
    log.updated = {
      price: Number(updated.price),
      quantity: Number(updated.quantity),
      lastQuantity: Number(updated.lastQuantity),
    };
    return {
      ok: true,
      action: willEditPrice && willEditQty ? 'price_and_qty'
        : willEditPrice ? 'price_only'
        : 'qty_only',
      log,
    };
  } catch (err) {
    return { ok: false, reason: 'edit_failed', error: err.message, log };
  }
}

module.exports = {
  fetchCheapestGenuineSellPrice,
  computeTargetPrice,
  runSellCycle,
};