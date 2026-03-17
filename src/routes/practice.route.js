const express = require('express');
const authenticateGuest = require('../middlewares/auth');
const practiceController = require('../controllers/practiceController');

const router = express.Router();

router.post('/start', authenticateGuest, express.json(), practiceController.startPractice);

router.post(
  '/:sessionId/answer',
  authenticateGuest,
  express.json(),
  practiceController.submitPracticeAnswer
);

router.get('/:sessionId/result', authenticateGuest, practiceController.getPracticeResult);

router.get('/:sessionId', authenticateGuest, practiceController.getPracticeSession);

router.delete('/:sessionId', authenticateGuest, practiceController.deletePracticeSession);

module.exports = router;