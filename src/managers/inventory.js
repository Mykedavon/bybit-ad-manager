// src/managers/inventory.js
// Tracks actual USDC and USDT balances from the Bybit Funding Account.
// Provides "available for sale" quantities that exclude funds frozen
// in open orders.

const { client } = require('../bybit/client');
const db = require('../db/db');
const config = require('../config');

// ── Fetch Funding Account balances ──────────────────────────
// Returns { USDC: {wallet, transfer, available}, USDT: {...} }
async function fetchFundingBalances() {
  const result = await client.getWalletBalance('FUND');
  const list = result.balance || [];

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

// ── Get available USDC for P2P selling ──────────────────────
// transferBalance already excludes amounts locked in open orders
// and other holds. This is the number to advertise.
async function availableUsdcForSell() {
  const balances = await fetchFundingBalances();
  const usdc = balances[config.tokens.sell];
  if (!usdc) return 0;
  return usdc.transfer;
}

// ── Get available USDT for buy ad quantity ──────────────────
async function availableUsdtForBuy() {
  const balances = await fetchFundingBalances();
  const usdt = balances[config.tokens.buy1];
  if (!usdt) return 0;
  return usdt.transfer;
}

// ── Get full inventory snapshot ─────────────────────────────
async function snapshot() {
  const balances = await fetchFundingBalances();
  const usdc = balances[config.tokens.sell] || { wallet: 0, transfer: 0, available: 0 };
  const usdt = balances[config.tokens.buy1] || { wallet: 0, transfer: 0, available: 0 };

  return {
    usdc: {
      wallet: usdc.wallet,
      availableForSell: usdc.transfer,
    },
    usdt: {
      wallet: usdt.wallet,
      availableForBuy: usdt.transfer,
    },
    fetchedAt: Date.now(),
  };
}

// ── Compute current buy ad quantities ───────────────────────
// The bot does not "hold" quantity in a separate bucket. The buy ad
// quantity is whatever the ad currently shows. Replenishment increases
// it by fixed steps. This function reads current ad state from DB.
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

// ── Reconciliation check ────────────────────────────────────
// Compares the bot's internal expectation of USDC vs actual balance.
// Expected = what the bot thinks it has sold/purchased.
// Actual = transferBalance from Bybit.
// Alerts if discrepancy exceeds threshold.
async function reconcile() {
  const balances = await fetchFundingBalances();
  const usdc = balances[config.tokens.sell] || { transfer: 0 };

  // The bot doesn't maintain a separate "expected USDC" ledger yet.
  // For now, just record the actual balance. Full reconciliation
  // (expected vs actual) needs the trade ledger complete.
  const actual = usdc.transfer;

  // Log the snapshot for the reconciliation table
  // (expected will come from trade ledger once that's wired in buyManager)
  db.reconcile.record({
    token: config.tokens.sell,
    expected: actual, // placeholder until expected ledger exists
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