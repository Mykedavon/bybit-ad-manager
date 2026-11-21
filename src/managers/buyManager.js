// src/managers/buyManager.js
// 5-minute buy loop. Manages three buy ads.

const { client } = require('../bybit/client');
const { getOnlineAdsCached } = require('./priceCache');
const ads = require('../bybit/ads');
const inventory = require('./inventory');
const override = require('./override');
const replenishment = require('./replenishment');
const orders = require('../bybit/orders');
const db = require('../db/db');
const config = require('../config');
const { ROLES } = ads;

let telegramNotifier = null;
function setTelegramNotifier(fn) { telegramNotifier = fn; }

async function fetchHighestGenuineBuyPrice(token) {
  const result = await getOnlineAdsCached({
    tokenId: token,
    side: '0',
    currencyId: 'NGN',
    size: config.competitors.fetchLimit * 3,
  });

  const items = result.items || [];

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
  genuine.sort((a, b) => Number(b.price) - Number(a.price));
  return Number(genuine[0].price);
}

async function computeBuyPrices() {
  const usdtHighest = await fetchHighestGenuineBuyPrice(config.tokens.buy1);
  const usdcHighest = await fetchHighestGenuineBuyPrice(config.tokens.buy2);

  if (usdtHighest === null || usdcHighest === null) {
    return { ok: false, reason: 'no_genuine_competitor' };
  }

  let usdtPrice = usdtHighest;
  let usdcSmallPrice = usdcHighest;
  let usdcLargePrice = usdcHighest;

  if (usdtPrice - usdcSmallPrice > config.priceRules.usdtUsdcToleranceNgn) {
    usdtPrice = usdcSmallPrice;
  }

  const largeCap = usdcSmallPrice + config.priceRules.largeSmallGapNgn;
  if (usdcLargePrice > largeCap) {
    usdcLargePrice = largeCap;
  }

  usdcLargePrice = Math.min(usdcLargePrice, largeCap);

  return {
    ok: true,
    usdt: Number(usdtPrice.toFixed(2)),
    usdcSmall: Number(usdcSmallPrice.toFixed(2)),
    usdcLarge: Number(usdcLargePrice.toFixed(2)),
    raw: { usdtHighest, usdcHighest },
  };
}

function applyPriceGate(role, calculatedPrice) {
  const lastBuy = orders.lastBuyPrice();
  if (lastBuy === null) {
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

async function processAd(role, targetPrice, incrementSteps) {
  const result = { role, actions: [] };

  let current;
  try {
    current = await ads.fetchAdInfo(role);
  } catch (err) {
    return { ...result, ok: false, error: 'ad_fetch_failed: ' + err.message };
  }

  const currentPrice = Number(current.price);
  const currentQty = Number(current.quantity);
  const newQty = currentQty + incrementSteps;

  if (role === ROLES.USDC_LARGE_BUY) {
    const priceForValue = targetPrice;
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

  const priceGate = override.canEditPrice(override.SCOPES.BUY);
  const quantityAlwaysAllowed = override.canEditQuantity(override.SCOPES.BUY);

  let finalPrice = currentPrice;
  let gateResult = null;

  if (priceGate.allowed) {
    gateResult = applyPriceGate(role, targetPrice);
    if (gateResult.action === 'post') {
      finalPrice = gateResult.finalPrice;
    }
  }

  const priceChanged = Math.abs(currentPrice - finalPrice) > 0.001;
  const qtyChanged = incrementSteps > 0;

  if (!priceChanged && !qtyChanged) {
    return { ...result, ok: true, action: 'none' };
  }

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

  if (gateResult && gateResult.action === 'gate' && qtyChanged) {
    try {
      await ads.updateAd(role, { quantity: newQty });
      result.actions.push('qty_only_gated');
    } catch (err) {
      return { ...result, ok: false, error: 'qty_edit_failed: ' + err.message };
    }
    return {
      ...result,
      ok: true,
      gated: true,
      gateInfo: { role, targetPrice, lastBuy: gateResult.lastBuy, threshold: gateResult.threshold, newQty },
    };
  }

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

async function runBuyCycle() {
  const log = {};

  try {
    const replenishResult = await replenishment.runReplenishmentCycle();
    log.replenishment = replenishResult;
  } catch (err) {
    log.replenishment = { error: err.message };
  }

  const expired = replenishment.expireStaleIncrements();
  log.expiredIncrements = expired;

  const pending = replenishment.getPendingIncrements();
  log.pendingIncrements = pending.length;

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

  const steps = {
    usdt: pending.length * config.replenish.usdtStep,
    usdcSmall: pending.length * config.replenish.usdcSmallStep,
    usdcLarge: pending.length * config.replenish.usdcLargeStep,
  };
  log.steps = steps;

  const results = {};
  results.usdt = await processAd(ROLES.USDT_BUY, priceResult.usdt, steps.usdt);
  results.usdcSmall = await processAd(ROLES.USDC_SMALL_BUY, priceResult.usdcSmall, steps.usdcSmall);
  results.usdcLarge = await processAd(ROLES.USDC_LARGE_BUY, priceResult.usdcLarge, steps.usdcLarge);

  log.results = results;

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
      } catch (err) {
        log[`gate_notify_${role}`] = { error: err.message };
      }
    }
  }

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