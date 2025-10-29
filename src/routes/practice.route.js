const express = require('express');
const crypto = require('crypto');
const { getMysql } = require('../libs/mysqlClient');
const { createPracticeSession } = require('../repositories/practiceSessionRepo');

const router = express.Router();

// 게스트 인증 
const authenticateGuest = require('../middlewares/auth');

router.post('/start', authenticateGuest, express.json(), async (req, res) => {
  try {
    const pool = await getMysql();

    // countdownSec: body로 받기 (기본 3초)
    const countdownSec = Number(req.body?.countdownSec ?? 3);
    if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 30) {
      return res.status(400).json({ message: 'countdownSec must be integer 0~30' });
    }

    // MySQL에서 랜덤 5문제
    const total = 5;
    const [rows] = await pool.query(
      `SELECT id, sentence, choice1, choice2, answer AS answerLabel, explanation
       FROM PracticeQuestion
       ORDER BY RAND()
       LIMIT ?`,
      [total]
    );
    if (rows.length < total) {
      return res.status(409).json({ message: `문제가 ${total}개보다 적습니다.` });
    }

    // 세션 생성
    const sessionId = `p_${crypto.randomBytes(6).toString('base64url')}`;
    const timeLimit = 10;

    // 서버 저장용(정답 포함)
    const serverQuestions = rows.map((q) => ({
      id: q.id,
      text: q.sentence,
      choice1: q.choice1,
      choice2: q.choice2,
      answerLabel: q.answerLabel,        // 'choice1' | 'choice2'
      explanation: q.explanation ?? null,
    }));

    const session = {
      sessionId,
      guestId: req.user?.playerId || null, 
      state: 'PLAYING',
      countdown: { seconds: countdownSec },
      round: { current: 1, total },
      timeLimit,
      remainingTime: timeLimit,
      questions: serverQuestions,
      createdAt: new Date().toISOString(),
    };

    await createPracticeSession(session);

    // 클라이언트 응답용(정답 미포함)
    const clientQuestions = serverQuestions.map((q) => ({
      questionId: String(q.id),
      text: q.text,
      options: [q.choice1, q.choice2],
    }));

    return res.json({
      sessionId,
      state: 'PLAYING',
      countdown: { seconds: countdownSec },
      round: { current: 1, total },
      timeLimit,
      questions: clientQuestions,
    });
  } catch (e) {
    console.error('[POST /practice/start] error:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

module.exports = router;
