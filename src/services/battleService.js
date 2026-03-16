const { genRoomCode, newBattleSessionId } = require('../utils/id');
const keys = require('../utils/keys');

const {
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
  deleteSession,
} = require('../repositories/battleSessionRepo');

const { getRandomBattleQuestions } = require('../repositories/battleQuestionRepo');
const { getRedis } = require('../libs/redisClient');

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://hyunseoko.store';

const ROOM = (sessionId) => `battle:room:${sessionId}`;
const PFX = 'battle:session';

const normalizeText = (s) =>
  String(s || '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/[\s\u200B-\u200D\uFEFF]/g, ' ')
  .replace(/\s+/g, ' ');

const toSTATE = (status) => String(status || '').toUpperCase();
const PER_ROUND_MS = 30 * 1000;

const getLastAnswerFromRedis = async (redisClient, sessId, roundNo, playerId) => {
  const wsKey = `${PFX}:${sessId}:round:${roundNo}:answer:${playerId}`;
  const wsAll = await redisClient.hGetAll(wsKey);

  if (wsAll && Object.keys(wsAll).length) {
    const text = wsAll.text ?? null;
    const result = wsAll.result ?? null;
    const isCorrect = result === 'correct';
    return { lastAnswer: text, isCorrect };
  }

  const restKey = keys.battleRoundAnswer(sessId, roundNo);
  const [text, result] = await redisClient.hmGet(restKey, [
    `lastAnswer:${playerId}`,
    `result:${playerId}`,
  ]);

  const isCorrect = result === 'correct';
  return { lastAnswer: text ?? null, isCorrect: !!(text && isCorrect) };
};

/** 방 생성(방장) */
async function createRoom({ body, user }) {
  try {
    const forbidden = ['state', 'round', 'status'];
    const hasForbidden = Object.keys(body || {}).some((k) => forbidden.includes(k));

    if (hasForbidden) {
      return {
        statusCode: 400,
        data: {
          message: 'Forbidden fields: cannot include state/round/status in creation',
        },
      };
    }

    let roomCode = genRoomCode();
    for (let i = 0; i < 5 && (await existsRoomCode(roomCode)); i += 1) {
      roomCode = genRoomCode();
    }

    if (await existsRoomCode(roomCode)) {
      return {
        statusCode: 500,
        data: { message: 'Failed to allocate unique roomCode' },
      };
    }

    const sessionId = newBattleSessionId();
    const hostId = user.playerId;
    const status = 'waiting';
    const inviteLink = `${APP_BASE_URL}/join/${roomCode}`;

    const session = {
      sessionId,
      roomCode,
      status,
      hostId,
      inviteLink,
      createdAt: new Date().toISOString(),
    };

    await createSession(session);

    const r = await getRedis();
    await r.hSet(keys.battleSessionState(sessionId), {
      state: 'WAITING',
      hostId,
      roomCode,
      roundCurrent: '1',
      roundTotal: '5',
      roundEndsAt: '',
    });

    await r.expire(keys.battleSessionState(sessionId), 60 * 60 * 2);
    await r.set(keys.battleRoomCode(roomCode), sessionId, { EX: 60 * 60 * 2 });

    return {
      statusCode: 201,
      data: {
        sessionId,
        roomCode,
        status,
        hostId,
        inviteLink,
      },
    };
  } catch (err) {
    console.error('[POST /api/battle/rooms] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

/** 카운트다운 시작 (방장만) */
async function startCountdown({ sessionId, body, user, io }) {
  try {
    const countdownSec = Number(body?.countdownSec ?? 3);
    if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 30) {
      return {
        statusCode: 400,
        data: { message: 'countdownSec must be integer 0~30' },
      };
    }

    const session = await getSession(sessionId);
    if (!session) {
      return {
        statusCode: 404,
        data: { message: 'Session not found' },
      };
    }

    if (user.playerId !== session.hostId) {
      return {
        statusCode: 403,
        data: { message: '방장만 카운트다운을 시작할 수 있습니다.' },
      };
    }

    const playersArr = Array.isArray(session.players) ? session.players : [];
    const normalizedPlayers =
      playersArr.length > 0
        ? playersArr
        : session.hostId
          ? [{ playerId: session.hostId, isHost: true }]
          : [];

    if (normalizedPlayers.length < 2) {
      return {
        statusCode: 409,
        data: { message: '상대 플레이어 입장 후 시작할 수 있습니다.' },
      };
    }

    if (session.status !== 'waiting') {
      return {
        statusCode: 409,
        data: { message: `'${session.status}'일 때는 시작할 수 없습니다.` },
      };
    }

    if (session.countdown?.inProgress) {
      return {
        statusCode: 409,
        data: { message: '카운트다운이 이미 시작되었습니다.' },
      };
    }

    const questions = await getRandomBattleQuestions(5);
    const uniq = Array.from(new Map(questions.map((q) => [q.id, q])).values());
    if (uniq.length < 5) {
      return {
        statusCode: 422,
        data: { message: '문제가 5개 이상 필요합니다.' },
      };
    }

    const nowIso = new Date().toISOString();
    const round = session.round ?? { current: 1, total: 5 };

    const patched = await updateSession(sessionId, {
      countdown: { seconds: countdownSec, startedAt: nowIso, inProgress: true },
      questions,
      round: session.round ?? { current: 1, total: 5 },
    });

    if (!patched) {
      return {
        statusCode: 500,
        data: { message: 'Failed to update session' },
      };
    }

    const r = await getRedis();
    await r.hSet(keys.battleSessionState(sessionId), {
      state: 'WAITING',
      roundCurrent: String(session.round?.current ?? 1),
      roundTotal: String(session.round?.total ?? 5),
      roundEndsAt: '',
    });

    for (let i = 0; i < questions.length; i++) {
      const roundNo = i + 1;
      const q = questions[i];
      const rawAnswer = q.correctSentence ?? q.answer ?? q.text ?? '';
      await r.hSet(keys.battleRoundAnswer(sessionId, roundNo), {
        answer: normalizeText(rawAnswer),
      });
      await r.expire(keys.battleRoundAnswer(sessionId, roundNo), 60 * 60 * 2);
    }

    setTimeout(async () => {
      try {
        const cur = await getSession(sessionId);
        if (!cur || cur.status !== 'waiting' || !cur.countdown?.inProgress) return;

        await updateSession(sessionId, {
          status: 'playing',
          startedAt: new Date().toISOString(),
          countdown: { ...cur.countdown, inProgress: false },
          deadlineAt: Date.now() + PER_ROUND_MS,
        });

        const r = await getRedis();
        await r.hSet(keys.battleSessionState(sessionId), {
          state: 'PLAYING',
          roundEndsAt: String(Date.now() + PER_ROUND_MS),
        });

        if (io) {
          io.to(ROOM(sessionId)).emit('battle:round:next', {
            round: { current: 1, total: 5 },
            remainingSec: Math.ceil(PER_ROUND_MS / 1000),
          });
        }
      } catch (e) {
        console.error(`[COUNTDOWN -> PLAYING] failed for ${sessionId}:`, e);
      }
    }, countdownSec * 1000);

    return {
      statusCode: 200,
      data: {
        started: true,
        status: 'waiting',
        countdown: { seconds: countdownSec },
        round,
        questions,
      },
    };
  } catch (err) {
    console.error('[POST /api/battle/:sessionId/start] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

/** 입장: roomCode만 받음 */
async function entryRoom({ body, user, io }) {
  try {
    const { roomCode } = body || {};
    if (!roomCode) {
      return {
        statusCode: 400,
        data: { message: 'roomCode is required' },
      };
    }

    const sessionId = await getSessionIdByRoomCode(roomCode);
    if (!sessionId) {
      return {
        statusCode: 404,
        data: { code: '404_ROOM_NOT_FOUND', message: 'Room not found' },
      };
    }

    const session = await getSession(sessionId);
    if (!session) {
      return {
        statusCode: 404,
        data: { code: '404_ROOM_NOT_FOUND', message: 'Room not found' },
      };
    }

    if (session.status !== 'waiting') {
      return {
        statusCode: 423,
        data: { code: '423_ROOM_LOCKED', message: 'Room is not in waiting state' },
      };
    }

    let players = Array.isArray(session.players) ? session.players.slice() : [];
    let seeded = false;
    if (players.length === 0 && session.hostId) {
      players.push({ playerId: session.hostId, isHost: true });
      seeded = true;
    }

    const me = user.playerId;

    if (me === session.hostId) {
      if (seeded) {
        await updateSession(sessionId, { players });
      }

      return {
        statusCode: 200,
        data: {
          sessionId,
          roomCode: session.roomCode,
          state: 'WAITING',
          players,
        },
      };
    }

    if (players.some((p) => p.playerId === me)) {
      return {
        statusCode: 200,
        data: {
          sessionId,
          roomCode: session.roomCode,
          state: 'WAITING',
          players,
        },
      };
    }

    if (players.length >= 2) {
      return {
        statusCode: 409,
        data: { code: '409_ROOM_FULL', message: 'Room already has 2 players' },
      };
    }

    players.push({ playerId: me, isHost: false });

    const patched = await updateSession(sessionId, { players });
    if (!patched) {
      return {
        statusCode: 500,
        data: { message: 'Failed to update session' },
      };
    }

    try {
      if (io) {
        console.log(`[WS] Emitting 'battle:player_joined' to room=${sessionId}`);
        console.log(
          `[WS] Players:`,
          patched.players.map((p) => `${p.playerId}${p.isHost ? '(host)' : ''}`).join(', '),
        );

        io.to(ROOM(sessionId)).emit('battle:player_joined', {
          sessionId,
          roomCode: patched.roomCode,
          players: patched.players,
        });

        console.log('[WS] Emit success: battle:player_joined');
      }
    } catch (e) {
      console.warn('[WS] emit battle:player_joined failed:', e.message);
    }

    return {
      statusCode: 200,
      data: {
        sessionId,
        roomCode: patched.roomCode,
        state: 'WAITING',
        players: patched.players,
      },
    };
  } catch (err) {
    console.error('[POST /api/battle/entry] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

/** 정답 제출 */
async function submitAnswer({ sessionId, body, user }) {
  try {
    const { round, answer } = body || {};
    const playerId = user?.playerId;

    if (!playerId) {
      return {
        statusCode: 401,
        data: { message: 'Unauthorized' },
      };
    }

    if (!sessionId) {
      return {
        statusCode: 400,
        data: { message: 'Invalid sessionId' },
      };
    }

    if (typeof round !== 'number' || typeof answer !== 'string' || !answer.trim()) {
      return {
        statusCode: 400,
        data: { message: 'round(number) and answer(string) are required' },
      };
    }

    const base = await getSessionBasicForPlay(sessionId);
    if (!base) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    const { status, roomCode, round: sessRound, correctAnswer, deadlineAt } = base;
    if (status !== 'playing') {
      return {
        statusCode: 409,
        data: { message: 'Session is not in playing state' },
      };
    }

    const currentRound = Number(sessRound?.current || 1);
    const totalRounds = Number(sessRound?.total || 5);

    if (round !== currentRound) {
      return {
        statusCode: 409,
        data: { message: 'Round mismatch' },
      };
    }

    const now = Date.now();
    if (deadlineAt && Number(deadlineAt) > 0 && now > Number(deadlineAt)) {
      const moved = await advanceRoundOrEnd(sessionId, { perRoundMs: PER_ROUND_MS });
      const hasNext = !moved?.ended && currentRound < totalRounds;
      const nextRoundNumber = Math.min(currentRound + 1, totalRounds);

      try {
        const r = await getRedis();
        if (moved?.ended) {
          await r.hSet(keys.battleSessionState(sessionId), {
            state: 'ENDED',
            roundEndsAt: '',
          });
        } else {
          await r.hSet(keys.battleSessionState(sessionId), {
            roundCurrent: String(nextRoundNumber),
            roundEndsAt: String(Date.now() + PER_ROUND_MS),
          });
        }
      } catch (e) {
        console.warn('[WS] round timeout redis update failed:', e?.message || e);
      }

      return {
        statusCode: 201,
        data: {
          round: { current: nextRoundNumber, total: totalRounds },
          next: { hasNext },
          sessionId,
          roomCode,
          state: moved?.ended ? 'ENDED' : 'PLAYING',
          result: 'timeout',
          winner: null,
          correctAnswer,
        },
      };
    }

    await savePlayerAnswer(sessionId, currentRound, playerId, answer);

    const roundWinner = await getRoundWinner(sessionId, currentRound);
    if (roundWinner) {
      const hasNext = currentRound < totalRounds;
      const nextRoundNumber = Math.min(currentRound + 1, totalRounds);

      return {
        statusCode: 201,
        data: {
          round: { current: nextRoundNumber, total: totalRounds },
          next: { hasNext },
          sessionId,
          roomCode,
          state: hasNext ? 'PLAYING' : 'ENDED',
          result: 'timeout',
          winner: roundWinner,
          correctAnswer,
        },
      };
    }

    const isCorrect = normalizeText(answer) === normalizeText(correctAnswer);

    if (!isCorrect) {
      return {
        statusCode: 201,
        data: {
          round: { current: currentRound, total: totalRounds },
          next: { hasNext: false },
          sessionId,
          roomCode,
          state: toSTATE(status),
          result: 'wrong',
          winner: null,
          correctAnswer: null,
        },
      };
    }

    const claimed = await claimRoundWinner(sessionId, currentRound, playerId);
    if (!claimed) {
      const w = await getRoundWinner(sessionId, currentRound);
      const hasNext = currentRound < totalRounds;
      const nextRoundNumber = Math.min(currentRound + 1, totalRounds);

      return {
        statusCode: 201,
        data: {
          round: { current: nextRoundNumber, total: totalRounds },
          next: { hasNext },
          sessionId,
          roomCode,
          state: hasNext ? 'PLAYING' : 'ENDED',
          result: 'timeout',
          winner: w,
          correctAnswer,
        },
      };
    }

    await addScore(sessionId, playerId, 1);
    const moved = await advanceRoundOrEnd(sessionId, { perRoundMs: PER_ROUND_MS });
    const hasNext = !moved?.ended && currentRound < totalRounds;
    const nextRoundNumber = Math.min(currentRound + 1, totalRounds);

    try {
      const r = await getRedis();
      if (moved?.ended) {
        await r.hSet(keys.battleSessionState(sessionId), {
          state: 'ENDED',
          roundEndsAt: '',
        });
      } else {
        await r.hSet(keys.battleSessionState(sessionId), {
          roundCurrent: String(nextRoundNumber),
          roundEndsAt: String(Date.now() + PER_ROUND_MS),
        });
      }
    } catch (e) {
      console.warn('[WS] round advance redis update failed:', e?.message || e);
    }

    return {
      statusCode: 201,
      data: {
        round: { current: nextRoundNumber, total: totalRounds },
        next: { hasNext },
        sessionId,
        roomCode,
        state: moved?.ended ? 'ENDED' : 'PLAYING',
        result: 'correct',
        winner: playerId,
        correctAnswer,
      },
    };
  } catch (err) {
    console.error('[POST /api/battle/:sessionId/answer] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

/** 배틀 결과 조회 */
async function getBattleResult({ sessionId, user }) {
  try {
    const you = user?.playerId || null;

    const session = await getSession(sessionId);
    if (!session) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    let players = Array.isArray(session.players) ? session.players.slice() : [];
    if (!players.length && session.hostId) {
      players = [{ playerId: session.hostId, isHost: true }];
    }
    if (session.guestId && !players.some((p) => p.playerId === session.guestId)) {
      players.push({ playerId: session.guestId, isHost: false });
    }
    if (!players.length) {
      return {
        statusCode: 404,
        data: { message: 'Players not found in session' },
      };
    }

    const totalRounds = Number(session?.round?.total || session?.questions?.length || 0 || 5);

    const scoreMap = await getScores(sessionId);
    const scoreById = (pid) => Number(scoreMap[pid] ?? 0);

    const fullSummary = players.map((p) => {
      const score = scoreById(p.playerId);
      return {
        playerId: p.playerId,
        isHost: !!p.isHost,
        score,
        wrong: Math.max(totalRounds - score, 0),
      };
    });
    const summary = you ? fullSummary.filter((s) => s.playerId === you) : fullSummary;

    const redis = await getRedis();

    const rounds = [];
    for (let r = 1; r <= totalRounds; r++) {
      const q = session?.questions?.[r - 1] || {};
      const playersOut = [];

      if (you) {
        const { lastAnswer, isCorrect } = await getLastAnswerFromRedis(redis, sessionId, r, you);
        playersOut.push({
          playerId: you,
          isCorrect,
          lastAnswer,
        });
      } else {
        for (const p of players) {
          const { lastAnswer, isCorrect } = await getLastAnswerFromRedis(
            redis,
            sessionId,
            r,
            p.playerId,
          );
          playersOut.push({ playerId: p.playerId, isCorrect, lastAnswer });
        }
      }

      const winnerForRound = await getRoundWinner(sessionId, r);

      rounds.push({
        round: r,
        question: {
          questionId: q.id ?? q.questionId ?? (typeof q.id === 'number' ? String(q.id) : String(r)),
          text: q.text ?? q.correctSentence ?? q.answer ?? null,
          wrongText: q.wrongText ?? q.wrongSentence ?? null,
          explanation: q.explanation ?? null,
        },
        players: playersOut,
        winner: winnerForRound || null,
      });
    }

    let winnerPlayerId = null;
    const host = fullSummary.find((s) => s.isHost);
    const guest = fullSummary.find((s) => !s.isHost);
    if (host && guest) {
      if (host.score !== guest.score) {
        winnerPlayerId = host.score > guest.score ? host.playerId : guest.playerId;
      } else {
        const hostWins = rounds.filter((rd) => rd.winner === host.playerId).length;
        const guestWins = rounds.filter((rd) => rd.winner === guest.playerId).length;
        if (hostWins !== guestWins) {
          winnerPlayerId = hostWins > guestWins ? host.playerId : guest.playerId;
        } else {
          winnerPlayerId = null;
        }
      }
    }

    let result = null;

    if (you) {
      if (!winnerPlayerId) {
        result = 'tie';
      } else {
        result = you === winnerPlayerId ? 'win' : 'lose';
      }
    }

    return {
      statusCode: 200,
      data: {
        state: (session.status || 'ended').toUpperCase(),
        result,
        summary,
        rounds,
      },
    };
  } catch (err) {
    console.error('[GET /api/battle/:sessionId/result] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

/** 배틀룸 조회 */
async function getBattleRoom({ sessionId }) {
  try {
    const session = await getSession(sessionId);

    if (!session) {
      return {
        statusCode: 404,
        data: { code: '404_ROOM_NOT_FOUND', message: 'Room not found' },
      };
    }

    let players = Array.isArray(session.players) ? session.players.slice() : [];
    if (!players.length && session.hostId) {
      players.push({ playerId: session.hostId, isHost: true });
    }
    if (session.guestId && !players.some((p) => p.playerId === session.guestId)) {
      players.push({ playerId: session.guestId, isHost: false });
    }

    const base = await getSessionBasicForPlay(sessionId);

    let status = String(base?.status || session.status || 'ended').toUpperCase();
    const hostId = base?.hostId || session.hostId || null;
    const round = base?.round || session.round || { current: 1, total: 5 };

    let currentRound = Number(round.current || 1);
    let totalRounds = Number(round.total || session?.questions?.length || 5);
    let deadlineFromState = null;

    try {
      const r = await getRedis();
      const [stCur, stTot, stState, stEndAt] = await r.hmGet(keys.battleSessionState(sessionId), [
        'roundCurrent',
        'roundTotal',
        'state',
        'roundEndsAt',
      ]);

      if (stCur) currentRound = Number(stCur);
      if (stTot) totalRounds = Number(stTot);
      if (stState) status = String(stState).toUpperCase();
      if (stEndAt) deadlineFromState = Number(stEndAt);

      round.current = currentRound;
      round.total = totalRounds;
    } catch (e) {
      console.warn('[GET /api/battle/:sessionId] sync with WS state failed:', e?.message || e);
    }

    const scoreMap = await getScores(sessionId);
    const scoreById = (pid) => Number(scoreMap?.[pid] ?? 0);

    if (!players.length) {
      if (hostId) players = [{ playerId: hostId, isHost: true }];
    }

    const now = Date.now();
    const deadline = deadlineFromState ?? Number(base?.deadlineAt ?? session.deadlineAt ?? 0);

    const completedRounds =
      status === 'PLAYING' ? Math.max(0, currentRound - 1) : Number(totalRounds);

    const winners = new Array(totalRounds + 1).fill(null);
    if (completedRounds > 0) {
      const winnerList = await Promise.all(
        Array.from({ length: completedRounds }, (_, i) => getRoundWinner(sessionId, i + 1)),
      );
      for (let i = 0; i < winnerList.length; i += 1) {
        winners[i + 1] = winnerList[i] || null;
      }
    }

    const summary = players.map((p) => {
      const score = scoreById(p.playerId);
      const perRound = [];
      for (let r = 1; r <= totalRounds; r += 1) {
        if (r > completedRounds) {
          perRound.push(null);
        } else {
          const w = winners[r];
          perRound.push(w ? w === p.playerId : false);
        }
      }

      const wrong = Math.max(completedRounds - score, 0);

      return {
        playerId: p.playerId,
        isHost: !!p.isHost,
        score,
        wrong,
        isCorrectByRound: perRound,
      };
    });

    let question = null;
    if (status === 'PLAYING') {
      const idx = Math.max(0, currentRound - 1);
      const q = Array.isArray(session.questions) ? session.questions[idx] : null;
      if (q) {
        const questionId = q.questionId ?? q.id ?? (typeof q.id === 'number' ? String(q.id) : null);
        const text = q.text ?? q.correctSentence ?? q.answer ?? null;
        if (questionId && text) {
          question = { questionId, text };
        }
      }
    }

    if (status === 'PLAYING' && deadline && now > deadline) {
      try {
        const moved = await advanceRoundOrEnd(sessionId, { perRoundMs: PER_ROUND_MS });
        const r = await getRedis();

        if (moved?.ended) {
          await r.hSet(keys.battleSessionState(sessionId), { state: 'ENDED', roundEndsAt: '' });
          round.current = Number(round.total || totalRounds);
          status = 'ENDED';
        } else {
          const nextRound = Math.min(currentRound + 1, totalRounds);
          await r.hSet(keys.battleSessionState(sessionId), {
            roundCurrent: String(nextRound),
            roundEndsAt: String(Date.now() + PER_ROUND_MS),
          });
          round.current = nextRound;
        }
      } catch (e) {
        console.warn('[GET timeout advance] failed:', e?.message || e);
      }
    }

    const remainingTime =
      status === 'PLAYING' && deadline > now ? Math.ceil((deadline - now) / 1000) : 0;

    return {
      statusCode: 200,
      data: {
        status,
        hostId,
        round: {
          current: Number(round.current || currentRound || 1),
          total: Number(round.total || totalRounds),
        },
        question,
        summary,
        remainingTime,
      },
    };
  } catch (err) {
    console.error('[GET /api/battle/:sessionId] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

/** 배틀룸 삭제 */
async function deleteBattleRoom({ sessionId }) {
  try {
    const session = await getSession(sessionId);

    if (!session) {
      return {
        statusCode: 404,
        data: { code: '404_ROOM_NOT_FOUND', message: 'Room not found' },
      };
    }

    const deleted = await deleteSession(sessionId);

    if (!deleted) {
      return {
        statusCode: 404,
        data: { code: '404_ROOM_NOT_FOUND', message: 'Room not found' },
      };
    }

    return {
      statusCode: 200,
      data: {
        deleted: true,
        sessionId,
        message: 'Battle session deleted',
      },
    };
  } catch (err) {
    console.error('[DELETE /api/battle/:sessionId/delete] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

module.exports = {
  createRoom,
  startCountdown,
  entryRoom,
  submitAnswer,
  getBattleResult,
  getBattleRoom,
  deleteBattleRoom,
};