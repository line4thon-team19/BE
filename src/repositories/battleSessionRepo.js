const { getRedis, isRedisReady } = require('../libs/redisClient');
const keys = require('../utils/keys');

const TTL = parseInt(process.env.BATTLE_SESSION_TTL_SEC || '86400', 10);

// 고유 roomCode 여부 검사
async function existsRoomCode(roomCode) {
  const redis = await getRedis();
  const sid = await redis.get(keys.battleRoomCode(roomCode));
  return Boolean(sid);
}

// 세션 생성(세션 JSON + 룸코드 인덱스 저장)
async function createSession(session) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');

  const key = keys.battleSession(session.sessionId);
  const idx = keys.battleRoomCode(session.roomCode);
  const data = JSON.stringify(session);

  const pipeline = redis.multi();
  pipeline.set(key, data);
  pipeline.expire(key, TTL);
  pipeline.set(idx, session.sessionId);
  pipeline.expire(idx, TTL);
  await pipeline.exec();

  return session;
}

module.exports = { existsRoomCode, createSession };
