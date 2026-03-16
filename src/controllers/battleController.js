const battleService = require('../services/battleService');

async function createRoom(req, res) {
  const result = await battleService.createRoom({
    body: req.body,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function startCountdown(req, res) {
  const result = await battleService.startCountdown({
    sessionId: req.params.sessionId,
    body: req.body,
    user: req.user,
    io: req.app.locals.io,
  });

  return res.status(result.statusCode).json(result.data);
}

async function entryRoom(req, res) {
  const result = await battleService.entryRoom({
    body: req.body,
    user: req.user,
    io: req.app.locals.io,
  });

  return res.status(result.statusCode).json(result.data);
}

async function submitAnswer(req, res) {
  const result = await battleService.submitAnswer({
    sessionId: req.params.sessionId,
    body: req.body,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function getBattleResult(req, res) {
  const result = await battleService.getBattleResult({
    sessionId: req.params.sessionId,
    user: req.user,
  });

  return res.status(result.statusCode).json(result.data);
}

async function getBattleRoom(req, res) {
  const result = await battleService.getBattleRoom({
    sessionId: req.params.sessionId,
  });

  return res.status(result.statusCode).json(result.data);
}

async function deleteBattleRoom(req, res) {
  const result = await battleService.deleteBattleRoom({
    sessionId: req.params.sessionId,
  });

  return res.status(result.statusCode).json(result.data);
}

module.exports = {
  createRoom,
  startCountdown,
  entryRoom,
  submitAnswer,
  getBattleResult,
  getBattleRoom,
  deleteBattleRoom,
};