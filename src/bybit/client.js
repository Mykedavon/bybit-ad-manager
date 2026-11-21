// src/bybit/client.js
// Wrapper around bybit-p2p-sdk. Normalizes parameters for the SDK.

const { P2P } = require('bybit-p2p-sdk');
const config = require('../config');

const p2p = new P2P({
  apiKey: config.bybit.apiKey,
  apiSecret: config.bybit.apiSecret,
  recvWindow: 30000,
  timeout: 15000,
  testnet: false,
});

const client = {
  // Ads
  getMyAds: () => p2p.getAdsList({ page: '1', size: '20' }),
  getAdInfo: (itemId) => p2p.getAdDetails({ itemId: String(itemId) }),
  updateAd: (params) => p2p.updateAd(params),

  // Get online ads — SDK expects tokenId and size
  getAdsOnline: (params) => {
    const { token, tokenId, limit, size, side, ...rest } = params;
    return p2p.getOnlineAds({
      tokenId: tokenId || token,
      side: String(side),
      size: String(size || limit || 10),
      ...rest,
    });
  },

  // Orders
  getMyOrders: (params) => p2p.getOrders(params),
  getOrderInfo: (orderId) => p2p.getOrderDetails({ orderId: String(orderId) }),

  // Chat
  sendOrderMessage: (params) => p2p.sendChatMessage(params),

  // Wallet
  getWalletBalance: (accountType, coin) => p2p.getCurrentBalance({ accountType, coin }),

  // Order actions
  markOrderPaid: (params) => p2p.markAsPaid(params),
  releaseAssets: (params) => p2p.releaseAssets(params),
};

module.exports = { client };