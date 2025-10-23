const { Router } = require('express');
const health = require('./health.route');
const battle = require('./battle.route');

const router = Router();

router.use('/health', health);
router.use('/battle', battle);

module.exports = router;
