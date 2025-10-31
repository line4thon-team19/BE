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

// 세션 조회
async function getSession(sessionId) {
  const redis = await getRedis();
  const key = keys.battleSession(sessionId);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

// 세션 부분 업데이트
async function updateSession(sessionId, patch) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');

  const key = keys.battleSession(sessionId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const current = JSON.parse(raw);
  const next = { ...current, ...patch };
  await redis.multi().set(key, JSON.stringify(next)).expire(key, TTL).exec();
  return next;
}

async function getSessionIdByRoomCode(roomCode) {
  const redis = await getRedis();
  const sid = await redis.get(keys.battleRoomCode(roomCode));
  return sid || null;
}

module.exports = {
  existsRoomCode,
  createSession,
  getSession,
  updateSession,
  getSessionIdByRoomCode,
};
