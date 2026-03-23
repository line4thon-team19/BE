const { genRoomCode, newBattleSessionId } = require('../utils/id');
const keys = require('../utils/keys');
const { normalizeText } = require('../utils/text');

const {
  BATTLE_ROUND_DURATION_MS,
  getBattleRoomChannel,
  buildBattleAnswerResponse,
  acquireBattleRoundLock,
  releaseBattleRoundLock,
} = require('./battleHelpers');

const {
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
} = require('../repositories/battleSessionRepo');

const { getRandomBattleQuestions } = require('../repositories/battleQuestionRepo');
const { getRedis } = require('../libs/redisClient');

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://hyunseoko.store';

const toSTATE = (status) => String(status || '').toUpperCase();

// 배틀룸 조회 결과(소켓에서 재사용할 수 있게)
async function getBattleRoomSnapshot({ sessionId }) {
  const result = await getBattleRoom({ sessionId });

  if (result.statusCode !== 200) {
    throw new Error(result.data?.message || 'Session not found or expired');
  }

  return result.data;
}

// 소켓 제출 payload를 REST 서비스 입력 형식으로 제출
async function submitBattleAnswerAttempt({ sessionId, round, answerText, playerId }) {
  return submitAnswer({
    sessionId,
    body: {
      round,
      answer: answerText,
    },
    user: {
      playerId,
    },
  });
}

// 배틀룸을 생성(방장 기준)
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

// 카운트다운 시작(방장만 가능)
async function startCountdown({ sessionId, body, user, io }) {
  try {
    const countdownSec = Math.max(1, Math.min(10, Number(body?.seconds || 3)));

    const session = await getSession(sessionId);
    if (!session) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    if (session.hostId !== user?.playerId) {
      return {
        statusCode: 403,
        data: { message: 'Only host can start countdown' },
      };
    }

    if (String(session.status || '').toLowerCase() !== 'waiting') {
      return {
        statusCode: 409,
        data: { message: 'Session is not in waiting state' },
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

    const totalRounds = uniq.length;
    const nowIso = new Date().toISOString();
    const round = { current: 1, total: totalRounds };

    const patched = await updateSession(sessionId, {
      countdown: {
        seconds: countdownSec,
        startedAt: nowIso,
        inProgress: true,
      },
      questions: uniq,
      round,
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
      roundCurrent: '1',
      roundTotal: String(totalRounds),
      roundEndsAt: '',
    });
    await r.expire(keys.battleSessionState(sessionId), 60 * 60 * 2);

    for (let i = 0; i < uniq.length; i += 1) {
      const roundNo = i + 1;
      const q = uniq[i];
      const rawAnswer = q.correctSentence ?? q.answer ?? q.text ?? '';

      await r.hSet(keys.battleRoundAnswer(sessionId, roundNo), {
        answer: normalizeText(rawAnswer),
      });
      await r.expire(keys.battleRoundAnswer(sessionId, roundNo), 60 * 60 * 2);
    }

    if (io) {
      io.to(getBattleRoomChannel(sessionId)).emit('battle:countdown', {
        seconds: countdownSec,
        startedAt: nowIso,
      });
    }

    setTimeout(async () => {
      try {
        const latest = await getSession(sessionId);
        if (!latest) return;

        if (String(latest.status || '').toLowerCase() !== 'waiting') return;

        const roundTotal = Number(latest?.round?.total || totalRounds);
        const deadlineAt = Date.now() + BATTLE_ROUND_DURATION_MS;

        await updateSession(sessionId, {
          status: 'playing',
          deadlineAt,
          countdown: {
            ...(latest.countdown || {}),
            inProgress: false,
          },
          round: {
            current: 1,
            total: roundTotal,
          },
        });

        const redis = await getRedis();
        await redis.hSet(keys.battleSessionState(sessionId), {
          state: 'PLAYING',
          roundCurrent: '1',
          roundTotal: String(roundTotal),
          roundEndsAt: String(deadlineAt),
        });
        await redis.expire(keys.battleSessionState(sessionId), 60 * 60 * 2);

        if (io) {
          io.to(getBattleRoomChannel(sessionId)).emit('battle:started', {
            sessionId,
            state: 'PLAYING',
          });

          io.to(getBattleRoomChannel(sessionId)).emit('battle:round:next', {
            round: { current: 1, total: roundTotal },
            remainingSec: Math.ceil(BATTLE_ROUND_DURATION_MS / 1000),
          });
        }
      } catch (e) {
        console.error('[startCountdown setTimeout] error:', e);
      }
    }, countdownSec * 1000);

    return {
      statusCode: 200,
      data: {
        sessionId,
        countdown: {
          seconds: countdownSec,
          startedAt: nowIso,
        },
        round,
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

// 배틀룸 입장 - 상대방(RoomCode로)
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

        io.to(getBattleRoomChannel(sessionId)).emit('battle:player_joined', {
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

// 정답 제출(점수 반영, 다음 라운드 진행까지)
async function submitAnswer({ sessionId, body, user }) {
  let roundLock = null;

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

    // 1차 조회
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
    const isTimeout = deadlineAt && Number(deadlineAt) > 0 && now > Number(deadlineAt);
    const isCorrect = normalizeText(answer) === normalizeText(correctAnswer);

    // 오답, 시간 초과 X
    if (!isTimeout && !isCorrect) {
      await saveBattleRoundAnswer(sessionId, currentRound, playerId, {
        answer,
        result: 'wrong',
      });
      await addWrongAttempt(sessionId, playerId, 1);

      return buildBattleAnswerResponse({
        sessionId,
        roomCode,
        current: currentRound,
        total: totalRounds,
        hasNext: false,
        state: toSTATE(status),
        result: 'wrong',
        winner: null,
        correctAnswer: null,
      });
    }

    // 라운드 종료 판정 락
    roundLock = await acquireBattleRoundLock(sessionId, currentRound, 3000);

    if (!roundLock) {
      const latest = await getSessionBasicForPlay(sessionId);
      const winner = await getRoundWinner(sessionId, currentRound);

      if (!latest) {
        return {
          statusCode: 404,
          data: { message: 'Session not found or expired' },
        };
      }

      const latestStatus = latest.status;
      const latestRound = Number(latest.round?.current || currentRound);
      const latestTotal = Number(latest.round?.total || totalRounds);

      const result = winner ? 'already_won' : (latestRound !== currentRound ? 'timeout' : 'processing');

      await saveBattleRoundAnswer(sessionId, currentRound, playerId, {
        answer,
        result,
      });

      return buildBattleAnswerResponse({
        sessionId,
        roomCode: latest.roomCode,
        current: latestRound,
        total: latestTotal,
        hasNext: latestStatus === 'playing',
        state: latestStatus === 'ended' ? 'ENDED' : 'PLAYING',
        result,
        winner: winner || null,
        correctAnswer: winner ? latest.correctAnswer : null,
      });
    }

    // 락 안에서 재조회
    const lockedBase = await getSessionBasicForPlay(sessionId);
    if (!lockedBase) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    const lockedStatus = lockedBase.status;
    const lockedRoomCode = lockedBase.roomCode;
    const lockedCorrectAnswer = lockedBase.correctAnswer;
    const lockedDeadlineAt = lockedBase.deadlineAt;
    const lockedCurrentRound = Number(lockedBase.round?.current || 1);
    const lockedTotalRounds = Number(lockedBase.round?.total || 5);

    // 이미 처리된 상태
    if (lockedStatus !== 'playing' || lockedCurrentRound !== currentRound) {
      const winner = await getRoundWinner(sessionId, currentRound);
      const result = winner ? 'already_won' : 'timeout';

      await saveBattleRoundAnswer(sessionId, currentRound, playerId, {
        answer,
        result,
      });

      return buildBattleAnswerResponse({
        sessionId,
        roomCode: lockedRoomCode,
        current: lockedCurrentRound,
        total: lockedTotalRounds,
        hasNext: lockedStatus === 'playing',
        state: lockedStatus === 'ended' ? 'ENDED' : 'PLAYING',
        result,
        winner: winner || null,
        correctAnswer: lockedCorrectAnswer,
      });
    }

    // 이미 승자가 있으면 추가 처리 금지
    const existingWinner = await getRoundWinner(sessionId, currentRound);
    if (existingWinner) {
      await saveBattleRoundAnswer(sessionId, currentRound, playerId, {
        answer,
        result: 'already_won',
      });

      return buildBattleAnswerResponse({
        sessionId,
        roomCode: lockedRoomCode,
        current: currentRound,
        total: lockedTotalRounds,
        hasNext: false,
        state: 'PLAYING',
        result: 'already_won',
        winner: existingWinner,
        correctAnswer: lockedCorrectAnswer,
      });
    }

    const lockedNow = Date.now();
    const lockedIsTimeout =
      lockedDeadlineAt && Number(lockedDeadlineAt) > 0 && lockedNow > Number(lockedDeadlineAt);

    const lockedIsCorrect =
      normalizeText(answer) === normalizeText(lockedCorrectAnswer);

    // 락 안에서 아직 종료 조건이 아니면 오답 처리
    if (!lockedIsTimeout && !lockedIsCorrect) {
      await saveBattleRoundAnswer(sessionId, currentRound, playerId, {
        answer,
        result: 'wrong',
      });
      await addWrongAttempt(sessionId, playerId, 1);

      return buildBattleAnswerResponse({
        sessionId,
        roomCode: lockedRoomCode,
        current: currentRound,
        total: lockedTotalRounds,
        hasNext: false,
        state: 'PLAYING',
        result: 'wrong',
        winner: null,
        correctAnswer: null,
      });
    }

    let winner = null;
    let result = 'timeout';

    if (lockedIsCorrect) {
      const claimed = await claimRoundWinner(sessionId, currentRound, playerId);

      if (claimed) {
        winner = playerId;
        result = 'correct';
        await addScore(sessionId, playerId, 1);
      } else {
        winner = await getRoundWinner(sessionId, currentRound);
        result = 'already_won';
      }
    }

    await saveBattleRoundAnswer(sessionId, currentRound, playerId, {
      answer,
      result,
    });

    // expectedRound를 넣어서 멱등하게
    const moved = await advanceRoundOrEnd(sessionId, {
      expectedRound: currentRound,
      perRoundMs: BATTLE_ROUND_DURATION_MS,
    });

    if (!moved.ok) {
      return {
        statusCode: 500,
        data: { message: 'Failed to advance round' },
      };
    }

    const finalBase = await getSessionBasicForPlay(sessionId);

    const finalStatus = finalBase?.status || (moved.ended ? 'ended' : 'playing');
    const finalRoomCode = finalBase?.roomCode || lockedRoomCode;
    const finalCurrentRound = Number(finalBase?.round?.current || moved.currentRound || currentRound);
    const finalTotalRounds = Number(finalBase?.round?.total || lockedTotalRounds);

    return buildBattleAnswerResponse({
      sessionId,
      roomCode: finalRoomCode,
      current: finalCurrentRound,
      total: finalTotalRounds,
      hasNext: finalStatus === 'playing',
      state: finalStatus === 'ended' ? 'ENDED' : 'PLAYING',
      result,
      winner,
      correctAnswer: lockedCorrectAnswer,
    });
  } catch (err) {
    console.error('[submitAnswer] error:', err);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  } finally {
    await releaseBattleRoundLock(roundLock);
  }
}

// 배틀 결과(라운드별 상세 내역)
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

    const rounds = [];
    for (let r = 1; r <= totalRounds; r++) {
      const q = session?.questions?.[r - 1] || {};
      const playersOut = [];

      if (you) {
        const { lastAnswer, isCorrect } = await getBattleRoundPlayerAnswer(sessionId, r, you);
        playersOut.push({
          playerId: you,
          isCorrect,
          lastAnswer,
        });
      } else {
        for (const p of players) {
          const { lastAnswer, isCorrect } = await getBattleRoundPlayerAnswer(
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

// 현재 배틀룸 상태를 스냅샷 형태로 반환
async function getBattleRoom({ sessionId }) {
  try {
    const session = await getSession(sessionId);

    if (!session) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    let status = String(session.status || 'WAITING').toUpperCase();
    const hostId = session.hostId || null;
    const totalRounds = Number(session?.round?.total || session?.questions?.length || 5);

    let round = {
      current: Number(session?.round?.current || 1),
      total: totalRounds,
    };

    const summary = await getScores(sessionId);

    // timeout이면 먼저 처리
    if (status === 'PLAYING') {
      const base = await getSessionBasicForPlay(sessionId);
      const deadline = Number(base?.deadlineAt || 0);
      const now = Date.now();

      if (deadline > 0 && now > deadline) {
        try {
          const moved = await advanceRoundOrEnd(sessionId, {
            expectedRound: round.current,
            perRoundMs: BATTLE_ROUND_DURATION_MS,
          });

          if (moved?.ok) {
            const latest = await getSessionBasicForPlay(sessionId);

            status = String(
              latest?.status || (moved.ended ? 'ENDED' : 'PLAYING')
            ).toUpperCase();

            round = {
              current: Number(latest?.round?.current || moved.currentRound || round.current),
              total: Number(latest?.round?.total || totalRounds),
            };
          }
        } catch (e) {
          console.warn('[GET timeout advance] failed:', e?.message || e);
        }
      }
    }

    // timeout 처리 후 최신 상태 기준으로 question 계산
    let question = null;
    if (status === 'PLAYING') {
      const latestSession = await getSession(sessionId);
      const idx = Math.max(0, Number(round.current || 1) - 1);
      const q = Array.isArray(latestSession?.questions) ? latestSession.questions[idx] : null;

      if (q) {
        const questionId = q.questionId ?? q.id ?? (typeof q.id === 'number' ? String(q.id) : null);
        const text = q.text ?? q.correctSentence ?? q.answer ?? null;
        if (questionId && text) {
          question = { questionId, text };
        }
      }
    }

    // 남은 시간도 최신 deadline 기준으로 재계산
    let remainingTime = 0;
    if (status === 'PLAYING') {
      const latestBase = await getSessionBasicForPlay(sessionId);
      const latestDeadline = Number(latestBase?.deadlineAt || 0);
      const now = Date.now();

      remainingTime =
        latestDeadline > now ? Math.ceil((latestDeadline - now) / 1000) : 0;
    }

    return {
      statusCode: 200,
      data: {
        status,
        hostId,
        round: {
          current: Number(round.current || 1),
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

// 배틀룸과 관련된 Redis 키를 모두 삭제
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
  submitBattleAnswerAttempt,
  getBattleResult,
  getBattleRoom,
  getBattleRoomSnapshot,
  deleteBattleRoom,
};
