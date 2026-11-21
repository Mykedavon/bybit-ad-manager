// src/index.js
// Entry point. Starts the bot:
//   1. Maps ad IDs to roles (with retry)
//   2. Starts sell + buy loops immediately
//   3. Launches Telegram (non-blocking)
//   4. Runs daily report at 23:50 Lagos
//   5. Serves HTTP health endpoint for Render Web Service
//   6. Handles graceful shutdown

const http = require('http');

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
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
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

  return setInterval(check, 30 * 1000);
}

// ── Gate expiry scheduler ──────────────────────────────────
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

  // 1. HTTP health endpoint (starts immediately)
  const PORT = process.env.PORT || 3000;
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
  });
  httpServer.listen(PORT, () => {
    console.log(`[http] health endpoint on port ${PORT}`);
  });

  // 2. Map ad IDs (with retry)
  let adMappingOk = false;
  const tryMapAds = async () => {
    try {
      await ads.mapRolesToAdIds();
      adMappingOk = true;
      console.log('[startup] ad mapping OK');
      return true;
    } catch (err) {
      console.error('[startup] ad mapping failed — FULL ERROR:');
      console.error('name:', err.name);
      console.error('message:', err.message);
      console.error('code:', err.code);
      console.error('raw:', JSON.stringify(err.raw || err, null, 2));
      console.error('stack:', err.stack);
      console.error('Will retry every 5 minutes.');
      return false;
    }
  };

  await tryMapAds();

  let retryTimer = null;
  if (!adMappingOk) {
    retryTimer = setInterval(async () => {
      const ok = await tryMapAds();
      if (ok) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }, 5 * 60 * 1000);
  }

  // 3. Wire Telegram notifier into buyManager
  buyManager.setTelegramNotifier(telegram);

  // 4. Start loops FIRST — before Telegram, so trading runs
  //    even if Telegram is broken.
  const sellLoop = createLoop(
    'sell',
    config.sell.cycleSeconds * 1000,
    async () => {
      if (!adMappingOk) return { skipped: 'ad_mapping_pending' };
      return sellManager.runSellCycle();
    }
  );

  const buyLoop = createLoop(
    'buy',
    config.buy.cycleMinutes * 60 * 1000,
    async () => {
      if (!adMappingOk) return { skipped: 'ad_mapping_pending' };
      return buyManager.runBuyCycle();
    }
  );

  sellLoop.start();
  buyLoop.start();
  console.log('[startup] loops started');

  // 5. Launch Telegram (non-blocking for trading)
  try {
    await telegram.launch();
    await telegram.sendStartupMessage();
    console.log('[telegram] launch OK');
  } catch (err) {
    console.error('[telegram] launch failed —', err.message);
    console.error('Trading continues without Telegram.');
  }

  // 6. Start schedulers
  const dailyReportTimer = scheduleDailyReport();
  const expiryTimer = scheduleExpiryChecks();
  const reconcileTimer = scheduleReconciliation();

  console.log('[startup] all systems running');

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = (signal) => {
    console.log(`[shutdown] received ${signal}`);
    sellLoop.stop();
    buyLoop.stop();
    clearInterval(dailyReportTimer);
    clearInterval(expiryTimer);
    clearInterval(reconcileTimer);
    if (retryTimer) clearInterval(retryTimer);
    try { httpServer.close(); } catch (_) {}
    try { telegram.stop(); } catch (_) {}
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', err);
  });

  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});