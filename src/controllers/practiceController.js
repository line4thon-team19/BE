const practiceService = require('../services/practiceService');

async function startPractice(req, res) {
  const result = await practiceService.startPractice({
    body: req.body,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function submitAnswer(req, res) {
  const result = await practiceService.submitPracticeAnswer({
    sessionId: req.params.sessionId,
    body: req.body,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function getResult(req, res) {
  const result = await practiceService.getPracticeResult({
    sessionId: req.params.sessionId,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function getSession(req, res) {
  const result = await practiceService.getPracticeSession({
    sessionId: req.params.sessionId,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function deleteSession(req, res) {
  const result = await practiceService.deletePracticeSession({
    sessionId: req.params.sessionId,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

module.exports = {
  startPractice,
  submitPracticeAnswer: submitAnswer,
  getPracticeResult: getResult,
  getPracticeSession: getSession,
  deletePracticeSession: deleteSession,
};