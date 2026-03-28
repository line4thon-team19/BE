const { getRedis, isRedisReady } = require('../libs/redisClient');
const keys = require('../utils/keys');
const { syncBattleRealtimeState } = require('../services/battleHelpers');

const TTL = parseInt(process.env.BATTLE_SESSION_TTL_SEC || '86400', 10);

// Redis 점수 해시를 플레이어별 점수/오답 묶음으로 정리
function buildBattleScoreBoard(rawScoreHash = {}) {
  const scoreBoard = {};

  Object.entries(rawScoreHash).forEach(([field, value]) => {
    const [playerId, kind = 'score'] = field.split(':');

    if (!playerId) return;

    if (!scoreBoard[playerId]) {
      scoreBoard[playerId] = { score: 0, wrong: 0 };
    }

    if (kind === 'wrong') {
      scoreBoard[playerId].wrong += Number(value || 0);
      return;
    }

    scoreBoard[playerId].score += Number(value || 0);
  });

  return scoreBoard;
}

// 방 코드가 이미 다른 세션에 연결되어 있는지 확인
async function existsRoomCode(roomCode) {
  const redis = await getRedis();
  const sid = await redis.get(keys.battleRoomCode(roomCode));
  return Boolean(sid);
}

// 배틀 세션 본문과 방 코드 인덱스를 함께 저장
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

// 배틀 세션 JSON 본문을 조회
async function getSession(sessionId) {
  const redis = await getRedis();
  const key = keys.battleSession(sessionId);
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

// 부분 patch를 기존 세션에 병합해 저장
async function updateSession(sessionId, patch) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');

  const key = keys.battleSession(sessionId);
  const raw = await redis.get(key);
  if (!raw) return null;

  const current = JSON.parse(raw);

  const next = {
    ...current,
    ...patch,
    round: patch.round
      ? {
        ...(current.round || {}),
        ...patch.round,
      }
      : current.round,
    countdown: patch.countdown
      ? {
        ...(current.countdown || {}),
        ...patch.countdown,
      }
      : current.countdown,
  };

  await redis.multi().set(key, JSON.stringify(next)).expire(key, TTL).exec();
  return next;
}

// 방 코드로 세션 ID를 역조회
async function getSessionIdByRoomCode(roomCode) {
  const redis = await getRedis();
  const sid = await redis.get(keys.battleRoomCode(roomCode));
  return sid || null;
}

// 플레이 중 판정에 필요한 최소 세션 정보를 모아 반환
async function getSessionBasicForPlay(sessionId) {
  const s = await getSession(sessionId);
  if (!s) return null;

  const currentRound = Number(s?.round?.current || 1);
  let correctAnswer = s.correctAnswer || '';

  try {
    const redis = await getRedis();
    const redisAns = await redis.hGet(
      keys.battleRoundAnswer(sessionId, currentRound),
      'answer',
    );
    if (redisAns) correctAnswer = redisAns;
  } catch (e) {
    // fallback
  }

  if (!correctAnswer && Array.isArray(s.questions)) {
    const q = s.questions[currentRound - 1];
    if (q?.correctSentence) correctAnswer = q.correctSentence;
    else if (q?.answer) correctAnswer = q.answer;
    else if (q?.text) correctAnswer = q.text;
  }

  return {
    sessionId: s.sessionId,
    status: s.status,
    roomCode: s.roomCode,
    hostId: s.hostId,
    round: {
      current: Number(s?.round?.current || 1),
      total: Number(s?.round?.total || 5),
    },
    correctAnswer: correctAnswer || '',
    deadlineAt: Number(s?.deadlineAt || 0) || null,
  };
}

// 특정 라운드의 마지막 제출 답안과 판정 결과를 저장
async function saveBattleRoundAnswer(sessionId, round, playerId, { answer, result } = {}) {
  const redis = await getRedis();
  const key = keys.battleRoundAnswer(sessionId, round);
  const ts = Date.now().toString();
  const payload = {
    [`lastAnswer:${playerId}`]: String(answer ?? ''),
    [`lastSubmittedAt:${playerId}`]: ts,
  };

  if (typeof result === 'string' && result) {
    payload[`result:${playerId}`] = result;
  }

  await redis.hSet(key, payload);
  await redis.expire(key, TTL);
}

// 특정 플레이어의 라운드별 마지막 제출 내용과 정답 여부를 읽어옵니다.
async function getBattleRoundPlayerAnswer(sessionId, round, playerId) {
  const redis = await getRedis();
  const wsAnswerKey = `${keys.battleRoundAnswer(sessionId, round)}:answer:${playerId}`;
  const wsAnswer = await redis.hGetAll(wsAnswerKey);

  if (wsAnswer && Object.keys(wsAnswer).length) {
    const text = wsAnswer.text ?? null;
    const result = wsAnswer.result ?? null;
    const isCorrect = result === 'correct';

    return {
      lastAnswer: text,
      result,
      isCorrect,
    };
  }

  const [text, result] = await redis.hmGet(keys.battleRoundAnswer(sessionId, round), [
    `lastAnswer:${playerId}`,
    `result:${playerId}`,
  ]);

  return {
    lastAnswer: text ?? null,
    result: result ?? null,
    isCorrect: result === 'correct',
  };
}

// 라운드 승자를 조회
async function getRoundWinner(sessionId, round) {
  const redis = await getRedis();
  return redis.get(keys.battleRoundWinner(sessionId, round));
}

// 아직 승자가 없을 때만 라운드 승자를 선점
async function claimRoundWinner(sessionId, round, playerId) {
  const redis = await getRedis();
  const key = keys.battleRoundWinner(sessionId, round);

  const ok = await redis.set(key, playerId, {
    NX: true,
    EX: TTL,
  });

  return !!ok;
}

// 플레이어 점수를 누적
async function addScore(sessionId, playerId, delta = 1) {
  const redis = await getRedis();
  const scoreKey = keys.battleScore(sessionId);

  await redis.hIncrBy(scoreKey, `${playerId}:score`, delta);
  await redis.expire(scoreKey, TTL);
}

// 플레이어의 오답 제출 횟수를 누적
async function addWrongAttempt(sessionId, playerId, delta = 1) {
  const redis = await getRedis();
  const scoreKey = keys.battleScore(sessionId);

  await redis.hIncrBy(scoreKey, `${playerId}:wrong`, delta);
  await redis.expire(scoreKey, TTL);
}

// 현재 라운드를 다음 라운드로 넘기거나 세션을 종료
async function advanceRoundOrEnd(sessionId, { expectedRound, perRoundMs }) {
  const base = await getSessionBasicForPlay(sessionId);

  if (!base) {
    return {
      ok: false,
      reason: 'SESSION_NOT_FOUND',
      ended: false,
    };
  }

  const status = String(base.status || 'waiting').toLowerCase();
  const currentRound = Number(base?.round?.current || 1);
  const totalRounds = Number(base?.round?.total || 5);

  if (status !== 'playing') {
    return {
      ok: true,
      ended: status === 'ended',
      alreadySettled: true,
      currentRound,
      totalRounds,
      status,
    };
  }

  if (Number(expectedRound) !== currentRound) {
    return {
      ok: true,
      ended: false,
      alreadySettled: true,
      currentRound,
      totalRounds,
      status,
    };
  }

  if (currentRound >= totalRounds) {
    await updateSession(sessionId, {
      status: 'ended',
      deadlineAt: null,
      round: {
        current: currentRound,
        total: totalRounds,
      },
    });

    await syncBattleRealtimeState({
      sessionId,
      ended: true,
      nextRoundNumber: currentRound,
      perRoundMs,
    });

    return {
      ok: true,
      ended: true,
      alreadySettled: false,
      currentRound,
      totalRounds,
      status: 'ended',
    };
  }

  const nextRoundNumber = currentRound + 1;
  const nextDeadlineAt = Date.now() + perRoundMs;

  await updateSession(sessionId, {
    status: 'playing',
    deadlineAt: nextDeadlineAt,
    round: {
      current: nextRoundNumber,
      total: totalRounds,
    },
  });

  await syncBattleRealtimeState({
    sessionId,
    ended: false,
    nextRoundNumber,
    perRoundMs,
  });

  return {
    ok: true,
    ended: false,
    alreadySettled: false,
    currentRound: nextRoundNumber,
    totalRounds,
    status: 'playing',
    deadlineAt: nextDeadlineAt,
  };
}

// 플레이어별 점수만 단순 맵 형태로 반환
async function getScores(sessionId) {
  const redis = await getRedis();
  const h = await redis.hGetAll(keys.battleScore(sessionId));
  if (!h || !Object.keys(h).length) return {};

  const scoreBoard = buildBattleScoreBoard(h);
  const out = {};

  Object.entries(scoreBoard).forEach(([playerId, scoreRow]) => {
    out[playerId] = scoreRow.score;
  });

  return out;
}

// 플레이어별 점수와 오답 횟수를 요약 배열로 반환
// 세션 본문과 관련 보조 키를 한 번에 제거
async function deleteSession(sessionId) {
  const redis = await getRedis();
  if (!isRedisReady()) throw new Error('Redis not ready');

  const key = keys.battleSession(sessionId);
  const raw = await redis.get(key);
  if (!raw) return false;

  const s = JSON.parse(raw);
  const pipeline = redis.multi();

  pipeline.del(key);

  if (s.roomCode) {
    pipeline.del(keys.battleRoomCode(s.roomCode));
  }

  pipeline.del(keys.battleScore(sessionId));
  pipeline.del(keys.battleSessionState(sessionId));

  const totalRounds = Number(s?.round?.total || 0);
  for (let round = 1; round <= totalRounds; round += 1) {
    pipeline.del(keys.battleRoundAnswer(sessionId, round));
    pipeline.del(keys.battleRoundWinner(sessionId, round));
    pipeline.del(`${keys.battleRoundAnswer(sessionId, round)}:answered`);
  }

  await pipeline.exec();
  return true;
}

module.exports = {
  existsRoomCode,
  createSession,
  getSession,
  updateSession,
  getSessionIdByRoomCode,
  getSessionBasicForPlay,
  saveBattleRoundAnswer,
  getBattleRoundPlayerAnswer,
  getRoundWinner,
  claimRoundWinner,
  addScore,
  addWrongAttempt,
  advanceRoundOrEnd,
  getScores,
  deleteSession,
};
