// src/managers/buyManager.js
// 5-minute buy loop. Manages three buy ads (USDT, USDC small, USDC large).
// Order of operations per cycle:
//   1. Run replenishment (fetch new sales, fire increments)
//   2. For each ad: fetch competitors, compute price, apply rules
//   3. Apply price gate — auto-post if within threshold, else Telegram Confirm
//   4. Update quantity by adding increment steps (from replenishment)
//   5. For large USDC: skip entirely unless quantity worth >= 200k NGN

const { client } = require('../bybit/client');
const ads = require('../bybit/ads');
const inventory = require('./inventory');
const override = require('./override');
const replenishment = require('./replenishment');
const orders = require('../bybit/orders');
const db = require('../db/db');
const config = require('../config');
const { ROLES } = ads;

// Telegram sender injected from index.js to avoid circular deps
let telegramNotifier = null;
function setTelegramNotifier(fn) { telegramNotifier = fn; }

// ── Fetch highest genuine competitor buy price ──────────────
// For a given token, returns the highest price among genuine buy ads.
async function fetchHighestGenuineBuyPrice(token) {
  const result = await client.getAdsOnline({
    token,
    side: 0, // buy
    currencyId: 'NGN',
    limit: config.competitors.fetchLimit * 3,
  });

  const items = result.items || [];

  // Rolling average of last 10 buys for the fake filter
  const recentBuys = db.completedBuys.lastN(10);
  let rollingAvgBuy = null;
  if (recentBuys.length > 0) {
    const totalNgn = recentBuys.reduce((s, b) => s + b.ngn_spent + b.fee_ngn, 0);
    const totalUsdc = recentBuys.reduce((s, b) => s + b.usdc_amount - b.fee_usdc, 0);
    if (totalUsdc > 0) rollingAvgBuy = totalNgn / totalUsdc;
  }

  const genuine = items.filter((ad) => {
    const completionRate = Number(ad.completionRate) || 0;
    if (completionRate < config.competitors.minCompletionRate) return false;

    const recentOrders = Number(ad.recentOrders) || 0;
    if (recentOrders < config.competitors.minOrders30d) return false;

    if (rollingAvgBuy !== null) {
      const price = Number(ad.price);
      if (price > rollingAvgBuy + config.competitors.maxPremiumNgn) return false;
    }

    return true;
  });

  if (genuine.length === 0) return null;

  // Sort descending, return highest
  genuine.sort((a, b) => Number(b.price) - Number(a.price));
  return Number(genuine[0].price);
}

// ── Compute USDT and USDC buy prices ────────────────────────
// Applies rules in order:
//   1. USDT/USDC tolerance rule
//   2. Large/small USDC gap rule
//   3. Clamp to lower of the two (owner A2 = c)
async function computeBuyPrices() {
  const usdtHighest = await fetchHighestGenuineBuyPrice(config.tokens.buy1);
  const usdcHighest = await fetchHighestGenuineBuyPrice(config.tokens.buy2);

  if (usdtHighest === null || usdcHighest === null) {
    return { ok: false, reason: 'no_genuine_competitor' };
  }

  let usdtPrice = usdtHighest;
  let usdcSmallPrice = usdcHighest;
  let usdcLargePrice = usdcHighest;

  // Rule 1: USDT/USDC tolerance
  if (usdtPrice - usdcSmallPrice > config.priceRules.usdtUsdcToleranceNgn) {
    usdtPrice = usdcSmallPrice;
  }

  // Rule 2: Large <= small + gap
  const largeCap = usdcSmallPrice + config.priceRules.largeSmallGapNgn;
  if (usdcLargePrice > largeCap) {
    usdcLargePrice = largeCap;
  }

  // Rule 3: clamp — large must satisfy both
  // USDT/USDC rule applies to USDT vs USDC small (already done above)
  // Large/small rule applies large vs small (done above)
  // If both constraints pull in opposite directions, lower bound wins:
  usdcLargePrice = Math.min(usdcLargePrice, largeCap);

  return {
    ok: true,
    usdt: Number(usdtPrice.toFixed(2)),
    usdcSmall: Number(usdcSmallPrice.toFixed(2)),
    usdcLarge: Number(usdcLargePrice.toFixed(2)),
    raw: {
      usdtHighest,
      usdcHighest,
    },
  };
}

// ── Apply price gate to a single ad ─────────────────────────
// Returns { action: 'post' | 'gate', finalPrice, reason }
function applyPriceGate(role, calculatedPrice) {
  const lastBuy = orders.lastBuyPrice();

  if (lastBuy === null) {
    // No buy history — cannot compute gate, post directly
    return { action: 'post', finalPrice: calculatedPrice, reason: 'no_history' };
  }

  const threshold = lastBuy + config.priceRules.priceGateThresholdNgn;

  if (calculatedPrice <= threshold) {
    return { action: 'post', finalPrice: calculatedPrice, reason: 'within_gate' };
  }

  return {
    action: 'gate',
    finalPrice: calculatedPrice,
    lastBuy,
    threshold,
    reason: 'exceeds_gate',
  };
}

// ── Process one buy ad ──────────────────────────────────────
async function processAd(role, targetPrice, incrementSteps) {
  const result = { role, actions: [] };

  // Fetch current ad state
  let current;
  try {
    current = await ads.fetchAdInfo(role);
  } catch (err) {
    return { ...result, ok: false, error: 'ad_fetch_failed: ' + err.message };
  }

  const currentPrice = Number(current.price);
  const currentQty = Number(current.quantity);
  const newQty = currentQty + incrementSteps;

  // ── Large USDC eligibility check ────────────────────────
  // Skip entirely if not worth 200k NGN at current cheapest sell price
  if (role === ROLES.USDC_LARGE_BUY) {
    const cheapestSell = await fetchHighestGenuineBuyPrice(config.tokens.sell)
      .catch(() => null);
    // Use cheapest sell price if available, else estimate from target price
    const priceForValue = cheapestSell || targetPrice;
    const valueNgn = newQty * priceForValue;

    if (valueNgn < config.buy.minUsdcLargeNgn) {
      return {
        ...result,
        ok: true,
        skipped: true,
        reason: 'large_ad_below_200k',
        valueNgn,
        needed: config.buy.minUsdcLargeNgn,
      };
    }
  }

  // ── Override check ──────────────────────────────────────
  const priceGate = override.canEditPrice(override.SCOPES.BUY);
  const quantityAlwaysAllowed = override.canEditQuantity(override.SCOPES.BUY);

  // ── Price gate ──────────────────────────────────────────
  let finalPrice = currentPrice;
  let gateResult = null;

  if (priceGate.allowed) {
    gateResult = applyPriceGate(role, targetPrice);
    if (gateResult.action === 'post') {
      finalPrice = gateResult.finalPrice;
    }
    // If gated, we'll send Telegram and NOT edit price now
  }

  // ── Decide what to edit ─────────────────────────────────
  const priceChanged = Math.abs(currentPrice - finalPrice) > 0.001;
  const qtyChanged = incrementSteps > 0;

  if (!priceChanged && !qtyChanged) {
    return { ...result, ok: true, action: 'none' };
  }

  // ── Throttle check ──────────────────────────────────────
  const canEdit = ads.canEditAd(role);
  if (!canEdit.allowed) {
    return {
      ...result,
      ok: true,
      action: 'throttled',
      reason: canEdit.reason,
      deferredPrice: targetPrice,
      deferredQty: newQty,
    };
  }

  // ── If price is gated, do quantity-only edit ────────────
  if (gateResult && gateResult.action === 'gate' && qtyChanged) {
    try {
      await ads.updateAd(role, { quantity: newQty });
      result.actions.push('qty_only_gated');
    } catch (err) {
      return { ...result, ok: false, error: 'qty_edit_failed: ' + err.message };
    }
    // Return gate info for caller to send Telegram
    return {
      ...result,
      ok: true,
      gated: true,
      gateInfo: { role, targetPrice, lastBuy: gateResult.lastBuy, threshold: gateResult.threshold, newQty },
    };
  }

  // ── Normal edit: price and/or quantity ──────────────────
  try {
    const updated = await ads.updateAd(role, {
      price: priceChanged ? finalPrice : undefined,
      quantity: qtyChanged ? newQty : undefined,
    });
    result.actions.push(priceChanged && qtyChanged ? 'price_and_qty'
      : priceChanged ? 'price_only'
      : 'qty_only');
    result.updated = { price: Number(updated.price), quantity: Number(updated.quantity) };
    return { ...result, ok: true, action: 'edited' };
  } catch (err) {
    return { ...result, ok: false, error: 'edit_failed: ' + err.message };
  }
}

// ── Main buy cycle ──────────────────────────────────────────
async function runBuyCycle() {
  const log = {};

  // 1. Run replenishment first — fills pending increments
  try {
    const replenishResult = await replenishment.runReplenishmentCycle();
    log.replenishment = replenishResult;
  } catch (err) {
    log.replenishment = { error: err.message };
  }

  // 2. Expire stale pending increments
  const expired = replenishment.expireStaleIncrements();
  log.expiredIncrements = expired;

  // 3. Get pending increments
  const pending = replenishment.getPendingIncrements();
  log.pendingIncrements = pending.length;

  if (pending.length === 0) {
    // Still recalculate prices even without increment (owner wants price updates every 5 min)
    // But without an increment, no quantity change.
  }

  // 4. Compute target prices
  let priceResult;
  try {
    priceResult = await computeBuyPrices();
  } catch (err) {
    return { ok: false, reason: 'price_calc_failed', error: err.message, log };
  }

  if (!priceResult.ok) {
    return { ok: false, reason: priceResult.reason, log };
  }

  log.prices = priceResult;

  // 5. Aggregate increment steps (all pending increments summed)
  // Each pending increment contributes the configured steps
  const steps = {
    usdt: pending.length * config.replenish.usdtStep,
    usdcSmall: pending.length * config.replenish.usdcSmallStep,
    usdcLarge: pending.length * config.replenish.usdcLargeStep,
  };
  log.steps = steps;

  // 6. Process each ad
  const results = {};

  results.usdt = await processAd(ROLES.USDT_BUY, priceResult.usdt, steps.usdt);
  results.usdcSmall = await processAd(ROLES.USDC_SMALL_BUY, priceResult.usdcSmall, steps.usdcSmall);
  results.usdcLarge = await processAd(ROLES.USDC_LARGE_BUY, priceResult.usdcLarge, steps.usdcLarge);

  log.results = results;

  // 7. Handle gated ads — send Telegram Confirmations
  for (const [role, res] of Object.entries({
    usdt_buy: results.usdt,
    usdc_small_buy: results.usdcSmall,
    usdc_large_buy: results.usdcLarge,
  })) {
    if (res.gated && telegramNotifier) {
      try {
        const offerId = db.gateOffers.create({
          role,
          intendedPrice: res.gateInfo.targetPrice,
          intendedQty: res.gateInfo.newQty,
          marketAvgPrice: res.gateInfo.targetPrice,
          lastBuyPrice: res.gateInfo.lastBuy,
          expiresAt: Date.now() + config.priceGate.expiryMinutes * 60 * 1000,
        });
        await telegramNotifier.sendPriceGateOffer(offerId, role, res.gateInfo);
        // Mark increment as gated (stays pending until confirmed or expired)
      } catch (err) {
        log[`gate_notify_${role}`] = { error: err.message };
      }
    }
  }

  // 8. Mark increments posted if all three ads succeeded without gating
  const allPosted = !results.usdt.gated && !results.usdcSmall.gated && !results.usdcLarge.gated
    && results.usdt.ok && results.usdcSmall.ok && results.usdcLarge.ok;
  if (allPosted && pending.length > 0) {
    for (const inc of pending) {
      replenishment.resolveIncrement(inc.id, 'posted');
    }
  }

  return { ok: true, log };
}

module.exports = {
  setTelegramNotifier,
  fetchHighestGenuineBuyPrice,
  computeBuyPrices,
  applyPriceGate,
  processAd,
  runBuyCycle,
};