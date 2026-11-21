// src/managers/override.js
// Auto/Manual toggle state for Buy Ads and Sell Ad.
// Manual = price locked, quantity still managed per the rules.
// State persists in SQLite across restarts.

const db = require('../db/db');

const SCOPES = {
  BUY: 'buy',   // covers all three buy ads
  SELL: 'sell', // covers the one sell ad
};

// ── Check if a scope is in manual mode ──────────────────────
function isManual(scope) {
  return db.override.get(scope);
}

// ── Set mode ────────────────────────────────────────────────
function setMode(scope, manual) {
  db.override.set(scope, manual);
  return isManual(scope);
}

// ── Toggle ──────────────────────────────────────────────────
function toggle(scope) {
  const current = isManual(scope);
  return setMode(scope, !current);
}

// ── Price-edit gate ─────────────────────────────────────────
// Every place that wants to change an ad's price must call this first.
// Returns { allowed: boolean, reason: string }
function canEditPrice(scope) {
  if (isManual(scope)) {
    return { allowed: false, reason: 'manual_override_active' };
  }
  return { allowed: true };
}

// ── Quantity-edit gate ──────────────────────────────────────
// Quantity edits are always allowed — even in manual mode.
// This function exists so the intent is explicit in code.
function canEditQuantity(scope) {
  return { allowed: true };
}

// ── Status labels for Telegram buttons ─────────────────────
function statusLabel(scope) {
  const manual = isManual(scope);
  const name = scope === SCOPES.BUY ? 'Buy Ads' : 'Sell Ad';
  return `${name}: ${manual ? 'Manual (price locked)' : 'Auto'}`;
}

// ── Full snapshot for panel display ────────────────────────
function snapshot() {
  return {
    buy: { manual: isManual(SCOPES.BUY), label: statusLabel(SCOPES.BUY) },
    sell: { manual: isManual(SCOPES.SELL), label: statusLabel(SCOPES.SELL) },
  };
}

module.exports = {
  SCOPES,
  isManual,
  setMode,
  toggle,
  canEditPrice,
  canEditQuantity,
  statusLabel,
  snapshot,
};