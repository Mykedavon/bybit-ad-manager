// src/bybit/chat.js
// Sends messages into Bybit P2P order chats.
// Uses the current endpoint /v5/p2p/chat/message/send_v1 (the old
// /v5/p2p/order/message/send is deprecated).
// Requires a sessionId, fetched per order before sending.

const { client, BybitError } = require('./client');
const db = require('../db/db');
const config = require('../config');

// ── Fetch session ID for an order ───────────────────────────
// The chat send endpoint requires an AES-encrypted sessionId
// tied to the order. This call retrieves it.
async function getSessionId(orderId) {
  const result = await client.post('/v5/p2p/chat/session/get', {
    orderId: String(orderId),
  });
  if (!result || !result.sessionId) {
    throw new BybitError(
      'NO_SESSION_ID',
      `Could not obtain sessionId for order ${orderId}`,
      0,
      result
    );
  }
  return result.sessionId;
}

// ── Send a text message to an order chat ────────────────────
async function sendOrderMessage(orderId, message) {
  const sessionId = await getSessionId(orderId);

  await client.post('/v5/p2p/chat/message/send_v1', {
    orderId: String(orderId),
    sessionId,
    message,
    contentType: 'str',
  });

  return true;
}

// ── Sell order: "I'm online" message ────────────────────────
// Sent 10 seconds after a buyer opens an order against our sell ad.
// Only sent once per order (tracked via chat_message_log).
async function sendSellOnlineMessage(orderId) {
  const existing = db.chatLog.get(orderId, 'sell_online');
  if (existing) return false; // already sent

  const message =
    "Hello, I'm online. Please make your payment, and I'll release your USDC once payment is confirmed. Thank you.";

  await sendOrderMessage(orderId, message);
  db.chatLog.record(orderId, 'sell_online');
  return true;
}

// ── Buy order: paid reminder ────────────────────────────────
// Sent 5 minutes after owner marks a buy order as paid, then every
// 1 minute up to 10 times. Stops on order state change.
async function sendBuyReminder(orderId) {
  const log = db.chatLog.get(orderId, 'buy_reminder');
  const currentCount = log ? log.count : 0;

  if (currentCount >= config.orders.reminderMaxCount) {
    return { sent: false, reason: 'max_reached', count: currentCount };
  }

  const message = 'Payment has been sent. Please confirm receipt and release the USDC. Thank you.';

  await sendOrderMessage(orderId, message);
  db.chatLog.record(orderId, 'buy_reminder');

  return { sent: true, count: currentCount + 1 };
}

// ── Check whether an order is still eligible for reminders ──
// Reminders must stop if the order is completed, cancelled,
// disputed, or no longer waiting for seller release.
async function isOrderReminderEligible(orderId) {
  try {
    const detail = await client.getOrderInfo(orderId);
    const status = Number(detail.status);

    // Only send reminders while waiting for seller to release (status 20)
    // or when buyer marked paid but release hasn't happened.
    // Adjust based on live status values you observe.
    return status === 20;
  } catch (err) {
    // If we can't fetch the order, stop reminders (safer than spamming).
    return false;
  }
}

module.exports = {
  getSessionId,
  sendOrderMessage,
  sendSellOnlineMessage,
  sendBuyReminder,
  isOrderReminderEligible,
};