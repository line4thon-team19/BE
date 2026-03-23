const crypto = require('crypto');
const { getRedis } = require('../libs/redisClient.js');
const keys = require('../utils/keys.js');

const BATTLE_REALTIME_TTL_SEC = 60 * 60 * 2;
const BATTLE_ROUND_DURATION_MS = 30 * 1000;

function getBattleRoomChannel(sessionId) {
  return `battle:room:${sessionId}`;
}

module.exports = {
  BATTLE_ROUND_DURATION_MS,
  getBattleRoomChannel,
  buildBattleAnswerResponse,
  acquireBattleRoundLock,
  releaseBattleRoundLock,
  syncBattleRealtimeState,
  buildAnswerResponse: buildBattleAnswerResponse,
  acquireRoundLock: acquireBattleRoundLock,
  releaseRoundLock: releaseBattleRoundLock,
  syncBattleSessionState: syncBattleRealtimeState,
};

function buildBattleAnswerResponse({
  sessionId,
  roomCode,
  current,
  total,
  hasNext,
  state,
  result,
  winner = null,
  correctAnswer = null,
}) {
  return {
    statusCode: 201,
    data: {
      round: { current, total },
      next: { hasNext },
      sessionId,
      roomCode,
      state,
      result,
      winner,
      correctAnswer,
    },
  };
}

async function acquireBattleRoundLock(sessionId, round, ttlMs = 3000) {
  const r = await getRedis();
  const token = crypto.randomUUID();
  const lockKey = `battle:lock:${sessionId}:round:${round}`;

  const ok = await r.set(lockKey, token, {
    NX: true,
    PX: ttlMs,
  });

  if (!ok) return null;
  return { r, token, lockKey };
}

async function releaseBattleRoundLock(lock) {
  if (!lock) return;

  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  try {
    await lock.r.eval(lua, {
      keys: [lock.lockKey],
      arguments: [lock.token],
    });
  } catch (e) {
    console.warn('[LOCK] release failed:', e?.message || e);
  }
}

// 실시간 판정 기준
async function syncBattleRealtimeState({
  sessionId,
  ended,
  nextRoundNumber,
  perRoundMs,
}) {
  try {
    const r = await getRedis();

    if (ended) {
      await r.hSet(keys.battleSessionState(sessionId), {
        state: 'ENDED',
        roundEndsAt: '',
      });
    } else {
      await r.hSet(keys.battleSessionState(sessionId), {
        state: 'PLAYING',
        roundCurrent: String(nextRoundNumber),
        roundEndsAt: String(Date.now() + perRoundMs),
      });
    }
    await r.expire(keys.battleSessionState(sessionId), BATTLE_REALTIME_TTL_SEC);
  } catch (e) {
    console.warn('[WS] battleSessionState sync failed:', e?.message || e);
  }
}
