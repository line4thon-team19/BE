const express = require('express');
const crypto = require('crypto');
const { getMysql } = require('../libs/mysqlClient');
const {
  createPracticeSession,
  getPracticeSession,
  savePracticeSession,
} = require('../repositories/practiceSessionRepo');

const router = express.Router();

// 게스트 인증 
const authenticateGuest = require('../middlewares/auth');

function calcCountdown(sess) {
  if (typeof sess?.countdownEndAt !== 'number') return null;
  const sec = Math.ceil((sess.countdownEndAt - Date.now()) / 1000);
  return sec > 0 ? { seconds: sec } : null;
}

function calcRemaining(sess) {
  const lim = Number(sess?.timeLimit);
  if (!Number.isFinite(lim) || lim <= 0) return null;
  const started = Number(sess?.roundStartedAt);
  if (!Number.isFinite(started) || started <= 0) return lim; // 아직 시작 X 
  const elapsed = Math.floor((Date.now() - started) / 1000);
  return Math.max(0, lim - elapsed);
}

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
    const timeLimit = 20;

    // 서버 저장용(정답 포함)
    const serverQuestions = rows.map((q) => ({
      id: q.id,
      text: q.sentence,
      choice1: q.choice1,
      choice2: q.choice2,
      answerLabel: q.answerLabel,        // 'choice1' | 'choice2'
      explanation: q.explanation ?? null,
    }));

    const now = Date.now();
    const countdownEndAt = countdownSec > 0 ? now + countdownSec * 1000 : null;

    const session = {
      sessionId,
      guestId: req.user?.playerId || null,
      state: 'PLAYING',
      countdownEndAt,
      round: { current: 1, total },
      timeLimit,                  // 초
      roundStartedAt: countdownEndAt ?? now, // 카운트다운 끝나면 라운드 시작
      questions: serverQuestions,
      answers: [],
      score: 0,
      wrongCount: 0,
      createdAt: new Date().toISOString(),
    };

    await createPracticeSession(session);

    // 클라이언트 응답용(정답 미포함)
    const clientQuestions = serverQuestions.map((q) => ({
      questionId: String(q.id),
      text: q.text,
      options: [q.choice1, q.choice2],
    }));

    const countdown =
      countdownEndAt != null
        ? { seconds: Math.ceil((countdownEndAt - now) / 1000) }
        : undefined;

    return res.json({
      sessionId,
      state: 'PLAYING',
      ...(countdown ? { countdown } : {}),
      round: { current: 1, total },
      timeLimit,
      questions: clientQuestions,
    });
  } catch (e) {
    console.error('[POST /practice/start] error:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// 정답 제출
router.post('/:sessionId/answer', authenticateGuest, express.json(), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { round, answer } = req.body || {};

    // round 파싱
    let clientRound = null;
    if (typeof round === 'number') clientRound = round;
    else if (round && typeof round.current === 'number') clientRound = round.current;

    if (!Number.isInteger(clientRound) || clientRound < 1) {
      return res.status(400).json({ message: 'round must be an integer >= 1 or { current: integer }' });
    }
    if (answer !== 'choice1' && answer !== 'choice2') {
      return res.status(400).json({ message: 'answer must be "choice1" or "choice2"' });
    }

    const sess = await getPracticeSession(sessionId);
    if (!sess) return res.status(404).json({ message: 'Session not found or expired' });
    if (sess.state === 'ENDED') return res.status(409).json({ message: 'Already ended' });
    if (sess.guestId && sess.guestId !== req.user.playerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const serverCurrent = Number(sess.round?.current ?? 1);
    const total = Number(sess.round?.total ?? (sess.questions?.length || 0));

    // 라운드 동기화 체크
    if (serverCurrent !== clientRound) {
      return res.status(409).json({
        code: 'ROUND_MISMATCH',
        message: `Client round(${clientRound}) != Server round(${serverCurrent})`,
      });
    }

    const idx = serverCurrent - 1;
    const q = sess.questions?.[idx];
    if (!q) return res.status(409).json({ message: 'Round index out of range' });

    const already = Array.isArray(sess.answers) && sess.answers.some((a) => a.round === serverCurrent);
    if (already) return res.status(409).json({ message: 'Already answered this round' });

    const isCorrect = answer === q.answerLabel;

    // 진행 기록 업데이트
    sess.answers = Array.isArray(sess.answers) ? sess.answers : [];
    sess.answers.push({
      round: serverCurrent,
      questionId: q.id,
      answer,
      correct: isCorrect,
      answeredAt: new Date().toISOString(),
    });

    sess.score = (sess.score ?? 0) + (isCorrect ? 1 : 0);
    sess.wrongCount = (sess.wrongCount ?? 0) + (isCorrect ? 0 : 1);

    const isLast = serverCurrent >= total;

    if (isLast) {
      sess.state = 'ENDED';
      await savePracticeSession(sess);
      return res.json({
        state: 'ENDED',
        round: { current: serverCurrent, total },
        result: isCorrect ? 'correct' : 'wrong',
        next: { hasNext: false },
      });
    }

    // 다음 라운드로 이동
    sess.round.current = serverCurrent + 1;
    // 남은 시간은 저장하지 않고, 시작 시각만 갱신
    sess.roundStartedAt = Date.now();
    // 라운드 중 카운트다운은 사용 안 하므로 초기화
    sess.countdownEndAt = null;

    const nq = sess.questions[sess.round.current - 1];
    await savePracticeSession(sess);

    return res.json({
      round: { current: sess.round.current, total },
      next: {
        hasNext: true,
        result: isCorrect ? 'correct' : 'wrong',
        question: {
          questionId: String(nq.id),
          text: nq.text,
          options: [nq.choice1, nq.choice2],
        },
      },
    });
  } catch (e) {
    console.error('[POST /practice/:sessionId/answer] error:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// 결과 조회
router.get('/:sessionId/result', authenticateGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const sess = await getPracticeSession(sessionId);
    if (!sess) return res.status(404).json({ message: 'Session not found or expired' });

    // 본인 세션만 허용
    if (sess.guestId && sess.guestId !== req.user.playerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (sess.state !== 'ENDED') {
      return res.status(409).json({ message: 'Not ended yet' });
    }

    const totalRounds = sess.round?.total ?? (sess.questions?.length || 0);

    const answers = Array.isArray(sess.answers) ? sess.answers : [];
    const rows = answers.map((a) => {
      const q = (sess.questions || []).find((x) => x.id === a.questionId);
      const correctText = q ? q[q.answerLabel] : undefined;
      const pickedText = q ? q[a.answer] : undefined;

      return {
        round: a.round,
        question: q ? q.text : '',
        answer: pickedText,
        result: a.correct ? 'correct' : 'wrong',
        correctAnswer: correctText ?? null,
        explanation: q?.explanation ?? null,
      };
    });

    return res.json({
      state: 'ENDED',
      score: sess.score ?? 0,
      wrongCount: sess.wrongCount ?? 0,
      totalRounds,
      questions: rows,
    });
  } catch (e) {
    console.error('[GET /practice/:sessionId/result] error:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

// 세션 상태 조회(새로고침 대비)
router.get('/:sessionId', authenticateGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const sess = await getPracticeSession(sessionId);
    if (!sess) return res.status(404).json({ message: 'Session not found or expired' });

    // 본인 세션 보호
    if (sess.guestId && sess.guestId !== req.user.playerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const total = Number(sess.round?.total ?? (sess.questions?.length || 0));
    const current = Number(sess.round?.current ?? 1);

    const countdown = calcCountdown(sess);
    const remainingTime = calcRemaining(sess);

    // ENDED
    if (sess.state === 'ENDED') {
      return res.json({
        sessionId: sess.sessionId,
        state: 'ENDED',
        round: { current: Math.min(current, total || 1), total },
        score: sess.score ?? 0,
        wrongCount: sess.wrongCount ?? 0,
        totalRounds: total,
      });
    }

    // PLAYING
    const idx = Math.max(0, current - 1);
    const q = (sess.questions || [])[idx];

    // 카운트다운 중이면 문제 표출 X
    if (countdown) {
      return res.json({
        sessionId: sess.sessionId,
        state: 'PLAYING',
        countdown,
        round: { current, total },
        timeLimit: sess.timeLimit ?? null,
        remainingTime, // 계산값
        answeredCount: Array.isArray(sess.answers) ? sess.answers.length : 0,
      });
    }

    // 카운트다운 종료 후: 현재 문제 1개만 노출(정답/해설 제외)
    const currentQuestion = q
      ? {
          questionId: String(q.id),
          text: q.text,
          options: [q.choice1, q.choice2],
        }
      : null;

    return res.json({
      sessionId: sess.sessionId,
      state: 'PLAYING',
      round: { current, total },
      timeLimit: sess.timeLimit ?? null,
      remainingTime, 
      answeredCount: Array.isArray(sess.answers) ? sess.answers.length : 0,
      question: currentQuestion,
    });
  } catch (e) {
    console.error('[GET /practice/:sessionId] error:', e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

module.exports = router;