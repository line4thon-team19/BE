const { getRedis, isRedisReady } = require('../libs/redisClient');
const keys = require('../utils/keys');

const TTL = parseInt(process.env.PRACTICE_SESSION_TTL_SEC || '86400', 10);

async function createPracticeSession(session) { 
  try {
    const redis = await getRedis();
    if (!isRedisReady()) throw new Error('Redis not ready');

    if (!session || !session.sessionId) {
      throw new Error('Invalid session payload');
    }

    const key = keys.practiceSession(session.sessionId);
    const json = JSON.stringify(session);

    await redis.set(key, json, { EX: TTL });
    console.log('[PracticeSession] created:', key);
    return key;
  } catch (err) {
    console.error('[createPracticeSession] error:', err);
    throw err;
  }
}

async function getPracticeSession(sessionId) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');
  const key = keys.practiceSession(sessionId);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function savePracticeSession(session) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');
  if (!session?.sessionId) throw new Error('Invalid session payload');
  const key = keys.practiceSession(session.sessionId);
  await redis.set(key, JSON.stringify(session), { EX: TTL });
  return key;
}

async function deletePracticeSession(sessionId) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');
  if (!sessionId) throw new Error('Invalid sessionId');

  const key = keys.practiceSession(sessionId);
  const deleted = await redis.del(key); // 삭제된 키 개수(0 또는 1)
  console.log('[PracticeSession] deleted:', key, 'count:', deleted);
  return deleted > 0;
}

module.exports = { createPracticeSession, getPracticeSession, savePracticeSession, deletePracticeSession };
