const { getRedis } = require('../../libs/redisClient');
const keys = require('../../utils/keys');

async function hmGetArray(client, key, fields) {
  return client.hmGet(key, fields);
}

async function isRoundActive(sessionId, round) {
  const client = await getRedis();
  const key = keys.battleSessionState(sessionId);
  const [state, currentRound, roundEndsAt] = await hmGetArray(client, key, [
    'state',
    'roundCurrent',
    'roundEndsAt',
  ]);

  if (state !== 'PLAYING') return false;
  if (Number(currentRound) !== Number(round)) return false;
  if (roundEndsAt && Date.now() > Number(roundEndsAt)) return false;

  return true;
}

async function saveTypingSnapshot(sessionId, playerId, text) {
  const client = await getRedis();
  const stateKey = keys.battleSessionState(sessionId);
  const typingKey = `${stateKey}:typing:${playerId}`;

  await client.set(typingKey, text, { EX: 5 });
}

async function tickRemainingSec(sessionId) {
  const client = await getRedis();
  const key = keys.battleSessionState(sessionId);
  const [roundEndsAt, currentRound, totalRounds] = await hmGetArray(client, key, [
    'roundEndsAt',
    'roundCurrent',
    'roundTotal',
  ]);

  return {
    remainingSec: roundEndsAt ? Math.ceil((Number(roundEndsAt) - Date.now()) / 1000) : null,
    round: {
      current: Number(currentRound || 0),
      total: Number(totalRounds || 0),
    },
  };
}

async function tryHandleTimeoutOnce(sessionId, round, ttlSec = 5) {
  const client = await getRedis();
  const roundAnswerKey = keys.battleRoundAnswer(sessionId, round);
  const timeoutHandledKey = `${roundAnswerKey}:timeout:handled`;
  const ok = await client.set(timeoutHandledKey, '1', { NX: true, EX: ttlSec });

  return ok === 'OK';
}

module.exports = {
  isRoundActive,
  saveTypingSnapshot,
  tickRemainingSec,
  tryHandleTimeoutOnce,
};
