const {
  saveTypingSnapshot,
  isRoundActive,
  tickRemainingSec,
  tryHandleTimeoutOnce,
} = require('./store');
const { rateLimiter } = require('../../utils/rateLimiter');
const battleService = require('../../services/battleService');
const {
  advanceRoundOrEnd,
  getSession,
} = require('../../repositories/battleSessionRepo');
const {
  BATTLE_ROUND_DURATION_MS,
  getBattleRoomChannel,
} = require('../../services/battleHelpers');

const roundTickerMap = new Map();

// REST 스냅샷에 소켓 전용 점수 요약을 합쳐 반환
async function makeSnapshot(sessionId) {
  const snapshot = await battleService.getBattleRoomSnapshot({ sessionId });
  return snapshot;
}

// 현재 배틀 상태를 룸 전체에 다시 전파
async function broadcastBattleSnapshot(io, sessionId, { previousRound = null } = {}) {
  const snapshot = await makeSnapshot(sessionId);
  const room = getBattleRoomChannel(sessionId);

  if (previousRound !== null) {
    if (String(snapshot.state || '').toUpperCase() === 'ENDED') {
      io.to(room).emit('battle:round:end', { state: 'ENDED' });
      stopRoundTicker(sessionId);
    } else if (Number(snapshot.round?.current || 0) !== Number(previousRound)) {
      io.to(room).emit('battle:round:next', {
        round: snapshot.round,
        remainingSec: snapshot.remainingTime,
      });
    }
  }

  io.to(room).emit('battle:snapshot', snapshot);
  return snapshot;
}

// 타임아웃 라운드를 정산
async function settleTimedOutRound(io, sessionId, roundNo) {
  const moved = await advanceRoundOrEnd(sessionId, {
    expectedRound: roundNo,
    perRoundMs: BATTLE_ROUND_DURATION_MS,
  });

  if (!moved.ok) {
    return null;
  }

  return broadcastBattleSnapshot(io, sessionId, {
    previousRound: roundNo,
  });
}

// 배틀 룸별 라운드 타이머를 시작
function startRoundTicker(io, sessionId) {
  if (roundTickerMap.has(sessionId)) return;

  console.log(`[TICKER] START for ${sessionId}`);

  const intervalId = setInterval(async () => {
    try {
      const { remainingSec, round } = await tickRemainingSec(sessionId);
      console.log('[TICK]', sessionId, remainingSec, round.current);

      if (remainingSec === null || remainingSec === undefined) {
        return;
      }

      if (remainingSec <= 0) {
        const handled = await tryHandleTimeoutOnce(sessionId, round.current);

        if (handled) {
          await settleTimedOutRound(io, sessionId, round.current);
        }

        io.to(getBattleRoomChannel(sessionId)).emit('battle:round:ticker', {
          round,
          remainingSec: 0,
        });
        return;
      }

      io.to(getBattleRoomChannel(sessionId)).emit('battle:round:ticker', {
        round,
        remainingSec,
      });
    } catch (e) {
      console.warn('[ticker] error:', e?.message || e);
    }
  }, 1000);

  roundTickerMap.set(sessionId, intervalId);
}

// 배틀 룸별 라운드 타이머를 중지
function stopRoundTicker(sessionId) {
  const intervalId = roundTickerMap.get(sessionId);

  if (!intervalId) {
    return;
  }

  clearInterval(intervalId);
  roundTickerMap.delete(sessionId);
}

// 배틀 관련 소켓 이벤트를 등록
function register(io, socket) {
  const typingLimiter = rateLimiter({ windowMs: 100, max: 1 });

  // 플레이어를 배틀 룸에 입장시키고 최신 스냅샷을 내려 줌
  socket.on('battle:join', async (payload, cb) => {
    try {
      const { sessionId } = payload || {};

      if (!sessionId) {
        throw new Error('sessionId required');
      }

      socket.data.battle = {
        sessionId,
        playerId: socket.data.user.playerId,
      };

      await socket.join(getBattleRoomChannel(sessionId));

      const snapshot = await makeSnapshot(sessionId);
      socket.emit('battle:snapshot', snapshot);

      socket.to(getBattleRoomChannel(sessionId)).emit('battle:player_joined', {
        playerId: socket.data.user.playerId,
        ts: Date.now(),
      });

      startRoundTicker(io, sessionId);

      if (cb) {
        cb({ ok: true, you: { playerId: socket.data.user.playerId } });
      }
    } catch (err) {
      if (cb) {
        cb({ ok: false, message: err.message });
      }
    }
  });

  // 상대 실시간 타이핑 상태
  socket.on('battle:typing', async (payload = {}) => {
    if (!typingLimiter.allow(socket.id)) return;

    try {
      const { sessionId, round, text = '' } = payload;

      if (!sessionId || typeof round !== 'number') {
        return;
      }

      const active = await isRoundActive(sessionId, round);
      if (!active) {
        return;
      }

      await saveTypingSnapshot(sessionId, socket.data.user.playerId, text);

      socket.to(getBattleRoomChannel(sessionId)).emit('battle:typing:update', {
        playerId: socket.data.user.playerId,
        round,
        preview: text,
        len: text.length,
        ts: Date.now(),
      });
    } catch (_error) {
      return;
    }
  });

  // 제출 답안을 공용 서비스로 판정한 뒤 결과를 전달
  socket.on('battle:answer:submit', async (payload = {}, cb) => {
    try {
      const { sessionId, round, answerText = '' } = payload;

      if (!sessionId || typeof round !== 'number' || !answerText.trim()) {
        throw new Error('Bad payload');
      }

      const active = await isRoundActive(sessionId, round);
      if (!active) {
        throw new Error('Round not active');
      }

      const submission = await battleService.submitBattleAnswerAttempt({
        sessionId,
        round,
        answerText,
        playerId: socket.data.user.playerId,
      });

      if (submission.statusCode >= 400) {
        throw new Error(submission.data?.message || 'Failed to submit answer');
      }

      io.to(getBattleRoomChannel(sessionId)).emit('battle:answer:result', {
        playerId: submission.data.playerId || socket.data.user.playerId,
        round,
        result: submission.data.result,
        isCorrect: submission.data.isCorrect,
        submittedText: submission.data.submittedText,
        answerText: submission.data.submittedText,
        state: submission.data.state,
        winner: submission.data.winner,
        correctAnswer: submission.data.correctAnswer,
        summary: submission.data.summary,
        ts: Date.now(),
      });

      await broadcastBattleSnapshot(io, sessionId, {
        previousRound: round,
      });

      if (cb) {
        cb({ ok: true, ...submission.data });
      }
    } catch (err) {
      if (cb) {
        cb({ ok: false, message: err.message });
      }
    }
  });

  // 아직 끝나지 않은 배틀이면 상대에게 연결 종료 알림
  socket.on('disconnect', async () => {
    const battle = socket.data.battle;
    if (!battle) return;

    const { sessionId, playerId } = battle;

    console.log('[battle:disconnect]', {
      socketId: socket.id,
      sessionId,
      playerId,
    });

    try {
      const session = await getSession(sessionId);

      if (!session) return;
      if (String(session.status || 'ENDED').toUpperCase() === 'ENDED') return;
    } catch (_error) {
      return;
    }

    socket.to(getBattleRoomChannel(sessionId)).emit('battle:opponent_disconnected', {
      playerId,
      ts: Date.now(),
      message: '상대방의 연결이 끊어졌습니다.',
    });
  });
}

module.exports = { register, stopRoundTicker };
