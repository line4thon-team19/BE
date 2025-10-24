const { createClient } = require('redis');

let client;
let ready = false;

async function getRedis() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (e) => console.error('[Redis] Error:', e));
    client.on('ready', () => {
      ready = true;
      console.log('[Redis] connected');
    });
    await client.connect().catch((e) => {
      console.warn('[Redis] connect failed:', e.message);
    });
  }
  return client;
}

function isRedisReady() {
  return ready;
}

module.exports = { getRedis, isRedisReady };
