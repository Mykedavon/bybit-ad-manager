// src/bybit/client.js
// Signed HTTP client for Bybit v5 API. Handles HMAC-SHA256 signing,
// rate limiting, and error classification. Every Bybit call goes through here.

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

// ── Rate limiter ─────────────────────────────────────────────
// Bybit default: 10 req/s reads, 5 req/s writes. We stay comfortably under.
const rateState = {
  windowMs: 1000,
  readLimit: 8,
  writeLimit: 4,
  readTimestamps: [],
  writeTimestamps: [],
};

function checkRate(isWrite) {
  const now = Date.now();
  const cutoff = now - rateState.windowMs;
  if (isWrite) {
    rateState.writeTimestamps = rateState.writeTimestamps.filter((t) => t > cutoff);
    if (rateState.writeTimestamps.length >= rateState.writeLimit) {
      throw new BybitError('RATE_LIMITED_LOCAL', 'Local write rate limit hit, backing off', 429);
    }
    rateState.writeTimestamps.push(now);
  } else {
    rateState.readTimestamps = rateState.readTimestamps.filter((t) => t > cutoff);
    if (rateState.readTimestamps.length >= rateState.readLimit) {
      throw new BybitError('RATE_LIMITED_LOCAL', 'Local read rate limit hit, backing off', 429);
    }
    rateState.readTimestamps.push(now);
  }
}

// ── Error class ─────────────────────────────────────────────
class BybitError extends Error {
  constructor(code, message, httpStatus, raw) {
    super(message);
    this.name = 'BybitError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.raw = raw;
  }
}

// ── Signing ─────────────────────────────────────────────────
function sign(apiSecret, timestamp, apiKey, recvWindow, queryString) {
  const payload = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
}

function buildQuery(params) {
  if (!params || Object.keys(params).length === 0) return '';
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

// ── Core request ────────────────────────────────────────────
async function request(method, path, params = {}, isWrite = false) {
  checkRate(isWrite);

  const timestamp = Date.now();
  const recvWindow = 20000;
  const queryString = buildQuery(params);
  const signature = sign(
    config.bybit.apiSecret,
    timestamp,
    config.bybit.apiKey,
    recvWindow,
    queryString
  );

  const url = `${config.bybit.baseUrl}${path}${method === 'GET' && queryString ? '?' + queryString : ''}`;

  const headers = {
    'X-BAPI-API-KEY': config.bybit.apiKey,
    'X-BAPI-TIMESTAMP': String(timestamp),
    'X-BAPI-RECV-WINDOW': String(recvWindow),
    'X-BAPI-SIGN': signature,
    'Content-Type': 'application/json',
  };

  const axiosConfig = {
    method,
    url,
    headers,
    timeout: 15000,
  };

  if (method !== 'GET' && queryString) {
    axiosConfig.data = queryString;
  }

  let response;
  try {
    response = await axios(axiosConfig);
  } catch (err) {
    if (err.response) {
      const body = err.response.data || {};
      throw new BybitError(
        body.retCode || 'HTTP_' + err.response.status,
        body.retMsg || err.message,
        err.response.status,
        body
      );
    }
    throw new BybitError('NETWORK', err.message, 0, null);
  }

  const body = response.data;
  if (body.retCode !== 0) {
    throw new BybitError(body.retCode, body.retMsg, response.status, body);
  }

  return body.result;
}

// ── Public API ──────────────────────────────────────────────
const client = {
  get: (path, params) => request('GET', path, params, false),
  post: (path, params) => request('POST', path, params, true),

  // Convenience wrappers for the endpoints we actually use
  async getServerTime() {
    return client.get('/v5/market/time');
  },

  async getWalletBalance(accountType = 'FUND', coin = null) {
    const params = { accountType };
    if (coin) params.coin = coin;
    return client.get('/v5/asset/transfer/query-account-coins-balance', params);
  },

  async getAdsOnline({ token, side, currencyId = 'NGN', limit = 10 }) {
    // side: 0 = buy ads, 1 = sell ads
    return client.post('/v5/p2p/item/online', {
      tokenId: token,
      side: String(side),
      currencyId,
      size: String(limit),
      page: '1',
    });
  },

  async getMyAds() {
    return client.post('/v5/p2p/item/personal/list', { page: '1', size: '20' });
  },

  async getAdInfo(itemId) {
    return client.post('/v5/p2p/item/info', { itemId: String(itemId) });
  },

  async updateAd(params) {
    return client.post('/v5/p2p/item/update', params);
  },

  async getMyOrders({ side, status, page = 1, size = 50 }) {
    // side: 0 = buy, 1 = sell; status: 10=pending,20=paid,30=appealing,40=cancelled,50=finished
    return client.post('/v5/p2p/order/simplifyList', {
      side: String(side),
      status: String(status),
      page: String(page),
      size: String(size),
    });
  },

  async getOrderInfo(orderId) {
    return client.post('/v5/p2p/order/info', { orderId: String(orderId) });
  },

  async sendOrderMessage({ orderId, message, contentType = 'str' }) {
    return client.post('/v5/p2p/order/message/send', {
      orderId: String(orderId),
      message,
      contentType,
    });
  },

  async markOrderPaid({ orderId, paymentType, useBalance = 0 }) {
    return client.post('/v5/p2p/order/pay', {
      orderId: String(orderId),
      paymentType,
      useBalance: String(useBalance),
    });
  },

  async releaseAssets({ orderId }) {
    return client.post('/v5/p2p/order/finish', { orderId: String(orderId) });
  },
};

module.exports = { client, BybitError };