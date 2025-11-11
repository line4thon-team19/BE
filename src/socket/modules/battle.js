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
const { claimRoundWinner } = require('../../repositories/battleSessionRepo');

const ROOM = (sessionId) => `battle:room:${sessionId}`;

const roundTickerMap = new Map();
const PER_ROUND_MS = 30_000;

async function makeSnapshot(sessionId) {
  const sess = await getSession(sessionId);
  if (!sess) throw new Error('Session not found');

  const status = String(sess.status || 'ENDED').toUpperCase();
  const round = sess.round || { current: 1, total: 5 };

  let remainingTime = 0;
  try {
    const t = await tickRemainingSec(sessionId);
    if (t && typeof t.remainingSec === 'number') remainingTime = Math.max(0, t.remainingSec);
  } catch {
    /* ignore tickRemainingSec error */
  }

  const summary = await getScoreSummary(sessionId);

  let question = null;
  if (status === 'PLAYING' && Array.isArray(sess.questions)) {
    const idx = Math.max(0, Number(round.current || 1) - 1);
    const q = sess.questions[idx];
    if (q) {
      const questionId = q.questionId ?? q.id ?? (typeof q.id === 'number' ? String(q.id) : null);
      const text = q.text ?? q.correctSentence ?? q.answer ?? null;
      if (questionId && text) question = { questionId, text };
    }
  }

  return {
    status,
    hostId: sess.hostId || null,
    round: { current: Number(round.current || 1), total: Number(round.total || 5) },
    question,
    summary,
    remainingTime,
  };
}

function startRoundTicker(io, sessionId) {
  if (roundTickerMap.has(sessionId)) return;

  console.log(`[TICKER] START for ${sessionId}`);

  const intervalId = setInterval(async () => {
    try {
      const { remainingSec, round } = await tickRemainingSec(sessionId);
      console.log('[TICK]', sessionId, remainingSec, round.current);
      if (remainingSec === null || remainingSec === undefined) return;

      if (remainingSec <= 0) {
        const handled = await tryHandleTimeoutOnce(sessionId, round.current);
        if (handled) {
          await advanceRoundWS(io, sessionId);
          const snap = await makeSnapshot(sessionId);
          io.to(ROOM(sessionId)).emit('battle:snapshot', snap);
        }
        io.to(ROOM(sessionId)).emit('battle:round:ticker', { round, remainingSec: 0 });
        return;
      }

      io.to(ROOM(sessionId)).emit('battle:round:ticker', { round, remainingSec });
    } catch (e) {
      console.warn('[ticker] error:', e?.message || e);
    }
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
async function advanceRoundWS(io, sessionId, perRoundMs = PER_ROUND_MS) {
  const meta = await getRoundMeta(sessionId);
  const next = meta.current + 1;

  if (next > meta.total) {
    await setEnded(sessionId);
    io.to(ROOM(sessionId)).emit('battle:round:end', { state: 'ENDED' });
    stopRoundTicker(sessionId);
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

      socket.data.battle = {
        sessionId,
        playerId: socket.data.playerId, // auth 미들웨어에서 이미 넣어줬다고 가정
      };

      await socket.join(ROOM(sessionId));

      const snap = await makeSnapshot(sessionId);
      socket.emit('battle:snapshot', snap);

      // 다른 참가자에게 누가 들어왔는지 알림
      socket.to(ROOM(sessionId)).emit('battle:player_joined', {
        playerId: socket.data.playerId,
        ts: Date.now(),
      });

      startRoundTicker(io, sessionId);
      if (cb) cb({ ok: true, you: { playerId: socket.data.playerId } });
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
      if (!sessionId || typeof round !== 'number' || !answerText.trim()) {
        throw new Error('Bad payload');
      }
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
        // 정답을 맞추면
        // 1) 라운드 승자를 1회만 기록 (REST 조회용)
        // 2) 정답 플래그 세팅
        // 3) 잠깐 보여준 뒤 다음 라운드로 전환
        try {
          try {
            await claimRoundWinner(sessionId, round, socket.data.playerId);
          } catch (e) {
            console.warn('[answer] claimRoundWinner failed:', e?.message || e);
          }

          await setCorrectFlag(sessionId, round);

          setTimeout(async () => {
            try {
              await advanceRoundWS(io, sessionId);
              const snap = await makeSnapshot(sessionId);
              io.to(ROOM(sessionId)).emit('battle:snapshot', snap);
            } catch (e) {
              console.warn('[answer->advance] failed:', e?.message || e);
            }
          }, 900);
        } catch (e) {
          console.warn('[answer] correct-flow failed:', e?.message || e);
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

  socket.on('disconnect', async () => {
    const battle = socket.data.battle;
    if (!battle) return;

    const { sessionId, playerId } = battle;

    console.log('[battle:disconnect]', {
      socketId: socket.id,
      sessionId,
      playerId,
    });

    // 이미 끝난 세션이면 알림 안보냄
    try {
      const sess = await getSession(sessionId);
      if (!sess) return;
      if (String(sess.status || 'ENDED').toUpperCase() === 'ENDED') {
        return;
      }
    } catch (e) {
      return;
    }

    // 같은 배틀룸에 남아있는 상대에게 알림 방송
    socket.to(ROOM(sessionId)).emit('battle:opponent_disconnected', {
      playerId,
      ts: Date.now(),
      message: '상대방의 연결이 끊어졌습니다.',
    });
  });
}

module.exports = { register, stopRoundTicker };
