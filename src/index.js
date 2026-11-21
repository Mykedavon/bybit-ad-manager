// src/index.js
// Entry point. Starts the bot:
//   1. Maps ad IDs to roles
//   2. Launches Telegram
//   3. Runs sell loop every 60s
//   4. Runs buy loop every 5 min
//   5. Runs daily report at 23:50 Lagos
//   6. Handles graceful shutdown

require('dotenv').config();

const config = require('./config');
const ads = require('./bybit/ads');
const sellManager = require('./managers/sellManager');
const buyManager = require('./managers/buyManager');
const inventory = require('./managers/inventory');
const replenishment = require('./managers/replenishment');
const telegram = require('./telegram/bot');
const db = require('./db/db');

// ── Simple scheduler (no external dep) ─────────────────────
// Runs fn every intervalMs. Prevents overlapping runs.
function createLoop(name, intervalMs, fn) {
  let running = false;
  let timer = null;

  const tick = async () => {
    if (running) {
      console.log(`[${name}] previous run still active, skipping`);
      return;
    }
    running = true;
    try {
      const result = await fn();
      console.log(`[${name}]`, JSON.stringify(result).slice(0, 500));
    } catch (err) {
      console.error(`[${name}] error:`, err.message);
      // Alert owner on repeated failures
      telegram.send(
        config.telegram.ownerChatId,
        `⚠️ ${name} error: ${err.message}`,
        {},
        config.telegram.operationalRetentionMinutes
      ).catch(() => {});
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      // Run immediately once, then on interval
      tick();
      timer = setInterval(tick, intervalMs);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// ── Daily report scheduler ─────────────────────────────────
// Runs at 23:50 Lagos time every day.
function scheduleDailyReport() {
  const [hh, mm] = config.telegram.dailyReportTime.split(':').map(Number);
  let lastRunDate = null;

  const check = async () => {
    const now = new Date(
      new Date().toLocaleString('en-US', { timeZone: config.timezone })
    );
    const today = now.toDateString();
    if (
      now.getHours() === hh &&
      now.getMinutes() === mm &&
      lastRunDate !== today
    ) {
      lastRunDate = today;
      try {
        await telegram.sendDailyReport();
        console.log('[daily-report] sent');
      } catch (err) {
        console.error('[daily-report] failed:', err.message);
      }
    }
  };

  // Check every 30 seconds
  return setInterval(check, 30 * 1000);
}

// ── Gate expiry scheduler ──────────────────────────────────
// Every minute: expire stale price-gate offers and stale increments.
function scheduleExpiryChecks() {
  return setInterval(async () => {
    try {
      const expiredOffers = await telegram.expireStaleOffers();
      const expiredIncrements = replenishment.expireStaleIncrements();
      if (expiredOffers > 0 || expiredIncrements > 0) {
        console.log(`[expiry] offers=${expiredOffers} increments=${expiredIncrements}`);
      }
    } catch (err) {
      console.error('[expiry] error:', err.message);
    }
  }, 60 * 1000);
}

// ── Reconciliation scheduler ───────────────────────────────
// Every 30 min (configurable): compare internal records vs Bybit balances.
function scheduleReconciliation() {
  return setInterval(async () => {
    try {
      const result = await inventory.reconcile();
      if (!result.ok) {
        await telegram.send(
          config.telegram.ownerChatId,
          `⚠️ Balance discrepancy: expected ${result.expected}, actual ${result.actual}`,
          {},
          config.telegram.operationalRetentionMinutes
        );
      }
    } catch (err) {
      console.error('[reconcile] error:', err.message);
    }
  }, config.safety.reconcileIntervalMinutes * 60 * 1000);
}

// ── Main bootstrap ─────────────────────────────────────────
async function main() {
  console.log('[startup] loading config…');

  // 1. Verify ad mapping
  console.log('[startup] mapping ad IDs to roles…');
  try {
    await ads.mapRolesToAdIds();
    console.log('[startup] ad mapping OK');
  } catch (err) {
    console.error('[startup] FATAL: ad mapping failed —', err.message);
    console.error('Check that all four ads exist on Bybit with the expected token/side/minAmount.');
    process.exit(1);
  }

  // 2. Wire the Telegram notifier into buyManager
  buyManager.setTelegramNotifier(telegram);

  // 3. Launch Telegram
  await telegram.launch();
  await telegram.sendStartupMessage();

  // 4. Start loops
  const sellLoop = createLoop(
    'sell',
    config.sell.cycleSeconds * 1000,
    () => sellManager.runSellCycle()
  );

  const buyLoop = createLoop(
    'buy',
    config.buy.cycleMinutes * 60 * 1000,
    () => buyManager.runBuyCycle()
  );

  sellLoop.start();
  buyLoop.start();

  // 5. Start schedulers
  const dailyReportTimer = scheduleDailyReport();
  const expiryTimer = scheduleExpiryChecks();
  const reconcileTimer = scheduleReconciliation();

  console.log('[startup] all loops running');

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = (signal) => {
    console.log(`[shutdown] received ${signal}`);
    sellLoop.stop();
    buyLoop.stop();
    clearInterval(dailyReportTimer);
    clearInterval(expiryTimer);
    clearInterval(reconcileTimer);
    telegram.stop();
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err);
    telegram.send(
      config.telegram.ownerChatId,
      `🔥 Uncaught exception: ${err.message}\n${err.stack?.slice(0, 400)}`,
      {},
      config.telegram.operationalRetentionMinutes
    ).catch(() => {});
  });

  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});