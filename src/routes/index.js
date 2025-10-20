const { Router } = require('express');
const health = require('./health.route');

const router = Router();

router.use('/health', health);

module.exports = router;
