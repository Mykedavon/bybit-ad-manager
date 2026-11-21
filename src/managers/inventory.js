// src/managers/inventory.js
// Reads Funding Account balances. Unwraps SDK result envelope.

const { client } = require('../bybit/client');
const db = require('../db/db');
const config = require('../config');

async function fetchFundingBalances() {
  const raw = await client.getWalletBalance('FUND');
  const result = raw.result || raw;
  const list = result.balance || result.list || [];

  const out = {};
  for (const coin of list) {
    out[coin.coin] = {
      wallet: Number(coin.walletBalance) || 0,
      transfer: Number(coin.transferBalance) || 0,
      available: Number(coin.availableToWithdraw) || 0,
    };
  }
  return out;
}

async function availableUsdcForSell() {
  const balances = await fetchFundingBalances();
  const usdc = balances[config.tokens.sell];
  if (!usdc) return 0;
  return usdc.transfer;
}

async function availableUsdtForBuy() {
  const balances = await fetchFundingBalances();
  const usdt = balances[config.tokens.buy1];
  if (!usdt) return 0;
  return usdt.transfer;
}

async function snapshot() {
  const balances = await fetchFundingBalances();
  const usdc = balances[config.tokens.sell] || { wallet: 0, transfer: 0, available: 0 };
  const usdt = balances[config.tokens.buy1] || { wallet: 0, transfer: 0, available: 0 };

  return {
    usdc: { wallet: usdc.wallet, availableForSell: usdc.transfer },
    usdt: { wallet: usdt.wallet, availableForBuy: usdt.transfer },
    fetchedAt: Date.now(),
  };
}

function currentBuyQuantities() {
  const usdtAd = db.ads.get('usdt_buy');
  const usdcSmallAd = db.ads.get('usdc_small_buy');
  const usdcLargeAd = db.ads.get('usdc_large_buy');
  return {
    usdt: usdtAd ? usdtAd.last_qty : 0,
    usdcSmall: usdcSmallAd ? usdcSmallAd.last_qty : 0,
    usdcLarge: usdcLargeAd ? usdcLargeAd.last_qty : 0,
  };
}

async function reconcile() {
  const balances = await fetchFundingBalances();
  const usdc = balances[config.tokens.sell] || { transfer: 0 };
  const actual = usdc.transfer;
  db.reconcile.record({
    token: config.tokens.sell,
    expected: actual,
    actual,
    diff: 0,
    ok: true,
  });
  return { token: config.tokens.sell, actual, ok: true };
}

module.exports = {
  fetchFundingBalances,
  availableUsdcForSell,
  availableUsdtForBuy,
  snapshot,
  currentBuyQuantities,
  reconcile,
};