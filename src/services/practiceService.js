const crypto = require('crypto');
const { getMysql } = require('../libs/mysqlClient');
const {
  createPracticeSession,
  getPracticeSession: findSession,
  savePracticeSession,
  deletePracticeSession: removeSession,
} = require('../repositories/practiceSessionRepo');

function calcCountdown(sess) {
  if (typeof sess?.countdownEndAt !== 'number') return null;
  const sec = Math.ceil((sess.countdownEndAt - Date.now()) / 1000);
  return sec > 0 ? { seconds: sec } : null;
}

function calcRemaining(sess) {
  const lim = Number(sess?.timeLimit);
  if (!Number.isFinite(lim) || lim <= 0) return null;

  const started = Number(sess?.roundStartedAt);
  if (!Number.isFinite(started) || started <= 0) return lim;

  const now = Date.now();
  if (now < started) return lim;

  const elapsed = Math.floor((now - started) / 1000);
  return Math.max(0, lim - elapsed);
}

function recordTimeout(sess) {
  const current = Number(sess.round?.current ?? 1);
  const idx = current - 1;
  const q = sess.questions?.[idx];
  if (!q) return { isLast: true };

  const already = Array.isArray(sess.answers) && sess.answers.some((a) => a.round === current);
  if (!already) {
    sess.answers = Array.isArray(sess.answers) ? sess.answers : [];
    sess.answers.push({
      round: current,
      questionId: q.id,
      answer: 'timeout',
      correct: false,
      reason: 'timeout',
      answeredAt: new Date().toISOString(),
    });
    sess.wrongCount = (sess.wrongCount ?? 0) + 1;
  }

  const total = Number(sess.round?.total ?? (sess.questions?.length || 0));
  const isLast = current >= total;
  return { isLast };
}

function buildIsCorrectByRound(sess) {
  const total = Number(sess.round?.total ?? (sess.questions?.length || 0));
  const byRound = Array.from({ length: total }, () => null);

  const answers = Array.isArray(sess.answers) ? sess.answers : [];
  for (const a of answers) {
    const r = Number(a.round);
    if (!Number.isInteger(r) || r < 1 || r > total) continue;
    const isTimeout = a.reason === 'timeout';
    byRound[r - 1] = isTimeout ? false : !!a.correct;
  }
  return byRound;
}

async function startPractice({ body, user }) {
  try {
    const pool = await getMysql();

    const countdownSec = Number(body?.countdownSec ?? 3);
    if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 30) {
      return {
        statusCode: 400,
        data: { message: 'countdownSec must be integer 0~30' },
      };
    }

    const total = 5;
    const [rows] = await pool.query(
      `SELECT id, sentence, choice1, choice2, answer AS answerLabel, explanation
       FROM PracticeQuestion
       ORDER BY RAND()
       LIMIT ?`,
      [total],
    );

    if (rows.length < total) {
      return {
        statusCode: 409,
        data: { message: `문제가 ${total}개보다 적습니다.` },
      };
    }

    const sessionId = `p_${crypto.randomBytes(6).toString('base64url')}`;
    const timeLimit = 20;

    const serverQuestions = rows.map((q) => ({
      id: q.id,
      text: q.sentence,
      choice1: q.choice1,
      choice2: q.choice2,
      answerLabel: q.answerLabel,
      explanation: q.explanation ?? null,
    }));

    const now = Date.now();
    const countdownEndAt = countdownSec > 0 ? now + countdownSec * 1000 : null;

    const session = {
      sessionId,
      guestId: user?.playerId || null,
      status: 'playing',
      countdownEndAt,
      round: { current: 1, total },
      timeLimit,
      roundStartedAt: countdownEndAt ?? now,
      questions: serverQuestions,
      answers: [],
      score: 0,
      wrongCount: 0,
      createdAt: new Date().toISOString(),
    };

    await createPracticeSession(session);

    const clientQuestions = serverQuestions.map((q) => ({
      questionId: String(q.id),
      text: q.text,
      options: [q.choice1, q.choice2],
    }));

    const countdown =
      countdownEndAt != null ? { seconds: Math.ceil((countdownEndAt - now) / 1000) } : undefined;

    return {
      statusCode: 200,
      data: {
        sessionId,
        status: 'playing',
        ...(countdown ? { countdown } : {}),
        round: { current: 1, total },
        timeLimit,
        questions: clientQuestions,
      },
    };
  } catch (e) {
    console.error('[POST /practice/start] error:', e);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

async function submitPracticeAnswer({ sessionId, body, user }) {
  try {
    const { round, answer } = body || {};
    const isTimeoutSubmit = answer == null;

    let clientRound = null;
    if (typeof round === 'number') clientRound = round;
    else if (round && typeof round.current === 'number') clientRound = round.current;

    if (!Number.isInteger(clientRound) || clientRound < 1) {
      return {
        statusCode: 400,
        data: { message: 'round must be an integer >= 1 or { current: integer }' },
      };
    }

    if (!isTimeoutSubmit && answer !== 'choice1' && answer !== 'choice2') {
      return {
        statusCode: 400,
        data: { message: 'answer must be "choice1" or "choice2"' },
      };
    }

    const sess = await findSession(sessionId);
    if (!sess) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    if (sess.status === 'ended') {
      return {
        statusCode: 409,
        data: { message: 'Already ended' },
      };
    }

    if (sess.guestId && sess.guestId !== user.playerId) {
      return {
        statusCode: 403,
        data: { message: 'Forbidden' },
      };
    }

    const serverCurrent = Number(sess.round?.current ?? 1);
    const total = Number(sess.round?.total ?? (sess.questions?.length || 0));

    if (serverCurrent !== clientRound) {
      return {
        statusCode: 409,
        data: {
          code: 'ROUND_MISMATCH',
          message: `Client round(${clientRound}) != Server round(${serverCurrent})`,
        },
      };
    }

    const idx = serverCurrent - 1;
    const q = sess.questions?.[idx];
    if (!q) {
      return {
        statusCode: 409,
        data: { message: 'Round index out of range' },
      };
    }

    const remainingTime = calcRemaining(sess);
    if (isTimeoutSubmit || remainingTime === 0) {
      const { isLast } = recordTimeout(sess);

      if (isLast) {
        sess.status = 'ended';
        await savePracticeSession(sess);
        return {
          statusCode: 200,
          data: {
            status: 'ended',
            round: { current: serverCurrent, total },
            result: 'timeout',
            next: { hasNext: false },
            isCorrectByRound: buildIsCorrectByRound(sess),
          },
        };
      }

      sess.round.current = serverCurrent + 1;
      sess.roundStartedAt = Date.now();
      sess.countdownEndAt = null;

      const nq = sess.questions[sess.round.current - 1];
      await savePracticeSession(sess);

      const newRemaining = calcRemaining(sess);

      return {
        statusCode: 200,
        data: {
          round: { current: sess.round.current, total },
          timeLimit: sess.timeLimit ?? null,
          remainingTime: newRemaining,
          next: {
            hasNext: true,
            result: 'timeout',
            question: {
              questionId: String(nq.id),
              text: nq.text,
              options: [nq.choice1, nq.choice2],
            },
          },
          isCorrectByRound: buildIsCorrectByRound(sess),
        },
      };
    }

    const already =
      Array.isArray(sess.answers) && sess.answers.some((a) => a.round === serverCurrent);
    if (already) {
      return {
        statusCode: 409,
        data: { message: 'Already answered this round' },
      };
    }

    const isCorrect = answer === q.answerLabel;

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
      sess.status = 'ended';
      await savePracticeSession(sess);
      return {
        statusCode: 200,
        data: {
          status: 'ended',
          round: { current: serverCurrent, total },
          result: isCorrect ? 'correct' : 'wrong',
          next: { hasNext: false },
        },
      };
    }

    sess.round.current = serverCurrent + 1;
    sess.roundStartedAt = Date.now();
    sess.countdownEndAt = null;

    const nq = sess.questions[sess.round.current - 1];
    await savePracticeSession(sess);

    return {
      statusCode: 200,
      data: {
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
        isCorrectByRound: buildIsCorrectByRound(sess),
      },
    };
  } catch (e) {
    console.error('[POST /practice/:sessionId/answer] error:', e);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

async function getPracticeResult({ sessionId, user }) {
  try {
    const sess = await findSession(sessionId);
    if (!sess) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    if (sess.guestId && sess.guestId !== user.playerId) {
      return {
        statusCode: 403,
        data: { message: 'Forbidden' },
      };
    }

    if (sess.status !== 'ended') {
      return {
        statusCode: 409,
        data: { message: 'Not ended yet' },
      };
    }

    const totalRounds = sess.round?.total ?? (sess.questions?.length || 0);
    const answers = Array.isArray(sess.answers) ? sess.answers : [];

    const rows = answers.map((a) => {
      const q = (sess.questions || []).find((x) => x.id === a.questionId);
      const correctText = q ? q[q.answerLabel] : null;
      const pickedText = q ? q[a.answer] : null;

      const isTimeout = a.reason === 'timeout';
      const result = isTimeout ? 'timeout' : a.correct ? 'correct' : 'wrong';
      const answerForResponse = isTimeout ? null : pickedText;

      return {
        round: a.round,
        question: q ? q.text : '',
        answer: answerForResponse,
        result,
        correctAnswer: correctText,
        explanation: q?.explanation ?? null,
      };
    });

    return {
      statusCode: 200,
      data: {
        status: 'ended',
        score: sess.score ?? 0,
        wrongCount: sess.wrongCount ?? 0,
        totalRounds,
        questions: rows,
      },
    };
  } catch (e) {
    console.error('[GET /practice/:sessionId/result] error:', e);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

async function getPracticeSession({ sessionId, user }) {
  try {
    const sess = await findSession(sessionId);
    if (!sess) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    if (sess.guestId && sess.guestId !== user.playerId) {
      return {
        statusCode: 403,
        data: { message: 'Forbidden' },
      };
    }

    const total = Number(sess.round?.total ?? (sess.questions?.length || 0));
    let current = Number(sess.round?.current ?? 1);

    let countdown = calcCountdown(sess);
    let remainingTime = calcRemaining(sess);

    if (!countdown && sess.status === 'playing' && remainingTime === 0) {
      const { isLast } = recordTimeout(sess);

      if (isLast) {
        sess.status = 'ended';
        await savePracticeSession(sess);
        return {
          statusCode: 200,
          data: {
            sessionId: sess.sessionId,
            status: 'ended',
            round: { current, total },
            score: sess.score ?? 0,
            wrongCount: sess.wrongCount ?? 0,
            totalRounds: total,
            isCorrectByRound: buildIsCorrectByRound(sess),
          },
        };
      }

      sess.round.current = current + 1;
      sess.roundStartedAt = Date.now();
      sess.countdownEndAt = null;
      await savePracticeSession(sess);

      current = sess.round.current;
      countdown = calcCountdown(sess);
      remainingTime = calcRemaining(sess);
    }

    if (sess.status === 'ended') {
      return {
        statusCode: 200,
        data: {
          sessionId: sess.sessionId,
          status: 'ended',
          round: { current: Math.min(current, total || 1), total },
          score: sess.score ?? 0,
          wrongCount: sess.wrongCount ?? 0,
          totalRounds: total,
          wrong: sess.wrongCount ?? 0,
          isCorrectByRound: buildIsCorrectByRound(sess),
        },
      };
    }

    const idx = Math.max(0, current - 1);
    const q = (sess.questions || [])[idx];

    if (countdown) {
      return {
        statusCode: 200,
        data: {
          sessionId: sess.sessionId,
          status: 'playing',
          countdown,
          round: { current, total },
          timeLimit: sess.timeLimit ?? null,
          remainingTime,
          answeredCount: Array.isArray(sess.answers) ? sess.answers.length : 0,
          score: sess.score ?? 0,
          wrongCount: sess.wrongCount ?? 0,
          isCorrectByRound: buildIsCorrectByRound(sess),
        },
      };
    }

    const currentQuestion = q
      ? { questionId: String(q.id), text: q.text, options: [q.choice1, q.choice2] }
      : null;

    return {
      statusCode: 200,
      data: {
        sessionId: sess.sessionId,
        status: 'playing',
        round: { current, total },
        timeLimit: sess.timeLimit ?? null,
        remainingTime,
        answeredCount: Array.isArray(sess.answers) ? sess.answers.length : 0,
        question: currentQuestion,
        score: sess.score ?? 0,
        wrongCount: sess.wrongCount ?? 0,
        isCorrectByRound: buildIsCorrectByRound(sess),
      },
    };
  } catch (e) {
    console.error('[GET /practice/:sessionId] error:', e);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

async function deletePracticeSession({ sessionId, user }) {
  try {
    const normalizedSessionId = decodeURIComponent(String(sessionId ?? '')).trim();

    const sess = await findSession(normalizedSessionId);
    if (!sess) {
      return {
        statusCode: 404,
        data: { message: 'Session not found or expired' },
      };
    }

    if (sess.guestId && sess.guestId !== user.playerId) {
      return {
        statusCode: 403,
        data: { message: 'Forbidden' },
      };
    }

    const ok = await removeSession(normalizedSessionId);

    return {
      statusCode: 200,
      data: {
        deleted: !!ok,
        sessionId: normalizedSessionId,
        message: 'Practice session deleted',
      },
    };
  } catch (e) {
    console.error('[DELETE /practice/:sessionId] error:', e);
    return {
      statusCode: 500,
      data: { message: 'Internal Server Error' },
    };
  }
}

module.exports = {
  startPractice,
  submitPracticeAnswer,
  getPracticeResult,
  getPracticeSession,
  deletePracticeSession,
};