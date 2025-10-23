const { Router } = require('express');
const health = require('./health.route');
const battle = require('./battle.route');
const guest = require('./guest.route');

const router = Router();

router.use('/health', health);
router.use('/battle', battle);
router.use('/guest', guest);

module.exports = router;
