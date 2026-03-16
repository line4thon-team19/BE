const express = require('express');
const authenticateGuest = require('../middlewares/auth');
const battleController = require('../controllers/battleController');

const router = express.Router();

router.post('/rooms', authenticateGuest, battleController.createRoom);

router.post(
  '/:sessionId/start',
  authenticateGuest,
  express.json(),
  battleController.startCountdown
);

router.post(
  '/entry',
  authenticateGuest,
  express.json(),
  battleController.entryRoom
);

router.post(
  '/:sessionId/answer',
  authenticateGuest,
  express.json(),
  battleController.submitAnswer
);

router.get(
  '/:sessionId/result',
  authenticateGuest,
  battleController.getBattleResult
);

router.get(
  '/:sessionId',
  authenticateGuest,
  battleController.getBattleRoom
);

router.delete(
  '/:sessionId/delete',
  authenticateGuest,
  battleController.deleteBattleRoom
);

module.exports = router;