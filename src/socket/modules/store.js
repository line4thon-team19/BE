const { getRedis } = require('../../libs/redisClient');

const PFX = 'battle:session';

async function hmGetArray(client, key, fields) {
  return client.hmGet(key, fields);
}

async function getSession(sessionId) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}`;
  const data = await client.hGetAll(key); 
  return Object.keys(data || {}).length ? data : null;
}

async function isRoundActive(sessionId, round) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}`;

  const arr = await hmGetArray(client, key, ['state', 'roundCurrent', 'roundEndsAt']);
  const [state, cur, endAt] = arr;

  if (state !== 'PLAYING') return false;
  if (Number(cur) !== Number(round)) return false;
  if (endAt && Date.now() > Number(endAt)) return false;
  return true;
}

async function saveTypingSnapshot(sessionId, playerId, text) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}:typing:${playerId}`;
  await client.set(key, text, { EX: 5 }); // TTL 5초
}

async function getCorrectAnswer(sessionId, round) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}:round:${round}`;
  return (await client.hGet(key, 'answer')) || '';
}

const { normalizeText } = require('./utils');

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

async function judgeAndSave({ sessionId, round, playerId, normalizedAnswer, correctAnswer }) {
  const client = await getRedis();

  const normCorrect = normalizeText(correctAnswer || '');

  let result = 'wrong';
  if (normalizedAnswer === normCorrect) {
    result = 'correct';
  } else {
    const dist = distance(normalizedAnswer, normCorrect);
    const ratio = dist / Math.max(1, normCorrect.length);
    if (ratio <= 0.2) result = 'typo-close';
  }

  const ansKey = `${PFX}:${sessionId}:round:${round}:answer:${playerId}`;
  await client.hSet(ansKey, {
    text: normalizedAnswer,
    result,
    ts: Date.now().toString(),
  });

  const scoreKey = `${PFX}:${sessionId}:score`;
  if (result === 'correct') {
    await client.hIncrBy(scoreKey, `${playerId}:score`, 1);
  } else {
    await client.hIncrBy(scoreKey, `${playerId}:wrong`, 1);
  }

  return { result };
}

async function getScoreSummary(sessionId) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}:score`;
  const all = await client.hGetAll(key);

  const players = new Set(Object.keys(all).map((k) => k.split(':')[0]));
  const out = [];
  for (const pid of players) {
    out.push({
      playerId: pid,
      score: Number(all[`${pid}:score`] || 0),
      wrong: Number(all[`${pid}:wrong`] || 0),
    });
  }
  return out;
}

async function tickRemainingSec(sessionId) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}`;
  const [endAt, cur, total] = await hmGetArray(client, key, [
    'roundEndsAt',
    'roundCurrent',
    'roundTotal',
  ]);
  const remainingSec = endAt ? Math.ceil((Number(endAt) - Date.now()) / 1000) : null;
  return {
    remainingSec,
    round: {
      current: Number(cur || 0),
      total: Number(total || 0),
    },
  };
}

async function tryHandleTimeoutOnce(sessionId, round, ttlSec = 5) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}:round:${round}:timeout:handled`;
  const ok = await client.set(key, '1', { NX: true, EX: ttlSec }); // 1회만 true
  return ok === 'OK';
}

async function getRoundMeta(sessionId) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}`;
  const [cur, total, state] = await client.hmGet(key, ['roundCurrent', 'roundTotal', 'state']);
  return { current: Number(cur || 0), total: Number(total || 0), state };
}

async function setRoundPlaying(sessionId, round, perRoundMs) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}`;
  await client.hSet(key, {
    roundCurrent: String(round),
    roundEndsAt: String(Date.now() + perRoundMs),
    state: 'PLAYING',
  });
}

async function setEnded(sessionId) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}`;
  await client.hSet(key, { state: 'ENDED', roundEndsAt: '' });
}

async function setCorrectFlag(sessionId, round) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}:round:${round}`;
  await client.hSet(key, 'correctFlag', '1');
  await client.expire(key, 60 * 60 * 2);
}

async function markAnswered(sessionId, round, playerId) {
  const client = await getRedis();
  const key = `${PFX}:${sessionId}:round:${round}:answered`;
  await client.sAdd(key, playerId);
  await client.expire(key, 60 * 60 * 2);
  return client.sCard(key);
}

module.exports = {
  getSession,
  isRoundActive,
  saveTypingSnapshot,
  getCorrectAnswer,
  judgeAndSave,
  getScoreSummary,
  tickRemainingSec,
  tryHandleTimeoutOnce,
  getRoundMeta,
  setRoundPlaying,
  setEnded,
  setCorrectFlag,
  markAnswered,
};
