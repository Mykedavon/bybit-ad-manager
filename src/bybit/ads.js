// src/bybit/ads.js
// Ad registry with hardcoded Ad IDs.
// Bypasses the empty getAdsList() response by using the IDs you provide.

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

// ── HARDCODED AD IDs ────────────────────────────────────────
// Paste your real Bybit Ad IDs here. Find them on the Bybit P2P page:
// click each ad, look at the URL or ad details for the ID.
const AD_IDS = {
  [ROLES.USDT_BUY]: '2048155803803877376',
  [ROLES.USDC_SMALL_BUY]: '2116820960323358720',
  [ROLES.USDC_LARGE_BUY]: '2123476111959023616',
  [ROLES.USDC_SELL]: '2116798411379228672',
};

// ── Map roles to ad IDs ─────────────────────────────────────
// Uses hardcoded IDs. Fetches ad details once to populate the DB.
async function mapRolesToAdIds() {
  // Validate that real IDs were provided
  for (const [role, adId] of Object.entries(AD_IDS)) {
    if (!adId || adId.startsWith('PASTE_')) {
      throw new Error(
        `[ads] Missing hardcoded Ad ID for role "${role}". ` +
        `Edit src/bybit/ads.js and replace the placeholder.`
      );
    }
  }

  // Fetch details for each ad and persist
  for (const [role, adId] of Object.entries(AD_IDS)) {
    try {
      const info = await client.getAdInfo(adId);
      db.ads.upsert(
        role,
        adId,
        info.tokenId,
        Number(info.side),
        Number(info.price) || 0,
        Number(info.lastQuantity) || 0
      );
      console.log(`[ads] Mapped ${role} → ${adId} (${info.tokenId}, price=${info.price})`);
    } catch (err) {
      console.error(`[ads] Failed to fetch details for ${role} (${adId}): ${err.message}`);
      // Still store the ID so the bot doesn't crash, but log the error
      db.ads.upsert(role, adId, 'UNKNOWN', 0, 0, 0);
    }
  }

  console.log('[ads] Hardcoded ad mapping complete.');
  return AD_IDS;
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