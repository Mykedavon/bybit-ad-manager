// src/managers/priceCache.js
// Shared cache for getAdsOnline results. 60s TTL.
// Prevents the buy and sell loops from hammering the rate-limited endpoint.

const { client } = require('../bybit/client');

const cache = new Map();
const TTL_MS = 60000;

async function getOnlineAdsCached(params) {
  const key = `${params.tokenId}:${params.side}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value;
  }
  const value = await client.getAdsOnline(params);
  cache.set(key, { value, at: Date.now() });
  return value;
}

module.exports = { getOnlineAdsCached };