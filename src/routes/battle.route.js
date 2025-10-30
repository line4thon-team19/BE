const express = require('express');
const authenticateGuest = require('../middlewares/auth');
const { genRoomCode, newBattleSessionId } = require('../utils/id');
const {
  existsRoomCode,
  createSession,
  getSession,
  updateSession,
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

module.exports = router;
