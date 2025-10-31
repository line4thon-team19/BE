const express = require('express');
const authenticateGuest = require('../middlewares/auth');
const { genRoomCode, newBattleSessionId } = require('../utils/id');
const {
  existsRoomCode,
  createSession,
  getSession,
  updateSession,
  getSessionIdByRoomCode,
} = require('../repositories/battleSessionRepo');
const { getRandomBattleQuestions } = require('../repositories/battleQuestionRepo');

const router = express.Router();
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.example.com';

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
        });
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
        // 시드가 발생했으면 저장만 한번 하고 반환
        await updateSession(sessionId, { players });
      }
      return res.json({
        sessionId,
        roomCode: session.roomCode,
        state: 'WAITING',
        players,
      });
    }

    // 이미 방에 있으면 그대로 반환(idempotent)
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

    // (옵션) 웹소켓 브로드캐스트
    try {
      const io = req.app.get('io');
      if (io) {
        io.to(sessionId).emit('battle:player_joined', {
          sessionId,
          roomCode: patched.roomCode,
          players: patched.players,
        });
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

module.exports = router;
