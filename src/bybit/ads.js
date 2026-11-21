// src/bybit/ads.js
// Ad registry with hardcoded Ad IDs.
// Unwraps the SDK's { ret_code, result: {...} } envelope.
// Fails loudly on any error. Aborts immediately on rate limit.

const { client, BybitError } = require('./client');
const db = require('../db/db');
const config = require('../config');

const ROLES = {
  USDT_BUY: 'usdt_buy',
  USDC_SMALL_BUY: 'usdc_small_buy',
  USDC_LARGE_BUY: 'usdc_large_buy',
  USDC_SELL: 'usdc_sell',
};

const AD_IDS = {
  [ROLES.USDT_BUY]: '2048155803803877376',
  [ROLES.USDC_SMALL_BUY]: '2116820960323358720',
  [ROLES.USDC_LARGE_BUY]: '2123476111959023616',
  [ROLES.USDC_SELL]: '2116798411379228672',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapRolesToAdIds() {
  const mapping = {};

  for (const [role, adId] of Object.entries(AD_IDS)) {
    if (!adId || adId.startsWith('PASTE_')) {
      throw new Error(`[ads] Missing hardcoded Ad ID for role "${role}".`);
    }

    let raw;
    try {
      raw = await client.getAdInfo(adId);
    } catch (err) {
      if (err.message && err.message.includes('10006')) {
        throw new Error(
          `[ads] Rate limited by Bybit. Waiting for next 5-minute retry. Stopped at role: ${role}`
        );
      }
      throw new Error(`[ads] getAdInfo failed for ${role} (${adId}): ${err.message}`);
    }

    // SDK wraps the ad data in { ret_code, ret_msg, result: {...} }
    const data = raw.result || raw;

    const token = data.tokenId || data.token || data.coin;
    const side = data.side !== undefined ? Number(data.side) : (role === ROLES.USDC_SELL ? 1 : 0);
    const price = Number(data.price) || 0;
    const lastQty = Number(data.lastQuantity || data.quantity) || 0;

    if (!token) {
      throw new Error(
        `[ads] getAdInfo(${role}) returned no recognizable token field. ` +
        `Saw keys: ${Object.keys(data).join(', ')}`
      );
    }

    db.ads.upsert(role, adId, token, side, price, lastQty);
    mapping[role] = adId;
    console.log(`[ads] Mapped ${role} → ${adId} (${token}, price=${price}, qty=${lastQty})`);

    await sleep(3000);
  }

  console.log('[ads] Hardcoded ad mapping complete.');
  return mapping;
}

function getAdId(role) {
  const row = db.ads.get(role);
  if (!row) throw new Error(`[ads] No ad ID mapped for role "${role}". Run mapRolesToAdIds() first.`);
  return row.ad_id;
}

async function fetchAdInfo(role) {
  const adId = getAdId(role);
  const raw = await client.getAdInfo(adId);
  return raw.result || raw;
}

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

async function refreshAdState(role) {
  const info = await fetchAdInfo(role);
  db.ads.updateState(role, Number(info.price), Number(info.lastQuantity));
  return info;
}

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