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

async function getSessionBasicForPlay(sessionId) {
  const s = await getSession(sessionId);
  if (!s) return null;

  const currentRound = Number(s?.round?.current || 1);
  let correctAnswer = s.correctAnswer;
  if (!correctAnswer && Array.isArray(s.questions)) {
    const q = s.questions[currentRound - 1];
    if (q?.correctSentence) correctAnswer = q.correctSentence;
    if (!correctAnswer && q?.text) correctAnswer = q.text;
  }

  return {
    sessionId: s.sessionId,
    status: s.status,
    roomCode: s.roomCode,
    hostId: s.hostId,
    round: s.round || { current: 1, total: 5 },
    correctAnswer: correctAnswer || '',
    deadlineAt: s.deadlineAt || null,
  };
}

// 라운드 별 기록
async function savePlayerAnswer(sessionId, round, playerId, answer) {
  const redis = await getRedis();
  const key = keys.battleAnswerHash(sessionId, round, playerId);
  const ts = Date.now().toString();
  await redis.hSet(key, 'lastAnswer', String(answer ?? ''));
  await redis.hSet(key, 'lastSubmittedAt', ts);
  await redis.pExpire(key, 10 * 60 * 1000); // 10분 보관
}

async function getRoundWinner(sessionId, round) {
  const redis = await getRedis();
  return redis.get(keys.battleRoundWinner(sessionId, round));
}

async function claimRoundWinner(sessionId, round, playerId) {
  const redis = await getRedis();
  const key = keys.battleRoundWinner(sessionId, round);
  const ok = await redis.setNX(key, playerId);
  if (ok) await redis.pExpire(key, 2 * 60 * 1000);
  return !!ok;
}

async function addScore(sessionId, playerId, delta = 1) {
  const redis = await getRedis();
  await redis.hIncrBy(keys.battleScore(sessionId), playerId, delta);
  await redis.expire(keys.battleScore(sessionId), TTL);
}

async function advanceRoundOrEnd(sessionId, { perRoundMs = 0 } = {}) {
  const redis = await getRedis();
  const key = keys.battleSession(sessionId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const s = JSON.parse(raw);
  const cur = Number(s?.round?.current || 1);
  const tot = Number(s?.round?.total || 5);

  // 다음 라운드 존재
  if (cur < tot) {
    const nextRound = cur + 1;
    const deadlineAt = perRoundMs > 0 ? Date.now() + perRoundMs : null;
    const next = {
      ...s,
      round: { current: nextRound, total: tot },
      deadlineAt,
    };
    await redis.multi().set(key, JSON.stringify(next)).expire(key, TTL).exec();
    return { advanced: true, ended: false, nextState: 'playing', nextRound };
  }

  // 마지막 라운드 종료
  const next = {
    ...s,
    status: 'ended',
    endedAt: new Date().toISOString(),
    deadlineAt: null,
  };
  await redis.multi().set(key, JSON.stringify(next)).expire(key, TTL).exec();
  return { advanced: false, ended: true, nextState: 'ended', nextRound: tot };
}

// 세션별 점수 조회
async function getScores(sessionId) {
  const redis = await getRedis();
  const h = await redis.hGetAll(keys.battleScore(sessionId));
  return h || {};
}

module.exports = {
  existsRoomCode,
  createSession,
  getSession,
  updateSession,
  getSessionIdByRoomCode,
  getSessionBasicForPlay,
  savePlayerAnswer,
  getRoundWinner,
  claimRoundWinner,
  addScore,
  advanceRoundOrEnd,
  getScores,
};
