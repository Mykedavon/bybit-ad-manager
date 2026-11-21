// src/telegram/bot.js
// Telegraf bot. Handles:
//   - Permanent toggle panel for Buy Ads / Sell Ad
//   - Price-gate Confirm buttons
//   - Auto-deletion of operational messages after 30 min
//   - Daily report delivery

const { Telegraf, Markup } = require('telegraf');
const config = require('../config');
const override = require('../managers/override');
const db = require('../db/db');

const bot = new Telegraf(config.telegram.botToken);

// ── Track messages to auto-delete ───────────────────────────
const pendingDeletions = new Map(); // msgId -> timeout handle

function scheduleDelete(chatId, messageId, minutes) {
  if (minutes <= 0) return;
  const ms = minutes * 60 * 1000;
  const key = `${chatId}:${messageId}`;

  // Clear any existing timer for this message
  if (pendingDeletions.has(key)) {
    clearTimeout(pendingDeletions.get(key));
  }

  const timeout = setTimeout(async () => {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
    } catch (err) {
      // Message may already be deleted — ignore
    }
    pendingDeletions.delete(key);
  }, ms);

  pendingDeletions.set(key, timeout);
}

// ── Send message with optional auto-delete ──────────────────
async function send(chatId, text, options = {}, deleteAfterMinutes = 0) {
  const msg = await bot.telegram.sendMessage(chatId, text, options);
  if (deleteAfterMinutes > 0) {
    scheduleDelete(chatId, msg.message_id, deleteAfterMinutes);
  }
  return msg;
}

// ── Toggle panel ────────────────────────────────────────────
// Permanent inline buttons. Status shown in button text.
// Re-sent on startup so buttons are always live.
function buildPanelKeyboard() {
  const snap = override.snapshot();
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        snap.buy.label,
        'toggle_buy'
      ),
    ],
    [
      Markup.button.callback(
        snap.sell.label,
        'toggle_sell'
      ),
    ],
  ]);
}

async function sendPanel(chatId) {
  const text = 'Bot control panel. Tap a button to toggle Auto/Manual mode.\n' +
    'Manual = price locked, quantity still managed.';
  const msg = await bot.telegram.sendMessage(chatId, text, buildPanelKeyboard());
  try {
    await bot.telegram.pinChatMessage(chatId, msg.message_id);
  } catch (err) {
    // Pinning may fail if no permission — ignore
  }
  return msg;
}

// ── Update panel button labels after a toggle ───────────────
async function refreshPanel(chatId, messageId) {
  try {
    await bot.telegram.editMessageReplyMarkup(
      chatId,
      messageId,
      undefined,
      buildPanelKeyboard().reply_markup
    );
  } catch (err) {
    // Message may be too old to edit — send a fresh one
    await sendPanel(chatId);
  }
}

// ── Button handlers ─────────────────────────────────────────
bot.action('toggle_buy', async (ctx) => {
  override.toggle(override.SCOPES.BUY);
  await ctx.answerCbQuery('Buy mode toggled');
  await refreshPanel(ctx.chat.id, ctx.callbackQuery.message.message_id);
});

bot.action('toggle_sell', async (ctx) => {
  override.toggle(override.SCOPES.SELL);
  await ctx.answerCbQuery('Sell mode toggled');
  await refreshPanel(ctx.chat.id, ctx.callbackQuery.message.message_id);
});

// ── Price-gate Confirm handler ──────────────────────────────
// Callback data format: confirm_gate:<offerId>
bot.action(/^confirm_gate:(\d+)$/, async (ctx) => {
  const offerId = parseInt(ctx.match[1], 10);
  const offer = db.gateOffers.get(offerId);

  if (!offer || offer.status !== 'pending') {
    await ctx.answerCbQuery('This offer has expired or already resolved');
    return;
  }

  if (offer.expires_at < Date.now()) {
    db.gateOffers.resolve(offerId, 'expired');
    await ctx.answerCbQuery('This offer has expired');
    return;
  }

  try {
    const ads = require('../bybit/ads');
    await ads.updateAd(offer.role, {
      price: offer.intended_price,
      quantity: offer.intended_qty,
    });
    db.gateOffers.resolve(offerId, 'confirmed');
    await ctx.answerCbQuery('Price posted');
    await ctx.editMessageText(
      `✅ Confirmed: ${offer.role} posted at ₦${offer.intended_price}`
    );
  } catch (err) {
    await ctx.answerCbQuery('Failed — see logs');
    await ctx.editMessageText(
      `❌ Failed to post ${offer.role}: ${err.message}`
    );
  }
});

// ── Expired Confirm handler ─────────────────────────────────
bot.action(/^expire_gate:(\d+)$/, async (ctx) => {
  const offerId = parseInt(ctx.match[1], 10);
  db.gateOffers.resolve(offerId, 'expired');
  await ctx.answerCbQuery('Offer expired');
  await ctx.editMessageText('This offer has expired.');
});

// ── Send price-gate offer to owner ──────────────────────────
async function sendPriceGateOffer(offerId, role, gateInfo) {
  const chatId = config.telegram.ownerChatId;

  const text =
    `⚠️ Price gate triggered for *${role}*\n\n` +
    `Calculated price: ₦${gateInfo.targetPrice}\n` +
    `Your last buy price: ₦${gateInfo.lastBuy}\n` +
    `Threshold (last + ₦${config.priceRules.priceGateThresholdNgn}): ₦${gateInfo.threshold}\n` +
    `Intended quantity: ${gateInfo.newQty}\n\n` +
    `Tap Confirm to post this price, or ignore to let it expire in ${config.priceGate.expiryMinutes} min.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm', `confirm_gate:${offerId}`)],
  ]);

  const msg = await bot.telegram.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...keyboard,
  });

  db.gateOffers.setTelegramMsg(offerId, msg.message_id);
  scheduleDelete(chatId, msg.message_id, config.priceGate.expiryMinutes);
  return msg;
}

// ── Expire stale gate offers (called by scheduler) ──────────
async function expireStaleOffers() {
  const stale = db.gateOffers.expiredPending();
  for (const offer of stale) {
    db.gateOffers.resolve(offer.id, 'expired');
    if (offer.telegram_msg_id) {
      try {
        await bot.telegram.editMessageText(
          config.telegram.ownerChatId,
          offer.telegram_msg_id,
          undefined,
          'This offer has expired.'
        );
      } catch (err) {
        // Ignore — message may already be deleted
      }
    }
  }
  return stale.length;
}

// ── Daily report ────────────────────────────────────────────
async function sendDailyReport() {
  const chatId = config.telegram.ownerChatId;
  const inventory = require('../managers/inventory');
  const orders = require('../bybit/orders');

  const inv = await inventory.snapshot().catch(() => null);
  const avgBuy = orders.weightedAvgBuyPrice();
  const lastBuy = orders.lastBuyPrice();

  const text =
    `📊 *Daily Report* — ${new Date().toLocaleString('en-NG', { timeZone: config.timezone })}\n\n` +
    `*Inventory*\n` +
    `USDC available: ${inv?.usdc?.availableForSell ?? 'N/A'}\n` +
    `USDT available: ${inv?.usdt?.availableForBuy ?? 'N/A'}\n\n` +
    `*Prices*\n` +
    `Weighted avg buy: ${avgBuy ? '₦' + avgBuy.toFixed(2) : 'N/A'}\n` +
    `Last buy price: ${lastBuy ? '₦' + lastBuy.toFixed(2) : 'N/A'}\n\n` +
    `*Mode*\n` +
    `Buy Ads: ${override.isManual(override.SCOPES.BUY) ? 'Manual' : 'Auto'}\n` +
    `Sell Ad: ${override.isManual(override.SCOPES.SELL) ? 'Manual' : 'Auto'}`;

  const msg = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });

  // Daily report retention: 30 days
  scheduleDelete(chatId, msg.message_id, config.telegram.dailyReportRetentionDays * 24 * 60);

  return msg;
}

// ── Startup message ─────────────────────────────────────────
async function sendStartupMessage() {
  const chatId = config.telegram.ownerChatId;
  await send(
    chatId,
    `🤖 Bot started at ${new Date().toLocaleString('en-NG', { timeZone: config.timezone })}\n` +
    `Buy cycle: every ${config.buy.cycleMinutes} min\n` +
    `Sell cycle: every ${config.sell.cycleSeconds} sec`,
    {},
    config.telegram.operationalRetentionMinutes
  );
  await sendPanel(chatId);
}

// ── Launch ──────────────────────────────────────────────────
async function launch() {
  await bot.launch();
  console.log('[telegram] Bot launched');
}

function stop() {
  bot.stop('SIGINT');
}

module.exports = {
  bot,
  launch,
  stop,
  send,
  sendPanel,
  sendPriceGateOffer,
  expireStaleOffers,
  sendDailyReport,
  sendStartupMessage,
  scheduleDelete,
};