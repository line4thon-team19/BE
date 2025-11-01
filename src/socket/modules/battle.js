const {
  getSession,
  saveTypingSnapshot,
  getCorrectAnswer,
  judgeAndSave,
  getScoreSummary,
  isRoundActive,
  tickRemainingSec,
  tryHandleTimeoutOnce,
  getRoundMeta,
  setRoundPlaying,
  setEnded,
  setCorrectFlag,
  markAnswered,
} = require('./store');
const { normalizeText, rateLimiter } = require('./utils');

const ROOM = (sessionId) => `battle:room:${sessionId}`;

const roundTickerMap = new Map();

function startRoundTicker(io, sessionId) {
  if (roundTickerMap.has(sessionId)) return;

  const intervalId = setInterval(async () => {
    const { remainingSec, round } = await tickRemainingSec(sessionId);

    if (remainingSec === null || remainingSec === undefined) return;

    if (remainingSec < 0) {
      try {
        const handled = await tryHandleTimeoutOnce(sessionId, round.current);
        if (handled) {
          await advanceRoundWS(io, sessionId);
        }
      } catch (e) {
        console.warn('[ticker] timeout advance failed:', e?.message || e);
      }

      io.to(ROOM(sessionId)).emit('battle:round:ticker', { round, remainingSec: 0 });
      return;
    }

    io.to(ROOM(sessionId)).emit('battle:round:ticker', {
      round,
      remainingSec,
    });
  }, 1000);

  roundTickerMap.set(sessionId, intervalId);
}

function stopRoundTicker(sessionId) {
  const id = roundTickerMap.get(sessionId);
  if (id) {
    clearInterval(id);
    roundTickerMap.delete(sessionId);
  }
}

// 라운드 전환
async function advanceRoundWS(io, sessionId, perRoundMs = 30_000) {
  const meta = await getRoundMeta(sessionId);
  const next = meta.current + 1;

  if (next > meta.total) {
    await setEnded(sessionId);
    io.to(ROOM(sessionId)).emit('battle:round:end', { state: 'ENDED' });
    return { ended: true };
  }

  await setRoundPlaying(sessionId, next, perRoundMs);
  io.to(ROOM(sessionId)).emit('battle:round:next', {
    round: { current: next, total: meta.total },
    remainingSec: Math.ceil(perRoundMs / 1000),
  });
  return { ended: false, next };
}

function register(io, socket) {
  // 배틀룸 참가
  socket.on('battle:join', async (payload, cb) => {
    try {
      const { sessionId } = payload || {};
      if (!sessionId) throw new Error('sessionId required');

      const sess = await getSession(sessionId);
      if (!sess) throw new Error('Session not found');

      await socket.join(ROOM(sessionId));
      if (cb) cb({ ok: true, you: { playerId: socket.data.playerId } });

      startRoundTicker(io, sessionId);
    } catch (err) {
      if (cb) cb({ ok: false, message: err.message });
    }
  });

  // 실시간 타이핑
  const typingLimiter = rateLimiter({ windowMs: 100, max: 1 });
  socket.on('battle:typing', async (payload = {}) => {
    if (!typingLimiter.allow(socket.id)) return;
    try {
      const { sessionId, round, text = '' } = payload;
      if (!sessionId || typeof round !== 'number') return;

      const ok = await isRoundActive(sessionId, round);
      if (!ok) return;

      try {
        await saveTypingSnapshot(sessionId, socket.data.playerId, text);
      } catch (err) {
        void err;
      }

      const preview = text;
      socket.to(ROOM(sessionId)).emit('battle:typing:update', {
        playerId: socket.data.playerId,
        round,
        preview,
        len: text.length,
        ts: Date.now(),
      });
    } catch (err) {
      void err;
    }
  });

  // 정답 제출 후 서버 판정
  socket.on('battle:answer:submit', async (payload = {}, cb) => {
    try {
      const { sessionId, round, answerText = '' } = payload;
      if (!sessionId || typeof round !== 'number') throw new Error('Bad payload');

      const active = await isRoundActive(sessionId, round);
      if (!active) throw new Error('Round not active');

      const normalized = normalizeText(answerText);
      const correctAnswer = await getCorrectAnswer(sessionId, round);

      const { result } = await judgeAndSave({
        sessionId,
        round,
        playerId: socket.data.playerId,
        normalizedAnswer: normalized,
        correctAnswer,
      });

      const summary = await getScoreSummary(sessionId);

      // 방 전체에 즉시 방송(정답 공개 포함)
      io.to(ROOM(sessionId)).emit('battle:answer:result', {
        playerId: socket.data.playerId,
        round,
        result,
        correctAnswer,
        summary, // [{playerId, score, wrong}]
        ts: Date.now(),
      });

      if (result === 'correct') {
        // 정답을 맞추면 잠깐 보여준 뒤 다음 라운드로 전환
        try {
          await setCorrectFlag(sessionId, round);
          setTimeout(() => {
            advanceRoundWS(io, sessionId).catch((e) => {
              console.warn('[answer] advance on correct failed:', e?.message || e);
            });
          }, 900);
        } catch (e) {
          console.warn('[answer] setCorrectFlag failed:', e?.message || e);
        }
        if (cb) cb({ ok: true, result });
        return;
      }

      // 오답이면 계속 제출 가능. 타임아웃 또는 누군가 정답일 때만 전환
      try {
        await markAnswered(sessionId, round, socket.data.playerId);
      } catch (e) {
        console.warn('[answer] markAnswered failed:', e?.message || e);
      }

      if (cb) cb({ ok: true, result });
    } catch (err) {
      if (cb) cb({ ok: false, message: err.message });
    }
  });

  socket.on('disconnect', () => {
    // 세션-플레이어 퇴장 처리 필요 시 구현
  });
}

module.exports = { register, stopRoundTicker };
