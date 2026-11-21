// src/config.js
// Loads .env, validates required values, exposes a single config object.
// If anything required is missing or malformed, the process exits immediately.

require('dotenv').config();

const REQUIRED = [
  'BYBIT_API_KEY',
  'BYBIT_API_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_CHAT_ID',
];

const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length > 0) {
  console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

function num(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    console.error(`[config] ${key} must be a number, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

function bool(key, fallback) {
  const raw = (process.env[key] || '').toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function str(key, fallback) {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

const config = {
  bybit: {
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
    env: str('BYBIT_ENV', 'mainnet'),
    baseUrl: 'https://api.bybit.com',
  },

  capital: {
    initialNgn: num('INITIAL_CAPITAL_NGN', 1000000),
  },

  tokens: {
    buy1: str('TOKEN_BUY_1', 'USDT'),
    buy2: str('TOKEN_BUY_2', 'USDC'),
    buy3: str('TOKEN_BUY_3', 'USDC'),
    sell: str('TOKEN_SELL', 'USDC'),
  },

  buy: {
    cycleMinutes: num('BUY_CYCLE_MINUTES', 5),
    minUsdtNgn: num('BUY_MIN_USDT_NGN', 50000),
    minUsdcSmallNgn: num('BUY_MIN_USDC_SMALL_NGN', 50000),
    minUsdcLargeNgn: num('BUY_MIN_USDC_LARGE_NGN', 200000),
    maxQtyUsdt: num('BUY_MAX_QTY_USDT', 100000),
    maxQtyUsdcSmall: num('BUY_MAX_QTY_USDC_SMALL', 100000),
    maxQtyUsdcLarge: num('BUY_MAX_QTY_USDC_LARGE', 100000),
  },

  priceRules: {
    usdtUsdcToleranceNgn: num('USDT_USDC_TOLERANCE_NGN', 1.0),
    largeSmallGapNgn: num('LARGE_SMALL_USDC_GAP_NGN', 2.5),
    priceGateThresholdNgn: num('PRICE_GATE_THRESHOLD_NGN', 10),
  },

  competitors: {
    minOrders30d: num('COMPETITOR_MIN_ORDERS_30D', 300),
    minCompletionRate: num('COMPETITOR_MIN_COMPLETION_RATE', 0.95),
    maxPremiumNgn: num('COMPETITOR_MAX_PREMIUM_NGN', 5),
    fetchLimit: num('COMPETITOR_FETCH_LIMIT', 10),
  },

  replenish: {
    thresholdUsdc: num('REPLENISH_THRESHOLD_USDC', 50),
    usdtStep: num('REPLENISH_USDT_STEP', 50),
    usdcSmallStep: num('REPLENISH_USDC_SMALL_STEP', 50),
    usdcLargeStep: num('REPLENISH_USDC_LARGE_STEP', 50),
  },

  sell: {
    cycleSeconds: num('SELL_CYCLE_SECONDS', 60),
    undercutNgn: num('SELL_UNDERCUT_NGN', 0.05),
    minProfitNgn: num('SELL_MIN_PROFIT_NGN', 10),
    avgWindow: num('SELL_AVG_WINDOW', 15),
    editThrottleSeconds: num('EDIT_THROTTLE_SECONDS', 60),
  },

  orders: {
    reminderInitialMinutes: num('BUY_REMINDER_INITIAL_MINUTES', 5),
    reminderIntervalMinutes: num('BUY_REMINDER_INTERVAL_MINUTES', 1),
    reminderMaxCount: num('BUY_REMINDER_MAX_COUNT', 10),
    sellOnlineDelaySeconds: num('SELL_ONLINE_DELAY_SECONDS', 10),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID,
    dailyReportTime: str('DAILY_REPORT_TIME', '23:50'),
    dailyReportRetentionDays: num('DAILY_REPORT_RETENTION_DAYS', 30),
    operationalRetentionMinutes: num('OPERATIONAL_MSG_RETENTION_MINUTES', 30),
  },

  priceGate: {
    expiryMinutes: num('PRICE_GATE_EXPIRY_MINUTES', 30),
  },

  safety: {
    adEditLimitPer5Min: num('AD_EDIT_LIMIT_PER_5MIN', 10),
    emergencyStop: bool('EMERGENCY_STOP', false),
    reconcileIntervalMinutes: num('RECONCILE_INTERVAL_MINUTES', 30),
    reconcileAlertThresholdUsdc: num('RECONCILE_ALERT_THRESHOLD_USDC', 0.5),
  },

  logging: {
    level: str('LOG_LEVEL', 'info'),
    dir: str('LOG_DIR', 'logs'),
  },

  timezone: str('TZ', 'Africa/Lagos'),
};

module.exports = config;