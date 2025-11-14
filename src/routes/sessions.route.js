const express = require('express');
const authenticateGuest = require('../middlewares/auth');
const { forceEndSession } = require('../repositories/sessionForce');

const router = express.Router();

router.post('/:sessionId/force-end', authenticateGuest, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await forceEndSession(sessionId, {
      requestUserId: req.user?.playerId || null,
      bypassOwnerCheck: false,
    });

    return res.json({
      status: 'ended',
      alreadyEnded: !!result.alreadyEnded,
    });
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ message: e.message || 'Internal Server Error' });
  }
});

module.exports = router;
