const mysql = require('mysql2/promise');

let pool;
let ready = false;

function buildMysqlConfig() {
  if (process.env.MYSQL_URL) return process.env.MYSQL_URL;

  const host =
    process.env.MYSQL_HOST ||
    (process.env.NODE_ENV === 'production' ? 'mysql' : '127.0.0.1');

  return {
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DB || 'app',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_LIMIT || 10),
    queueLimit: 0,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    timezone: 'Z',
  };
}

async function getMysql() {
  if (!pool) {
    const cfg = buildMysqlConfig();
    console.log(
      '[MySQL] connecting with:',
      typeof cfg === 'string'
        ? cfg
        : { ...cfg, password: cfg.password ? '***' : '' } 
    );

    pool = mysql.createPool(cfg);

    try {
      await pool.query('SELECT 1');
      ready = true;
      console.log('[MySQL] ready');
    } catch (e) {
      console.error('[MySQL] connect failed', e.message);
    }

    const shutdown = async () => {
      try {
        if (pool) {
          console.log('[MySQL] shutting down...');
          await pool.end();
          console.log('[MySQL] closed');
        }
      } catch (e) {
        console.error('[MySQL] shutdown error:', e.message);
      }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
  return pool;
}

function isMysqlReady() {
  return ready;
}

async function withTransaction(fn) {
  const p = await getMysql();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try { await conn.rollback(); } catch {
        console.error('[MySQL] rollback failed:', e.message);
    }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { getMysql, isMysqlReady, withTransaction };
