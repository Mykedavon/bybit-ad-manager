// src/bybit/ads.js
// Ad registry: maps role → Bybit ad ID. Fetches ad details.
// Provides read-modify-write update wrapper with verify-after-write.

const { client, BybitError } = require('./client');
const db = require('../db/db');
const config = require('../config');

// Roles the bot manages
const ROLES = {
  USDT_BUY: 'usdt_buy',
  USDC_SMALL_BUY: 'usdc_small_buy',
  USDC_LARGE_BUY: 'usdc_large_buy',
  USDC_SELL: 'usdc_sell',
};

// ── Role → matching rules ────────────────────────────────────
// Resilient to type/case differences in Bybit's response.
const ROLE_MATCHERS = [
  {
    role: ROLES.USDT_BUY,
    match: (ad) =>
      ad.tokenId?.toUpperCase() === config.tokens.buy1?.toUpperCase() &&
      Number(ad.side) === 0 &&
      Math.abs(Number(ad.minAmount) - config.buy.minUsdtNgn) < 1,
  },
  {
    role: ROLES.USDC_SMALL_BUY,
    match: (ad) =>
      ad.tokenId?.toUpperCase() === config.tokens.buy2?.toUpperCase() &&
      Number(ad.side) === 0 &&
      Math.abs(Number(ad.minAmount) - config.buy.minUsdcSmallNgn) < 1,
  },
  {
    role: ROLES.USDC_LARGE_BUY,
    match: (ad) =>
      ad.tokenId?.toUpperCase() === config.tokens.buy3?.toUpperCase() &&
      Number(ad.side) === 0 &&
      Math.abs(Number(ad.minAmount) - config.buy.minUsdcLargeNgn) < 1,
  },
  {
    role: ROLES.USDC_SELL,
    match: (ad) =>
      ad.tokenId?.toUpperCase() === config.tokens.sell?.toUpperCase() &&
      Number(ad.side) === 1,
  },
];

// ── Map roles to ad IDs ─────────────────────────────────────
async function mapRolesToAdIds() {
  const result = await client.getMyAds();
  const ads = result.items || [];

  // Debug log — prints the raw ads so you can see exact field values.
  console.log('[ads] Raw ads from Bybit:', JSON.stringify(ads, null, 2));

  const mapping = {};

  for (const matcher of ROLE_MATCHERS) {
    const found = ads.find(matcher.match);
    if (!found) {
      throw new Error(
        `[ads] Could not find ad for role "${matcher.role}". ` +
        `Check that the ad exists and its token/side/minAmount match config.`
      );
    }
    mapping[matcher.role] = found.id;
  }

  // Persist to DB
  for (const [role, adId] of Object.entries(mapping)) {
    const matcher = ROLE_MATCHERS.find((m) => m.role === role);
    const ad = ads.find(matcher.match);
    db.ads.upsert(
      role,
      adId,
      ad.tokenId,
      Number(ad.side),
      Number(ad.price) || 0,
      Number(ad.lastQuantity) || 0
    );
  }

  return mapping;
}

// ── Get ad ID for a role ────────────────────────────────────
function getAdId(role) {
  const row = db.ads.get(role);
  if (!row) throw new Error(`[ads] No ad ID mapped for role "${role}". Run mapRolesToAdIds() first.`);
  return row.ad_id;
}

// ── Fetch full ad info ──────────────────────────────────────
async function fetchAdInfo(role) {
  const adId = getAdId(role);
  const result = await client.getAdInfo(adId);
  return result;
}

// ── Read-modify-write update with verify ────────────────────
async function updateAd(role, { price, quantity, minAmount, maxAmount, paymentIds }) {
  const adId = getAdId(role);

  const before = await fetchAdInfo(role);

  const params = {
    id: adId,
    priceType: before.priceType || '0',
    premium: before.premium || '',
    price: price !== undefined ? String(price) : before.price,
    quantity: quantity !== undefined ? String(quantity) : before.quantity,
    minAmount: minAmount !== undefined ? String(minAmount) : before.minAmount,
    maxAmount: maxAmount !== undefined ? String(maxAmount) : before.maxAmount,
    remark: before.remark || '',
    tradingPreferenceSet: before.tradingPreferenceSet || {},
    paymentIds: paymentIds || before.payments || [],
    actionType: 'MODIFY',
    paymentPeriod: before.paymentPeriod || '15',
  };

  await client.updateAd(params);

  const after = await fetchAdInfo(role);

  const priceOk = price === undefined || Math.abs(Number(after.price) - Number(price)) < 0.001;
  const qtyOk = quantity === undefined || Math.abs(Number(after.quantity) - Number(quantity)) < 0.001;

  if (!priceOk || !qtyOk) {
    throw new BybitError(
      'VERIFY_FAILED',
      `Ad update verification failed for ${role}. ` +
      `Expected price=${price ?? 'unchanged'}, qty=${quantity ?? 'unchanged'}. ` +
      `Got price=${after.price}, qty=${after.quantity}.`,
      0,
      { role, before, after, requested: { price, quantity } }
    );
  }

  db.editLog.record(role);
  db.ads.updateState(role, Number(after.price), Number(after.lastQuantity));

  return after;
}

// ── Update ad state in DB without editing ───────────────────
async function refreshAdState(role) {
  const info = await fetchAdInfo(role);
  db.ads.updateState(role, Number(info.price), Number(info.lastQuantity));
  return info;
}

// ── Rate-limit guard ────────────────────────────────────────
function canEditAd(role) {
  const lastEdit = db.editLog.lastEditAt(role);
  const throttleMs = config.sell.editThrottleSeconds * 1000;

  if (Date.now() - lastEdit < throttleMs) {
    return { allowed: false, reason: 'throttle', nextAllowedInMs: throttleMs - (Date.now() - lastEdit) };
  }

  const countIn5Min = db.editLog.countInLastWindow(role, 5 * 60 * 1000);
  if (countIn5Min >= config.safety.adEditLimitPer5Min) {
    return { allowed: false, reason: 'rate_limit', countIn5Min };
  }

  return { allowed: true };
}

module.exports = {
  ROLES,
  mapRolesToAdIds,
  getAdId,
  fetchAdInfo,
  updateAd,
  refreshAdState,
  canEditAd,
};