// src/managers/sellManager.js
// 1-minute sell loop. Manages one USDC sell ad.

const { client } = require('../bybit/client');
const { getOnlineAdsCached } = require('./priceCache');
const ads = require('../bybit/ads');
const inventory = require('./inventory');
const override = require('./override');
const orders = require('../bybit/orders');
const db = require('../db/db');
const config = require('../config');
const { ROLES } = ads;

async function fetchCheapestGenuineSellPrice() {
  const result = await getOnlineAdsCached({
    tokenId: config.tokens.sell,
    side: '1',
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
  genuine.sort((a, b) => Number(a.price) - Number(b.price));
  return Number(genuine[0].price);
}

async function computeTargetPrice() {
  const cheapest = await fetchCheapestGenuineSellPrice();
  const avgBuy = orders.weightedAvgBuyPrice();

  if (cheapest === null) return { price: null, reason: 'no_genuine_competitor' };
  if (avgBuy === null) return { price: null, reason: 'no_buy_history' };

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

async function runSellCycle() {
  console.log('[sell] cycle started');
  const log = {};

  let currentAd;
  try {
    currentAd = await ads.fetchAdInfo(ROLES.USDC_SELL);
    log.currentPrice = Number(currentAd.price);
    log.currentQty = Number(currentAd.quantity);
    log.currentLastQty = Number(currentAd.lastQuantity);
  } catch (err) {
    return { ok: false, reason: 'ad_fetch_failed', error: err.message };
  }

  let available;
  try {
    available = await inventory.availableUsdcForSell();
    log.availableUsdc = available;
  } catch (err) {
    return { ok: false, reason: 'balance_fetch_failed', error: err.message };
  }

  // Safety: never zero the ad based on a suspicious zero balance.
  if (available === 0 && Number(currentAd.quantity) > 0) {
    return {
      ok: true,
      action: 'skipped_zero_balance',
      warning: 'availableUsdc=0 but ad has quantity. Skipping quantity edit.',
      log,
    };
  }

  const priceResult = await computeTargetPrice();
  log.priceCalc = priceResult;

  if (priceResult.price === null) {
    log.skipReason = priceResult.reason;
  }

  const priceChanged =
    priceResult.price !== null &&
    Math.abs(Number(currentAd.price) - priceResult.price) > 0.001;

  const qtyChanged = Math.abs(Number(currentAd.quantity) - available) > 0.01;

  if (!priceChanged && !qtyChanged) {
    return { ok: true, action: 'none', log };
  }

  const canEdit = ads.canEditAd(ROLES.USDC_SELL);
  if (!canEdit.allowed) {
    return { ok: true, action: 'throttled', reason: canEdit.reason, log };
  }

  const priceGate = override.canEditPrice(override.SCOPES.SELL);
  const willEditPrice = priceChanged && priceGate.allowed;
  const willEditQty = qtyChanged;

  if (!willEditPrice && !willEditQty) {
    return { ok: true, action: 'manual_price_locked', log };
  }

  const newPrice = willEditPrice ? priceResult.price : Number(currentAd.price);
  const newQty = available;

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