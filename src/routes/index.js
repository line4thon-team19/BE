const { Router } = require('express');
const health = require('./health.route');
const battle = require('./battle.route');
const guest = require('./guest.route');
const practice = require('./practice.route');
const sessions = require('./sessions.route');

const router = Router();

router.use('/health', health);
router.use('/battle', battle);
router.use('/guest', guest);
router.use('/practice', practice);
router.use('/sessions', sessions);

module.exports = router;
