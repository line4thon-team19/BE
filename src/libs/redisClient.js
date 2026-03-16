const { createClient } = require('redis');

let client;
let ready = false;

function buildRedisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  const host =
    process.env.REDIS_HOST ||
    (process.env.NODE_ENV === 'production' ? 'redis' : '127.0.0.1');
  const port = process.env.REDIS_PORT || '6379';

  return `redis://${host}:${port}`;
}

async function getRedis() {
  if (!client) {
    const url = buildRedisUrl();

    client = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => Math.min(1000 + retries * 100, 3000),
      },
    });

    client.on('error', (e) => console.error('[Redis] Error:', e));
    client.on('connect', () => console.log('[Redis] connecting...', url));
    client.on('ready', () => {
      ready = true;
      console.log('[Redis] connected');
    });
    client.on('end', () => {
      ready = false;
      console.warn('[Redis] disconnected');
    });

    try {
      await client.connect();
    } catch (e) {
      console.warn('[Redis] connect failed:', e.message);
    }

    const shutdown = async () => {
      try {
        if (client) await client.quit();
      } catch (e) {
        // noop
      }
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }

  return client;
}

function isRedisReady() {
  return ready;
}

module.exports = { getRedis, isRedisReady };
