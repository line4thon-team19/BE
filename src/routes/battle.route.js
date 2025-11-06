const express = require('express');
const authenticateGuest = require('../middlewares/auth');
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
} = require('../repositories/battleSessionRepo');
const { getRandomBattleQuestions } = require('../repositories/battleQuestionRepo');
const { getRedis } = require('../libs/redisClient');

const router = express.Router();
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.example.com';

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
// 라운드 제한시간 30초
const PER_ROUND_MS = 30 * 1000;

// 마지막 답/정답여부 조회
const getLastAnswerFromRedis = async (redisClient, sessId, roundNo, playerId) => {
  // WS 포맷
  const wsKey = `${PFX}:${sessId}:round:${roundNo}:answer:${playerId}`;
  const wsAll = await redisClient.hGetAll(wsKey);
  if (wsAll && Object.keys(wsAll).length) {
    const text = wsAll.text ?? null;
    const result = wsAll.result ?? null;
    const isCorrect = result === 'correct';
    return { lastAnswer: text, isCorrect };
  }

  // REST 포맷
  const restKey = keys.battleRoundAnswer(sessId, roundNo);
  const [text, result] = await redisClient.hmGet(restKey, [
    `lastAnswer:${playerId}`,
    `result:${playerId}`, // 있으면 사용, 없으면 null
  ]);
  const isCorrect = result === 'correct';
  return { lastAnswer: text ?? null, isCorrect: !!(text && isCorrect) };
};

/** 방 생성(방장) */
router.post('/rooms', authenticateGuest, async (req, res) => {
  try {
    // 금지 필드 검사
    const forbidden = ['state', 'round', 'status'];
    const hasForbidden = Object.keys(req.body || {}).some((k) => forbidden.includes(k));
    if (hasForbidden) {
      return res
        .status(400)
        .json({ message: 'Forbidden fields: cannot include state/round/status in creation' });
    }

    // 고유 roomCode 확보 (충돌 방어)
    let roomCode = genRoomCode();
    for (let i = 0; i < 5 && (await existsRoomCode(roomCode)); i += 1) {
      roomCode = genRoomCode();
    }
    // 5회 초과 충돌 시 서버 에러 처리
    if (await existsRoomCode(roomCode)) {
      return res.status(500).json({ message: 'Failed to allocate unique roomCode' });
    }

    const sessionId = newBattleSessionId();
    const hostId = req.user.playerId;
    const status = 'waiting';
    const inviteLink = `${APP_BASE_URL}/join/${roomCode}`;

    const session = {
      sessionId,
      roomCode,
      status, // 생성은 항상 waiting
      hostId, // 토큰 sub
      inviteLink,
      createdAt: new Date().toISOString(),
      // round/state는 생성 시 없음
    };

    await createSession(session);

    //  WS가 읽을 Redis 키 생성
    const r = await getRedis();
    await r.hSet(keys.battleSessionState(sessionId), {
      state: 'WAITING',
      hostId,
      roomCode,
      roundCurrent: '1',
      roundTotal: '5',
      roundEndsAt: '',
    });

    await r.expire(keys.battleSessionState(sessionId), 60 * 60 * 2); // TTL 2h
    // roomCode로 sessionId 역조회
    await r.set(keys.battleRoomCode(roomCode), sessionId, { EX: 60 * 60 * 2 });

    return res.status(201).json({
      sessionId,
      roomCode,
      status,
      hostId,
      inviteLink,
    });
  } catch (err) {
    console.error('[POST /api/battle/rooms] error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/** 카운트다운 시작 (방장만) */
router.post('/:sessionId/start', authenticateGuest, express.json(), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const countdownSec = Number(req.body?.countdownSec ?? 3);
    if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 30) {
      return res.status(400).json({ message: 'countdownSec must be integer 0~30' });
    }

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ message: 'Session not found' });

    // 방장 검증
    if (req.user.playerId !== session.hostId) {
      return res.status(403).json({ message: '방장만 카운트다운을 시작할 수 있습니다.' });
    }

    // 두 명 입장 여부 검증
    const playersArr = Array.isArray(session.players) ? session.players : [];
    const normalizedPlayers =
      playersArr.length > 0
        ? playersArr
        : session.hostId
          ? [{ playerId: session.hostId, isHost: true }]
          : [];
    if (normalizedPlayers.length < 2) {
      return res.status(409).json({ message: '상대 플레이어 입장 후 시작할 수 있습니다.' });
    }

    // 상태 검증
    if (session.status !== 'waiting') {
      return res.status(409).json({ message: `'${session.status}'일 때는 시작할 수 없습니다.` });
    }
    if (session.countdown?.inProgress) {
      return res.status(409).json({ message: '카운트다운이 이미 시작되었습니다.' });
    }

    // 문제 5개 랜덤 선택
    const questions = await getRandomBattleQuestions(5);
    if (questions.length < 5) {
      return res.status(422).json({ message: '문제가 5개 이상 필요합니다.' });
    }

    const nowIso = new Date().toISOString();

    // 세션에 카운트다운 상태 기록 (status는 waiting)
    const round = session.round ?? { current: 1, total: 5 };

    const patched = await updateSession(sessionId, {
      countdown: { seconds: countdownSec, startedAt: nowIso, inProgress: true },
      questions,
      round: session.round ?? { current: 1, total: 5 },
    });
    if (!patched) {
      return res.status(500).json({ message: 'Failed to update session' });
    }

    // WS용 라운드 타이머 필드 반영
    const r = await getRedis();
    await r.hSet(keys.battleSessionState(sessionId), {
      state: 'WAITING',
      roundCurrent: String(session.round?.current ?? 1),
      roundTotal: String(session.round?.total ?? 5),
      roundEndsAt: '',
    });

    // 라운드별 정답 저장
    for (let i = 0; i < questions.length; i++) {
      const roundNo = i + 1;
      const q = questions[i];
      const rawAnswer = q.correctSentence ?? q.answer ?? q.text ?? '';
      await r.hSet(keys.battleRoundAnswer(sessionId, roundNo), {
        answer: normalizeText(rawAnswer),
      });
      await r.expire(keys.battleRoundAnswer(sessionId, roundNo), 60 * 60 * 2);
    }

    // 카운트다운 끝나면 playing으로 전환
    setTimeout(async () => {
      try {
        const cur = await getSession(sessionId);
        // 중복 전환 방지 맟 세션 존재 확인
        if (!cur || cur.status !== 'waiting' || !cur.countdown?.inProgress) return;

        await updateSession(sessionId, {
          status: 'playing',
          startedAt: new Date().toISOString(),
          countdown: { ...cur.countdown, inProgress: false },
          // 1 라운드 시작과 동시에 제한
          deadlineAt: Date.now() + PER_ROUND_MS,
        });

        const r = await getRedis();
        await r.hSet(keys.battleSessionState(sessionId), {
          state: 'PLAYING',
          roundEndsAt: String(Date.now() + PER_ROUND_MS),
        });

        // 라운드 시작 알림
        const io = req.app.locals.io;
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

    return res.json({
      started: true,
      status: 'waiting',
      countdown: { seconds: countdownSec },
      round,
      questions, // [{ id, correctSentence, wrongSentence }]
    });
  } catch (err) {
    console.error('[POST /api/battle/:sessionId/start] error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/** 입장: roomCode만 받음 */
router.post('/entry', authenticateGuest, express.json(), async (req, res) => {
  try {
    const { roomCode } = req.body || {};
    if (!roomCode) return res.status(400).json({ message: 'roomCode is required' });

    // roomCode -> sessionId
    const sessionId = await getSessionIdByRoomCode(roomCode);
    if (!sessionId) {
      return res.status(404).json({ code: '404_ROOM_NOT_FOUND', message: 'Room not found' });
    }

    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ code: '404_ROOM_NOT_FOUND', message: 'Room not found' });
    }

    // waiting 상태만 입장 허용
    if (session.status !== 'waiting') {
      return res
        .status(423)
        .json({ code: '423_ROOM_LOCKED', message: 'Room is not in waiting state' });
    }

    // players 초기화(첫 입장 시 호스트 자동 세팅)
    let players = Array.isArray(session.players) ? session.players.slice() : [];
    let seeded = false;
    if (players.length === 0 && session.hostId) {
      players.push({ playerId: session.hostId, isHost: true });
      seeded = true;
    }

    const me = req.user.playerId;

    // 호스트가 호출하면 변경 없이 현재 상태 반환
    if (me === session.hostId) {
      if (seeded) {
        await updateSession(sessionId, { players });
      }
      return res.json({
        sessionId,
        roomCode: session.roomCode,
        state: 'WAITING',
        players,
      });
    }

    // 이미 방에 있으면 그대로 반환
    if (players.some((p) => p.playerId === me)) {
      return res.json({
        sessionId,
        roomCode: session.roomCode,
        state: 'WAITING',
        players,
      });
    }

    // 정원 체크(최대 2명)
    if (players.length >= 2) {
      return res.status(409).json({ code: '409_ROOM_FULL', message: 'Room already has 2 players' });
    }

    // 게스트 추가
    players.push({ playerId: me, isHost: false });

    const patched = await updateSession(sessionId, { players });
    if (!patched) {
      return res.status(500).json({ message: 'Failed to update session' });
    }

    // 웹소켓 브로드캐스트
    try {
      const io = req.app.locals.io;
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

        console.log(`[WS] Emit success: battle:player_joined`);
      }
    } catch (e) {
      console.warn('[WS] emit battle:player_joined failed:', e.message);
    }

    return res.json({
      sessionId,
      roomCode: patched.roomCode,
      state: 'WAITING',
      players: patched.players,
    });
  } catch (err) {
    console.error('[POST /api/battle/entry] error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/** 정답 제출 */
router.post('/:sessionId/answer', authenticateGuest, express.json(), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { round, answer } = req.body || {};
    const playerId = req.user?.playerId;

    if (!playerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!sessionId) return res.status(400).json({ message: 'Invalid sessionId' });
    if (typeof round !== 'number' || typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ message: 'round(number) and answer(string) are required' });
    }

    const base = await getSessionBasicForPlay(sessionId);
    if (!base) return res.status(404).json({ message: 'Session not found or expired' });

    const { status, roomCode, round: sessRound, correctAnswer, deadlineAt } = base;
    if (status !== 'playing') {
      return res.status(409).json({ message: 'Session is not in playing state' });
    }

    const currentRound = Number(sessRound?.current || 1);
    const totalRounds = Number(sessRound?.total || 5);
    if (round !== currentRound) {
      return res.status(409).json({ message: 'Round mismatch' });
    }

    // 라운드 타임아웃 체크
    const now = Date.now();
    if (deadlineAt && Number(deadlineAt) > 0 && now > Number(deadlineAt)) {
      // 타임아웃 시 서버에서 라운드 전진/종료
      const moved = await advanceRoundOrEnd(sessionId, { perRoundMs: PER_ROUND_MS });
      const hasNext = !moved?.ended && currentRound < totalRounds;
      const nextRoundNumber = Math.min(currentRound + 1, totalRounds);

      // Redis 라운드/타이머 갱신
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

      return res.status(201).json({
        round: { current: nextRoundNumber, total: totalRounds },
        next: { hasNext },
        sessionId,
        roomCode,
        state: moved?.ended ? 'ENDED' : 'PLAYING',
        result: 'timeout',
        winner: null,
        correctAnswer,
      });
    }

    // 제출 로그
    await savePlayerAnswer(sessionId, currentRound, playerId, answer);

    // 다른 유저가 먼저 맞추면 이미 승자 존재
    const roundWinner = await getRoundWinner(sessionId, currentRound);
    if (roundWinner) {
      const hasNext = currentRound < totalRounds;
      const nextRoundNumber = Math.min(currentRound + 1, totalRounds);
      return res.status(201).json({
        round: { current: nextRoundNumber, total: totalRounds },
        next: { hasNext },
        sessionId,
        roomCode,
        state: hasNext ? 'PLAYING' : 'ENDED',
        result: 'timeout',
        winner: roundWinner,
        correctAnswer,
      });
    }

    const isCorrect = normalizeText(answer) === normalizeText(correctAnswer);

    if (!isCorrect) {
      // 오답이면 라운드 유지
      return res.status(201).json({
        round: { current: currentRound, total: totalRounds },
        next: { hasNext: false },
        sessionId,
        roomCode,
        state: toSTATE(status),
        result: 'wrong',
        winner: null,
        correctAnswer: null,
      });
    }

    // 정답 선점
    const claimed = await claimRoundWinner(sessionId, currentRound, playerId);
    if (!claimed) {
      const w = await getRoundWinner(sessionId, currentRound);
      const hasNext = currentRound < totalRounds;
      const nextRoundNumber = Math.min(currentRound + 1, totalRounds);
      return res.status(201).json({
        round: { current: nextRoundNumber, total: totalRounds },
        next: { hasNext },
        sessionId,
        roomCode,
        state: hasNext ? 'PLAYING' : 'ENDED',
        result: 'timeout',
        winner: w,
        correctAnswer,
      });
    }

    // 점수 반영 후 라운드 전진/종료
    await addScore(sessionId, playerId, 1);
    const moved = await advanceRoundOrEnd(sessionId, { perRoundMs: PER_ROUND_MS });
    const hasNext = !moved?.ended && currentRound < totalRounds;
    const nextRoundNumber = Math.min(currentRound + 1, totalRounds);

    // Redis의 라운드/타이머도 갱신
    try {
      const r = await getRedis();
      if (moved?.ended) {
        await r.hSet(keys.battleSessionState(sessionId), { state: 'ENDED', roundEndsAt: '' });
      } else {
        await r.hSet(keys.battleSessionState(sessionId), {
          roundCurrent: String(nextRoundNumber),
          roundEndsAt: String(Date.now() + PER_ROUND_MS),
        });
      }
    } catch (e) {
      console.warn('[WS] round advance redis update failed:', e?.message || e);
    }

    return res.status(201).json({
      round: { current: nextRoundNumber, total: totalRounds },
      next: { hasNext },
      sessionId,
      roomCode,
      state: moved?.ended ? 'ENDED' : 'PLAYING',
      result: 'correct',
      winner: playerId,
      correctAnswer,
    });
  } catch (err) {
    console.error('[POST /api/battle/:sessionId/answer] error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/** 배틀 결과 조회 */
router.get('/:sessionId/result', authenticateGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const you = req.user?.playerId || null;

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ message: 'Session not found or expired' });

    // 플레이어 목록 정규화
    let players = Array.isArray(session.players) ? session.players.slice() : [];
    if (!players.length && session.hostId) {
      players = [{ playerId: session.hostId, isHost: true }];
    }
    if (session.guestId && !players.some((p) => p.playerId === session.guestId)) {
      players.push({ playerId: session.guestId, isHost: false });
    }
    if (!players.length) {
      return res.status(404).json({ message: 'Players not found in session' });
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

      // 요청자만 players에 포함
      const playersOut = [];
      if (you) {
        const { lastAnswer, isCorrect } = await getLastAnswerFromRedis(redis, sessionId, r, you);
        playersOut.push({
          playerId: you,
          isCorrect,
          lastAnswer,
        });
      } else {
        // you가 없으면 기존처럼 전체 포함
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

      rounds.push({
        round: r,
        question: {
          questionId: q.id ?? q.questionId ?? (typeof q.id === 'number' ? String(q.id) : String(r)),
          text: q.text ?? q.correctSentence ?? q.answer ?? null,
          wrongText: q.wrongText ?? q.wrongSentence ?? null,
          explanation: q.explanation ?? null,
        },
        players: playersOut,
      });
    }

    // 승/패 계산
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
    if (you && winnerPlayerId) {
      result = you === winnerPlayerId ? 'win' : 'lose';
    }

    return res.status(200).json({
      state: (session.status || 'ended').toUpperCase(),
      result,
      summary,
      rounds,
    });
  } catch (err) {
    console.error('[GET /api/battle/:sessionId/result] error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/** 배틀룸 조회 */
router.get('/:sessionId', authenticateGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // 세션 기본 정보
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ code: '404_ROOM_NOT_FOUND', message: 'Room not found' });
    }

    // 플레이어 목록 정규화 (호스트/게스트)
    let players = Array.isArray(session.players) ? session.players.slice() : [];
    if (!players.length && session.hostId) {
      players.push({ playerId: session.hostId, isHost: true });
    }
    if (session.guestId && !players.some((p) => p.playerId === session.guestId)) {
      players.push({ playerId: session.guestId, isHost: false });
    }

    const base = await getSessionBasicForPlay(sessionId);
    // base: { sessionId, status, roomCode, hostId, round, correctAnswer, deadlineAt }

    const status = String(base?.status || session.status || 'ended').toUpperCase();
    const hostId = base?.hostId || session.hostId || null;
    const round = base?.round || session.round || { current: 1, total: 5 };

    // 점수 해시
    const scoreMap = await getScores(sessionId);
    const scoreById = (pid) => Number(scoreMap?.[pid] ?? 0);
    const totalRounds = Number(round?.total || session?.questions?.length || 5);

    if (!players.length) {
      // 플레이어 정보가 전혀 없으면 최소 호스트만 구성
      if (hostId) players = [{ playerId: hostId, isHost: true }];
    }

    const summary = players.map((p) => {
      const score = scoreById(p.playerId);
      return {
        playerId: p.playerId,
        isHost: !!p.isHost,
        score,
        wrong: Math.max(totalRounds - score, 0),
      };
    });

    // 현재 문제 (PLAYING일 때만 노출)
    let question = null;
    if (status === 'PLAYING') {
      const idx = Math.max(0, Number(round.current || 1) - 1);
      const q = Array.isArray(session.questions) ? session.questions[idx] : null;
      if (q) {
        const questionId = q.questionId ?? q.id ?? (typeof q.id === 'number' ? String(q.id) : null);
        const text = q.text ?? q.correctSentence ?? q.answer ?? null;
        if (questionId && text) {
          question = { questionId, text };
        }
      }
    }

    // 남은 시간 계산
    const now = Date.now();
    const deadline = Number(base?.deadlineAt ?? session.deadlineAt ?? 0);

    // 타임아웃 시 즉시 라운드 전진 (REST 폴링)
    if (status === 'PLAYING' && deadline && now > deadline) {
      try {
        const moved = await advanceRoundOrEnd(sessionId, { perRoundMs: PER_ROUND_MS });
        const r = await getRedis();

        if (moved?.ended) {
          // 게임 종료
          await r.hSet(keys.battleSessionState(sessionId), { state: 'ENDED', roundEndsAt: '' });
          round.current = Number(round.total || 5);
        } else {
          // 다음 라운드로 진행
          const nextRound = Math.min(Number(round.current || 1) + 1, Number(round.total || 5));
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

    return res.status(200).json({
      status, // WAITING / PLAYING / ENDED
      hostId,
      round: { current: Number(round.current || 1), total: Number(round.total || totalRounds) },
      question, // PLAYING일 때만 객체, 그 외 null
      summary,
      remainingTime,
    });
  } catch (err) {
    console.error('[GET /api/battle/:sessionId] error:', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

module.exports = router;
